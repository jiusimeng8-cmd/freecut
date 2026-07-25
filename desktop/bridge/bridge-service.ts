import { createHash } from 'node:crypto'
import type { DesktopBridgeCall, DesktopBridgeToolDescriptor } from '../desktop-types'
import type { DesktopTask, TaskRepository } from '../services/task-repository'

interface BridgeRenderer {
  clientId: string
  projectId: string | null
  tools: DesktopBridgeToolDescriptor[]
  registeredAt: number
  lastSeenAt: number
}

interface PendingBridgeCall extends DesktopBridgeCall {
  fingerprint: string
  taskId: string
  phase: 'queued' | 'running'
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  promise: Promise<unknown>
  timeout: ReturnType<typeof setTimeout>
}

interface CompletedBridgeCall {
  fingerprint: string
  result: unknown
  expiresAt: number
}

interface PreparingBridgeCall {
  fingerprint: string
  projectId: string | null
  promise: Promise<unknown>
  cancel: () => void
}

interface BridgeTaskData extends Record<string, unknown> {
  requestId: string
  fingerprint: string
  name: string
  projectId: string | null
}

export interface BridgeExecutionConfirmation {
  requestId: string
  name: string
  projectId: string | null
  destructive: boolean
  handoff: boolean
}

export interface BridgeCancelResult {
  requestId: string
  cancelled: boolean
  state: 'not-found' | 'queued' | 'running'
}

export interface BridgeServiceOptions {
  confirmExecution?: (input: BridgeExecutionConfirmation) => Promise<boolean>
  log?: (message: string) => void
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly finalStatus: 'failed' | 'cancelled' | 'uncertain' = 'failed',
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

const RENDERER_TTL_MS = 45_000
const COMPLETED_TTL_MS = 5 * 60_000
const MAX_PENDING_CALLS = 32
const MAX_PROJECT_PENDING_CALLS = 8

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (
      !nested ||
      typeof nested !== 'object' ||
      Array.isArray(nested) ||
      (Object.getPrototypeOf(nested) !== Object.prototype && Object.getPrototypeOf(nested) !== null)
    ) {
      return nested
    }
    return Object.fromEntries(
      Object.keys(nested as Record<string, unknown>)
        .sort()
        .map((key) => [key, (nested as Record<string, unknown>)[key]]),
    )
  })
}

function bridgeFingerprint(input: {
  name: string
  args: unknown
  projectId: string | null
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

export class BridgeService {
  private renderer: BridgeRenderer | null = null
  private readonly pending = new Map<string, PendingBridgeCall>()
  private readonly preparing = new Map<string, PreparingBridgeCall>()
  private readonly completed = new Map<string, CompletedBridgeCall>()
  private readonly callListeners = new Set<(call: DesktopBridgeCall) => void>()
  private readonly cancelListeners = new Set<(requestId: string) => void>()

  constructor(
    private readonly tasks: TaskRepository,
    private readonly options: BridgeServiceOptions = {},
  ) {}

  registerRenderer(input: {
    clientId: string
    projectId: string | null
    tools: DesktopBridgeToolDescriptor[]
  }): void {
    if (!input.clientId || input.tools.length === 0) {
      throw new BridgeError('BRIDGE_BAD_REQUEST', 'clientId and tools are required.')
    }
    const active = this.activeRenderer()
    if (active && active.clientId !== input.clientId) {
      this.disconnectPending(
        new BridgeError('BRIDGE_OFFLINE', 'FreeCut editor reconnected before the call completed.'),
      )
    }
    const now = Date.now()
    this.renderer = {
      clientId: input.clientId,
      projectId: input.projectId,
      tools: input.tools,
      registeredAt: active?.registeredAt ?? now,
      lastSeenAt: now,
    }
  }

  unregisterRenderer(clientId: string): void {
    if (this.renderer?.clientId !== clientId) return
    this.renderer = null
    this.disconnectPending(new BridgeError('BRIDGE_OFFLINE', 'FreeCut editor disconnected.'))
  }

  touchRenderer(clientId: string): void {
    const renderer = this.activeRenderer()
    if (!renderer || renderer.clientId !== clientId) {
      throw new BridgeError('BRIDGE_CONFLICT', 'This is not the active FreeCut editor.')
    }
    renderer.lastSeenAt = Date.now()
  }

  onCall(listener: (call: DesktopBridgeCall) => void): () => void {
    this.callListeners.add(listener)
    return () => this.callListeners.delete(listener)
  }

  onCancel(listener: (requestId: string) => void): () => void {
    this.cancelListeners.add(listener)
    return () => this.cancelListeners.delete(listener)
  }

  status() {
    const renderer = this.activeRenderer()
    const queuedCalls = [...this.pending.values()].filter((call) => call.phase === 'queued').length
    const runningCalls = this.pending.size - queuedCalls
    return {
      connected: renderer !== null,
      renderer: renderer
        ? {
            clientId: renderer.clientId,
            projectId: renderer.projectId,
            toolCount: renderer.tools.length,
            registeredAt: renderer.registeredAt,
            lastSeenAt: renderer.lastSeenAt,
          }
        : null,
      pendingCalls: this.pending.size,
      queuedCalls,
      runningCalls,
      completedCacheSize: this.completed.size,
    }
  }

  tools(): DesktopBridgeToolDescriptor[] {
    return this.activeRenderer()?.tools ?? []
  }

  confirm(input: BridgeExecutionConfirmation): Promise<boolean> {
    return this.options.confirmExecution?.(input) ?? Promise.resolve(false)
  }

  call(input: {
    requestId: string
    name: string
    args: unknown
    projectId?: string
    allowDestructive?: boolean
    confirmedByLocalAgent?: boolean
    timeoutMs?: number
  }): Promise<unknown> {
    this.cleanupCompleted()
    const requestId = input.requestId.trim()
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(requestId)) {
      throw new BridgeError('BRIDGE_BAD_REQUEST', 'Invalid Bridge requestId.')
    }
    const name = input.name.trim()
    if (!name) throw new BridgeError('BRIDGE_BAD_REQUEST', 'Tool name is required.')
    const args = input.args ?? {}
    const projectId = input.projectId?.trim() || undefined
    const fingerprint = bridgeFingerprint({
      name,
      args,
      projectId: projectId ?? null,
    })

    const completed = this.completed.get(requestId)
    if (completed) {
      this.assertFingerprint(requestId, fingerprint, completed.fingerprint)
      return Promise.resolve(completed.result)
    }
    const pending = this.pending.get(requestId)
    if (pending) {
      this.assertFingerprint(requestId, fingerprint, pending.fingerprint)
      return pending.promise
    }
    const preparing = this.preparing.get(requestId)
    if (preparing) {
      this.assertFingerprint(requestId, fingerprint, preparing.fingerprint)
      return preparing.promise
    }
    this.assertCapacity(projectId ?? null)

    const timeoutMs = Math.min(15 * 60_000, Math.max(1_000, input.timeoutMs ?? 5 * 60_000))
    const controller = new AbortController()
    const promise = this.prepareAndDispatch({
      requestId,
      name,
      args,
      projectId,
      allowDestructive: input.allowDestructive === true,
      confirmedByLocalAgent: input.confirmedByLocalAgent === true,
      deadlineAt: Date.now() + timeoutMs,
      signal: controller.signal,
      fingerprint,
    }).finally(() => {
      if (this.preparing.get(requestId)?.promise === promise) {
        this.preparing.delete(requestId)
      }
    })
    this.preparing.set(requestId, {
      fingerprint,
      projectId: projectId ?? null,
      promise,
      cancel: () => controller.abort(),
    })
    this.trace(`prepare requestId=${requestId} name=${name} projectId=${projectId ?? ''}`)
    return promise
  }

  async start(clientId: string, requestId: string): Promise<boolean> {
    this.touchRenderer(clientId)
    const call = this.pending.get(requestId)
    if (!call) return false
    if (call.phase === 'running') return true

    call.phase = 'running'
    try {
      await this.tasks.update(call.taskId, { status: 'running' })
      this.trace(`start requestId=${requestId} clientId=${clientId}`)
      return true
    } catch (error) {
      await this.finishUncertain(
        call,
        new BridgeError(
          'BRIDGE_PERSISTENCE_FAILED',
          error instanceof Error ? error.message : String(error),
        ),
      )
      return false
    }
  }

  async complete(clientId: string, requestId: string, result: unknown): Promise<void> {
    this.touchRenderer(clientId)
    const call = this.pending.get(requestId)
    if (call) {
      try {
        await this.tasks.update(call.taskId, {
          status: 'completed',
          progress: 1,
          error: undefined,
          data: {
            requestId: call.requestId,
            fingerprint: call.fingerprint,
            name: call.name,
            projectId: call.projectId ?? null,
          } satisfies BridgeTaskData,
        })
      } catch (error) {
        const persistenceError = new BridgeError(
          'BRIDGE_PERSISTENCE_FAILED',
          error instanceof Error ? error.message : String(error),
        )
        if (this.pending.get(requestId) === call) {
          clearTimeout(call.timeout)
          this.pending.delete(requestId)
          call.reject(persistenceError)
        }
        throw persistenceError
      }
      if (this.pending.get(requestId) !== call) return
      clearTimeout(call.timeout)
      this.pending.delete(requestId)
      this.cacheCompleted(call.requestId, call.fingerprint, result)
      call.resolve(result)
      this.trace(`complete requestId=${requestId} clientId=${clientId}`)
      return
    }

    const previous = await this.tasks.findBridgeRequest(requestId)
    if (!previous) {
      throw new BridgeError('BRIDGE_NOT_FOUND', `Unknown bridge request: ${requestId}`)
    }
    if (previous.status === 'completed') return
    if (previous.status !== 'uncertain' && previous.status !== 'running') {
      throw new BridgeError('BRIDGE_NOT_FOUND', `Bridge request is not running: ${requestId}`)
    }
    const data = this.bridgeTaskData(previous)
    await this.tasks.update(previous.id, {
      status: 'completed',
      progress: 1,
      error: undefined,
      data,
    })
    this.cacheCompleted(requestId, data.fingerprint, result)
  }

  async cancel(requestId: string): Promise<BridgeCancelResult> {
    const call = this.pending.get(requestId)
    if (call) {
      if (call.phase === 'running') {
        return { requestId, cancelled: false, state: 'running' }
      }

      await this.finishQueued(
        call,
        'cancelled',
        new BridgeError(
          'BRIDGE_CANCELLED',
          'Bridge call was cancelled before execution.',
          'cancelled',
        ),
      )
      return { requestId, cancelled: true, state: 'queued' }
    }

    const preparing = this.preparing.get(requestId)
    if (!preparing) return { requestId, cancelled: false, state: 'not-found' }
    preparing.cancel()
    this.trace(`cancel preparing requestId=${requestId}`)
    return { requestId, cancelled: true, state: 'queued' }
  }

  dispose(): void {
    this.renderer = null
    for (const call of this.preparing.values()) call.cancel()
    this.preparing.clear()
    for (const call of [...this.pending.values()]) {
      clearTimeout(call.timeout)
      this.pending.delete(call.requestId)
      if (call.phase === 'queued') this.notifyCancel(call.requestId)
      call.reject(new BridgeError('BRIDGE_SHUTDOWN', 'FreeCut is shutting down.'))
    }
    this.callListeners.clear()
    this.cancelListeners.clear()
  }

  private async prepareAndDispatch(input: {
      requestId: string
      name: string
      args: unknown
      projectId?: string
      allowDestructive: boolean
      confirmedByLocalAgent: boolean
      deadlineAt: number
      signal: AbortSignal
      fingerprint: string
  }): Promise<unknown> {
    const previous = await this.tasks.findBridgeRequest(input.requestId)
    if (previous) return this.reusePersistent(previous, input.fingerprint)

    let { renderer, tool } = this.resolveRendererTool(input)
    const destructive = tool.annotations?.destructiveHint === true
    const handoff = tool.annotations?.handoffRequired === true
    const write = tool.annotations?.readOnlyHint !== true
    if (destructive) {
      if (!input.allowDestructive) {
        throw new BridgeError(
          'CONFIRMATION_REQUIRED',
          `Tool ${input.name} requires a native FreeCut confirmation.`,
        )
      }
    }
    if ((write || handoff) && !input.confirmedByLocalAgent) {
      const confirmation = {
        requestId: input.requestId,
        name: input.name,
        projectId: renderer.projectId,
        destructive,
        handoff,
      }
      this.trace(`confirm requestId=${input.requestId} name=${input.name}`)
      const confirmed = await this.confirmBeforeDeadline(
        confirmation,
        input.deadlineAt,
        input.signal,
      )
      if (!confirmed) {
        throw new BridgeError(
          'CONFIRMATION_DENIED',
          `The user did not approve tool ${input.name}.`,
          'cancelled',
        )
      }
      this.trace(`confirmed requestId=${input.requestId} name=${input.name}`)
      ;({ renderer, tool } = this.resolveRendererTool(input))
    }

    const task = await this.tasks.create({
      kind: 'bridge',
      projectId: renderer.projectId ?? undefined,
      data: {
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        name: input.name,
        projectId: input.projectId ?? null,
      } satisfies BridgeTaskData,
    })

    let resolveCall!: (result: unknown) => void
    let rejectCall!: (error: Error) => void
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveCall = resolve
      rejectCall = reject
    })
    const timeoutMs = input.deadlineAt - Date.now()
    if (timeoutMs <= 0) {
      throw new BridgeError(
        'BRIDGE_TIMEOUT',
        `FreeCut tool call timed out before dispatch: ${input.requestId}`,
      )
    }
    const call: PendingBridgeCall = {
      requestId: input.requestId,
      name: input.name,
      args: input.args,
      projectId: input.projectId,
      allowDestructive: destructive,
      allowHandoff: handoff,
      createdAt: Date.now(),
      fingerprint: input.fingerprint,
      taskId: task.id,
      phase: 'queued',
      resolve: resolveCall,
      reject: rejectCall,
      promise,
      timeout: setTimeout(() => void this.timeoutCall(call), timeoutMs),
    }
    this.pending.set(call.requestId, call)
    this.trace(`dispatch requestId=${call.requestId} name=${call.name}`)
    const rendererCall: DesktopBridgeCall = {
      requestId: call.requestId,
      name: call.name,
      args: call.args,
      projectId: call.projectId,
      allowDestructive: call.allowDestructive,
      allowHandoff: call.allowHandoff,
      createdAt: call.createdAt,
    }
    for (const listener of this.callListeners) listener(rendererCall)
    this.preparing.delete(call.requestId)
    return promise
  }

  private resolveRendererTool(input: { name: string; projectId?: string }): {
    renderer: BridgeRenderer
    tool: DesktopBridgeToolDescriptor
  } {
    const renderer = this.activeRenderer()
    if (!renderer) {
      throw new BridgeError('BRIDGE_OFFLINE', 'No loaded FreeCut editor is connected.')
    }
    const tool = renderer.tools.find((candidate) => candidate.name === input.name)
    if (!tool) {
      throw new BridgeError('TOOL_NOT_FOUND', `Unknown FreeCut tool: ${input.name}`)
    }
    if (input.projectId && input.projectId !== renderer.projectId) {
      throw new BridgeError(
        'PROJECT_MISMATCH',
        `The connected editor has project ${renderer.projectId}, not ${input.projectId}.`,
      )
    }
    if (tool.annotations?.requiresProject) {
      if (!renderer.projectId) {
        throw new BridgeError('PROJECT_REQUIRED', `Tool ${input.name} requires an open project.`)
      }
      if (!input.projectId) {
        throw new BridgeError(
          'PROJECT_ID_REQUIRED',
          `Tool ${input.name} requires projectId=${renderer.projectId}.`,
        )
      }
    }
    return { renderer, tool }
  }

  private async reusePersistent(task: DesktopTask, fingerprint: string): Promise<unknown> {
    const data = this.bridgeTaskData(task)
    this.assertFingerprint(data.requestId, fingerprint, data.fingerprint)
    if (task.status === 'completed') {
      throw new BridgeError(
        'BRIDGE_RESULT_EXPIRED',
        `Bridge request ${data.requestId} completed before this app session; its sensitive result was not persisted.`,
      )
    }
    if (task.status === 'uncertain' || task.status === 'queued' || task.status === 'running') {
      throw new BridgeError(
        'BRIDGE_INDETERMINATE',
        `Bridge request ${data.requestId} may already have changed the project; reconcile it before using a new requestId.`,
      )
    }
    if (task.status === 'cancelled') {
      throw new BridgeError('BRIDGE_CANCELLED', `Bridge request ${data.requestId} was cancelled.`)
    }
    throw new BridgeError(
      'BRIDGE_PREVIOUSLY_FAILED',
      task.error || `Bridge request ${data.requestId} previously failed.`,
    )
  }

  private bridgeTaskData(task: DesktopTask): BridgeTaskData {
    const data = task.data as Partial<BridgeTaskData> | undefined
    if (
      !data ||
      typeof data.requestId !== 'string' ||
      typeof data.fingerprint !== 'string' ||
      typeof data.name !== 'string'
    ) {
      throw new BridgeError('BRIDGE_PERSISTENCE_FAILED', `Invalid Bridge task record: ${task.id}`)
    }
    return data as BridgeTaskData
  }

  private async timeoutCall(call: PendingBridgeCall): Promise<void> {
    if (this.pending.get(call.requestId) !== call) return
    const error =
      call.phase === 'running'
        ? new BridgeError(
            'BRIDGE_EXECUTION_UNCERTAIN',
            `FreeCut tool call timed out after execution started: ${call.requestId}`,
            'uncertain',
          )
        : new BridgeError(
            'BRIDGE_TIMEOUT',
            `FreeCut tool call timed out before execution: ${call.requestId}`,
          )
    this.trace(`timeout requestId=${call.requestId} phase=${call.phase}`)
    if (call.phase === 'queued') {
      await this.finishQueued(call, 'failed', error)
      return
    }
    await this.finishUncertain(call, error)
  }

  private async finishQueued(
    call: PendingBridgeCall,
    status: 'failed' | 'cancelled',
    error: BridgeError,
  ): Promise<void> {
    clearTimeout(call.timeout)
    this.pending.delete(call.requestId)
    this.notifyCancel(call.requestId)
    await this.tasks.update(call.taskId, {
      status,
      error: error.message,
    })
    call.reject(error)
    this.trace(`finish requestId=${call.requestId} status=${status} code=${error.code}`)
  }

  private async finishUncertain(call: PendingBridgeCall, error: BridgeError): Promise<void> {
    clearTimeout(call.timeout)
    this.pending.delete(call.requestId)
    this.notifyCancel(call.requestId)
    await this.tasks.update(call.taskId, {
      status: 'uncertain',
      error: error.message,
    })
    const uncertain =
      error.finalStatus === 'uncertain'
        ? error
        : new BridgeError(error.code, error.message, 'uncertain')
    call.reject(uncertain)
    this.trace(`finish requestId=${call.requestId} status=uncertain code=${uncertain.code}`)
  }

  private disconnectPending(error: BridgeError): void {
    for (const call of [...this.pending.values()]) {
      if (call.phase === 'queued') {
        void this.finishQueued(call, 'failed', error)
      } else {
        void this.finishUncertain(call, error)
      }
    }
  }

  private activeRenderer(): BridgeRenderer | null {
    if (this.renderer && Date.now() - this.renderer.lastSeenAt > RENDERER_TTL_MS) {
      const clientId = this.renderer.clientId
      this.renderer = null
      this.disconnectPending(
        new BridgeError('BRIDGE_OFFLINE', `FreeCut renderer ${clientId} timed out.`),
      )
    }
    return this.renderer
  }

  private notifyCancel(requestId: string): void {
    for (const listener of this.cancelListeners) listener(requestId)
  }

  private cacheCompleted(requestId: string, fingerprint: string, result: unknown): void {
    this.completed.set(requestId, {
      fingerprint,
      result,
      expiresAt: Date.now() + COMPLETED_TTL_MS,
    })
  }

  private assertFingerprint(requestId: string, current: string, previous: string): void {
    if (current !== previous) {
      throw new BridgeError(
        'BRIDGE_CONFLICT',
        `requestId ${requestId} was already used for another call.`,
      )
    }
  }

  private cleanupCompleted(): void {
    const now = Date.now()
    for (const [requestId, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(requestId)
    }
  }

  private assertCapacity(projectId: string | null): void {
    if (this.pending.size + this.preparing.size >= MAX_PENDING_CALLS) {
      throw new BridgeError('BRIDGE_BUSY', 'FreeCut Bridge has reached its global queue limit.')
    }
    if (!projectId) return
    const projectCalls =
      [...this.pending.values()].filter((call) => call.projectId === projectId).length +
      [...this.preparing.values()].filter((call) => call.projectId === projectId).length
    if (projectCalls >= MAX_PROJECT_PENDING_CALLS) {
      throw new BridgeError(
        'BRIDGE_BUSY',
        `FreeCut Bridge has reached the queue limit for project ${projectId}.`,
      )
    }
  }

  private confirmBeforeDeadline(
    input: BridgeExecutionConfirmation,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(
          new BridgeError(
            'BRIDGE_CANCELLED',
            `Bridge call was cancelled before confirmation: ${input.requestId}`,
            'cancelled',
          ),
        )
        return
      }
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = () =>
        finish(() =>
          reject(
            new BridgeError(
              'BRIDGE_CANCELLED',
              `Bridge call was cancelled before confirmation: ${input.requestId}`,
              'cancelled',
            ),
          ),
        )
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        reject(
          new BridgeError(
            'CONFIRMATION_TIMEOUT',
            `Bridge confirmation timed out: ${input.requestId}`,
          ),
        )
        return
      }
      const timeout = setTimeout(
        () =>
          finish(() =>
            reject(
              new BridgeError(
                'CONFIRMATION_TIMEOUT',
                `Bridge confirmation timed out: ${input.requestId}`,
              ),
            ),
          ),
        remainingMs,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      void this.confirm(input).then(
        (confirmed) => finish(() => resolve(confirmed)),
        (error) =>
          finish(() =>
            reject(
              error instanceof BridgeError
                ? error
                : new BridgeError(
                    'BRIDGE_CONFIRMATION_FAILED',
                    error instanceof Error ? error.message : String(error),
                  ),
            ),
          ),
      )
    })
  }

  private trace(message: string): void {
    this.options.log?.(message)
  }
}
