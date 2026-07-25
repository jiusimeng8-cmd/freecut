import { randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Plugin } from 'vite-plus'

const API_PREFIX = '/__freecut_dev_workspace'
const BRIDGE_HEADER = 'X-FreeCut-Dev-Workspace'
const ERROR_STATUS_BY_CODE: Record<string, number> = {
  ENOENT: 404,
  EACCES: 403,
  EPERM: 403,
  ENOTEMPTY: 409,
  EEXIST: 409,
  BRIDGE_BAD_REQUEST: 400,
  BRIDGE_CONFLICT: 409,
  BRIDGE_OFFLINE: 503,
  BRIDGE_TIMEOUT: 504,
}

interface RequestContext {
  root: string
  request: IncomingMessage
  response: ServerResponse
  url: URL
  bridge: DevAiBridge
}

interface LocalMediaFileDescriptor {
  name: string
  path: string
}

interface BridgeToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  _meta?: {
    'freecut/category'?: {
      id: string
      title: string
      group: string
    }
  }
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    requiresProject?: boolean
    handoffRequired?: boolean
  }
}

interface BridgeClient {
  clientId: string
  projectId: string | null
  tools: BridgeToolDescriptor[]
  registeredAt: number
  lastSeenAt: number
}

interface BridgeCallPayload {
  requestId: string
  name: string
  args: unknown
  projectId?: string
  allowDestructive: boolean
  allowHandoff: boolean
  createdAt: number
}

interface PendingBridgeCall extends BridgeCallPayload {
  fingerprint: string
  claimedBy?: string
  promise: Promise<unknown>
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface CompletedBridgeCall {
  fingerprint: string
  result: unknown
  expiresAt: number
}

interface BridgePollWaiter {
  resolve: (call: BridgeCallPayload | null) => void
  timeout: ReturnType<typeof setTimeout>
}

type RouteHandler = (context: RequestContext) => Promise<void>

const BRIDGE_CLIENT_TTL_MS = 45_000
const BRIDGE_POLL_TIMEOUT_MS = 20_000
const BRIDGE_RESULT_TTL_MS = 5 * 60_000

function bridgeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

class DevAiBridge {
  private activeClient: BridgeClient | null = null
  private readonly pendingCalls: PendingBridgeCall[] = []
  private readonly pendingById = new Map<string, PendingBridgeCall>()
  private readonly completedById = new Map<string, CompletedBridgeCall>()
  private readonly pollWaiters = new Map<string, BridgePollWaiter>()

  register(input: {
    clientId: string
    projectId: string | null
    tools: BridgeToolDescriptor[]
  }): BridgeClient {
    if (!input.clientId || input.tools.length === 0) {
      throw bridgeError('BRIDGE_BAD_REQUEST', 'clientId and tools are required.')
    }
    const now = Date.now()
    const active = this.getActiveClient()
    if (active && active.clientId !== input.clientId) {
      throw bridgeError('BRIDGE_CONFLICT', 'Another FreeCut editor is already registered.')
    }
    const registeredAt = active?.registeredAt ?? now
    this.activeClient = {
      clientId: input.clientId,
      projectId: input.projectId,
      tools: input.tools,
      registeredAt,
      lastSeenAt: now,
    }
    this.dispatchPending()
    return this.activeClient
  }

  unregister(clientId: string): void {
    if (this.activeClient?.clientId !== clientId) return
    this.activeClient = null
    const waiter = this.pollWaiters.get(clientId)
    if (waiter) {
      clearTimeout(waiter.timeout)
      this.pollWaiters.delete(clientId)
      waiter.resolve(null)
    }
    for (const call of this.pendingCalls) {
      if (call.claimedBy === clientId) call.claimedBy = undefined
    }
  }

  status() {
    const active = this.getActiveClient()
    return {
      connected: !!active,
      client: active
        ? {
            clientId: active.clientId,
            projectId: active.projectId,
            toolCount: active.tools.length,
            registeredAt: active.registeredAt,
            lastSeenAt: active.lastSeenAt,
          }
        : null,
      pendingCalls: this.pendingCalls.length,
      completedCacheSize: this.completedById.size,
    }
  }

  tools(): BridgeToolDescriptor[] {
    return this.getActiveClient()?.tools ?? []
  }

  enqueue(input: {
    requestId: string
    name: string
    args: unknown
    projectId?: string
    allowDestructive: boolean
    allowHandoff: boolean
    timeoutMs: number
  }): Promise<unknown> {
    this.cleanupCompleted()
    const active = this.getActiveClient()
    if (!active) {
      throw bridgeError('BRIDGE_OFFLINE', 'No loaded FreeCut editor is connected.')
    }
    if (input.projectId && input.projectId !== active.projectId) {
      throw bridgeError(
        'BRIDGE_CONFLICT',
        `The connected editor has project ${active.projectId}, not ${input.projectId}.`,
      )
    }
    const tool = active.tools.find((candidate) => candidate.name === input.name)
    if (!tool) {
      const error = bridgeError('ENOENT', `Unknown FreeCut tool: ${input.name}`)
      throw error
    }
    if (tool.annotations?.requiresProject) {
      if (!active.projectId) {
        throw bridgeError(
          'BRIDGE_CONFLICT',
          `FreeCut tool ${input.name} requires an open, fully loaded project.`,
        )
      }
      if (!input.projectId) {
        throw bridgeError(
          'BRIDGE_BAD_REQUEST',
          `FreeCut tool ${input.name} requires projectId=${active.projectId}.`,
        )
      }
    }

    const fingerprint = JSON.stringify({
      name: input.name,
      args: input.args,
      projectId: input.projectId ?? null,
      allowDestructive: input.allowDestructive,
      allowHandoff: input.allowHandoff,
    })
    const completed = this.completedById.get(input.requestId)
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw bridgeError(
          'BRIDGE_CONFLICT',
          `requestId ${input.requestId} was already used for a different call.`,
        )
      }
      return Promise.resolve(completed.result)
    }
    const existing = this.pendingById.get(input.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw bridgeError(
          'BRIDGE_CONFLICT',
          `requestId ${input.requestId} is already pending for a different call.`,
        )
      }
      return existing.promise
    }

    let resolveCall!: (result: unknown) => void
    let rejectCall!: (error: Error) => void
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveCall = resolve
      rejectCall = reject
    })
    const call: PendingBridgeCall = {
      requestId: input.requestId,
      name: input.name,
      args: input.args,
      projectId: input.projectId,
      allowDestructive: input.allowDestructive,
      allowHandoff: input.allowHandoff,
      createdAt: Date.now(),
      fingerprint,
      promise,
      resolve: resolveCall,
      reject: rejectCall,
      timeout: setTimeout(() => {
        this.removePending(call)
        call.reject(
          bridgeError('BRIDGE_TIMEOUT', `FreeCut tool call timed out: ${call.requestId}`),
        )
      }, input.timeoutMs),
    }
    this.pendingCalls.push(call)
    this.pendingById.set(call.requestId, call)
    this.dispatchPending()
    return promise
  }

  async poll(clientId: string): Promise<BridgeCallPayload | null> {
    this.touchClient(clientId)
    const immediate = this.claimNext(clientId)
    if (immediate) return immediate

    const previous = this.pollWaiters.get(clientId)
    if (previous) {
      clearTimeout(previous.timeout)
      previous.resolve(null)
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pollWaiters.delete(clientId)
        resolve(null)
      }, BRIDGE_POLL_TIMEOUT_MS)
      this.pollWaiters.set(clientId, { resolve, timeout })
    })
  }

  complete(clientId: string, requestId: string, result: unknown): void {
    this.touchClient(clientId)
    const call = this.pendingById.get(requestId)
    if (!call) {
      if (this.completedById.has(requestId)) return
      throw bridgeError('ENOENT', `Unknown bridge request: ${requestId}`)
    }
    if (call.claimedBy !== clientId) {
      throw bridgeError('BRIDGE_CONFLICT', `Bridge request ${requestId} belongs to another editor.`)
    }
    this.removePending(call)
    this.completedById.set(requestId, {
      fingerprint: call.fingerprint,
      result,
      expiresAt: Date.now() + BRIDGE_RESULT_TTL_MS,
    })
    call.resolve(result)
  }

  private getActiveClient(): BridgeClient | null {
    if (
      this.activeClient &&
      Date.now() - this.activeClient.lastSeenAt > BRIDGE_CLIENT_TTL_MS
    ) {
      const staleClientId = this.activeClient.clientId
      this.activeClient = null
      for (const call of this.pendingCalls) {
        if (call.claimedBy === staleClientId) call.claimedBy = undefined
      }
    }
    return this.activeClient
  }

  private touchClient(clientId: string): BridgeClient {
    const active = this.getActiveClient()
    if (!active || active.clientId !== clientId) {
      throw bridgeError('BRIDGE_CONFLICT', 'This FreeCut editor is not the active Bridge client.')
    }
    active.lastSeenAt = Date.now()
    return active
  }

  private claimNext(clientId: string): BridgeCallPayload | null {
    const active = this.touchClient(clientId)
    const call = this.pendingCalls.find(
      (candidate) =>
        !candidate.claimedBy &&
        (!candidate.projectId || candidate.projectId === active.projectId),
    )
    if (!call) return null
    call.claimedBy = clientId
    return {
      requestId: call.requestId,
      name: call.name,
      args: call.args,
      projectId: call.projectId,
      allowDestructive: call.allowDestructive,
      allowHandoff: call.allowHandoff,
      createdAt: call.createdAt,
    }
  }

  private dispatchPending(): void {
    const active = this.getActiveClient()
    if (!active) return
    const waiter = this.pollWaiters.get(active.clientId)
    if (!waiter) return
    const call = this.claimNext(active.clientId)
    if (!call) return
    clearTimeout(waiter.timeout)
    this.pollWaiters.delete(active.clientId)
    waiter.resolve(call)
  }

  private removePending(call: PendingBridgeCall): void {
    clearTimeout(call.timeout)
    this.pendingById.delete(call.requestId)
    const index = this.pendingCalls.indexOf(call)
    if (index >= 0) this.pendingCalls.splice(index, 1)
  }

  private cleanupCompleted(): void {
    const now = Date.now()
    for (const [requestId, completed] of this.completedById) {
      if (completed.expiresAt <= now) this.completedById.delete(requestId)
    }
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parsePathSegments(rawPath: string | null): string[] {
  const segments = (rawPath ?? '').split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment.includes('\\'))) {
    throw new Error('Invalid workspace path')
  }
  return segments
}

function resolveWorkspacePath(root: string, rawPath: string | null): string {
  const segments = parsePathSegments(rawPath)
  const target = resolve(root, ...segments)
  const relativePath = relative(root, target)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Workspace path escapes configured root')
  }
  return target
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = (await readBody(request)).toString('utf8')
  if (!body) return {} as T
  return JSON.parse(body) as T
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(data))
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  return 'code' in error ? String((error as { code: unknown }).code) : ''
}

function errorStatus(error: unknown): number {
  return ERROR_STATUS_BY_CODE[errorCode(error)] ?? 500
}

function requestTarget(context: RequestContext): string {
  return resolveWorkspacePath(context.root, context.url.searchParams.get('path'))
}

function localMediaTarget(context: RequestContext): string {
  const rawPath = context.url.searchParams.get('path')
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new Error('Local media path must be absolute')
  }
  return resolve(rawPath)
}

async function handleInfo({ root, response }: RequestContext): Promise<void> {
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error('Configured workspace is not a directory')
  sendJson(response, 200, { name: basename(root) })
}

async function handleEntries(context: RequestContext): Promise<void> {
  const entries = await fs.readdir(requestTarget(context), { withFileTypes: true })
  sendJson(
    context.response,
    200,
    entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
      })),
  )
}

async function handleDirectory(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  if (context.url.searchParams.get('create') === '1') {
    await fs.mkdir(target, { recursive: true })
  } else if (!(await fs.stat(target)).isDirectory()) {
    throw new Error('Path is not a directory')
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleFileHandle(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  if (context.url.searchParams.get('create') === '1') {
    await fs.mkdir(dirname(target), { recursive: true })
    const handle = await fs.open(target, 'a')
    await handle.close()
  } else if (!(await fs.stat(target)).isFile()) {
    throw new Error('Path is not a file')
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleReadFile(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  await sendFile(context.response, target)
}

async function sendFile(response: ServerResponse, target: string): Promise<void> {
  const stat = await fs.stat(target)
  if (!stat.isFile()) throw new Error('Path is not a file')
  response.statusCode = 200
  response.setHeader('Content-Type', 'application/octet-stream')
  response.setHeader('Content-Length', String(stat.size))
  response.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
  )
  response.setHeader('X-FreeCut-File-Name', encodeURIComponent(basename(target)))
  response.setHeader('X-FreeCut-Last-Modified', String(Math.round(stat.mtimeMs)))
  await pipeline(createReadStream(target), response)
}

async function handleWriteFile(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, await readBody(context.request))
  sendJson(context.response, 200, { ok: true })
}

async function handleDeleteEntry(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  const stat = await fs.stat(target)
  if (stat.isDirectory()) {
    await fs.rm(target, {
      recursive: context.url.searchParams.get('recursive') === '1',
      force: false,
    })
  } else {
    await fs.unlink(target)
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleMove(context: RequestContext): Promise<void> {
  const body = JSON.parse((await readBody(context.request)).toString('utf8')) as {
    from?: string
    to?: string
  }
  const from = resolveWorkspacePath(context.root, body.from ?? null)
  const to = resolveWorkspacePath(context.root, body.to ?? null)
  await fs.mkdir(dirname(to), { recursive: true })
  await fs.rm(to, { recursive: true, force: true })
  await fs.rename(from, to)
  sendJson(context.response, 200, { ok: true })
}

async function handleLocalMedia(context: RequestContext): Promise<void> {
  const target = localMediaTarget(context)
  const stat = await fs.stat(target)
  const recursive = context.url.searchParams.get('recursive') === '1'
  let files: LocalMediaFileDescriptor[]

  if (stat.isFile()) {
    files = [{ name: basename(target), path: target }]
  } else if (stat.isDirectory()) {
    const collectFiles = async (directory: string): Promise<LocalMediaFileDescriptor[]> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const collected: LocalMediaFileDescriptor[] = []
      for (const entry of entries) {
        const entryPath = resolve(directory, entry.name)
        if (entry.isFile()) {
          collected.push({ name: entry.name, path: entryPath })
        } else if (recursive && entry.isDirectory()) {
          collected.push(...(await collectFiles(entryPath)))
        }
      }
      return collected
    }
    files = (await collectFiles(target)).sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      )
  } else {
    throw new Error('Local media path is not a file or directory')
  }

  sendJson(context.response, 200, { files })
}

async function handleLocalMediaFile(context: RequestContext): Promise<void> {
  const target = localMediaTarget(context)
  if (!(await fs.stat(target)).isFile()) {
    throw new Error('Local media path is not a file')
  }
  await sendFile(context.response, target)
}

async function handleBridgeRegister(context: RequestContext): Promise<void> {
  const body = await readJsonBody<{
    clientId?: string
    projectId?: string | null
    tools?: BridgeToolDescriptor[]
  }>(context.request)
  const client = context.bridge.register({
    clientId: body.clientId ?? '',
    projectId: body.projectId ?? null,
    tools: Array.isArray(body.tools) ? body.tools : [],
  })
  sendJson(context.response, 200, {
    ok: true,
    clientId: client.clientId,
    projectId: client.projectId,
    toolCount: client.tools.length,
  })
}

async function handleBridgeUnregister(context: RequestContext): Promise<void> {
  const body = await readJsonBody<{ clientId?: string }>(context.request)
  if (!body.clientId) {
    throw bridgeError('BRIDGE_BAD_REQUEST', 'clientId is required.')
  }
  context.bridge.unregister(body.clientId)
  sendJson(context.response, 200, { ok: true })
}

async function handleBridgeStatus(context: RequestContext): Promise<void> {
  sendJson(context.response, 200, context.bridge.status())
}

async function handleBridgeTools(context: RequestContext): Promise<void> {
  const tools = context.bridge.tools()
  if (tools.length === 0) {
    throw bridgeError('BRIDGE_OFFLINE', 'No loaded FreeCut editor is connected.')
  }
  sendJson(context.response, 200, { tools })
}

async function handleBridgePoll(context: RequestContext): Promise<void> {
  const clientId = context.url.searchParams.get('clientId')
  if (!clientId) {
    throw bridgeError('BRIDGE_BAD_REQUEST', 'clientId is required.')
  }
  const call = await context.bridge.poll(clientId)
  if (context.response.destroyed || context.response.writableEnded) return
  if (!call) {
    context.response.statusCode = 204
    context.response.end()
    return
  }
  sendJson(context.response, 200, call)
}

async function handleBridgeResult(context: RequestContext): Promise<void> {
  const body = await readJsonBody<{
    clientId?: string
    requestId?: string
    result?: unknown
  }>(context.request)
  if (!body.clientId || !body.requestId || body.result === undefined) {
    throw bridgeError('BRIDGE_BAD_REQUEST', 'clientId, requestId, and result are required.')
  }
  context.bridge.complete(body.clientId, body.requestId, body.result)
  sendJson(context.response, 200, { ok: true })
}

async function handleBridgeCall(context: RequestContext): Promise<void> {
  const body = await readJsonBody<{
    requestId?: string
    name?: string
    args?: unknown
    projectId?: string
    allowDestructive?: boolean
    allowHandoff?: boolean
    timeoutMs?: number
  }>(context.request)
  if (!body.name) {
    throw bridgeError('BRIDGE_BAD_REQUEST', 'Tool name is required.')
  }
  const requestId = body.requestId?.trim() || randomUUID()
  const requestedTimeout = Number(body.timeoutMs ?? 5 * 60_000)
  const timeoutMs = Math.min(15 * 60_000, Math.max(1_000, requestedTimeout))
  const result = await context.bridge.enqueue({
    requestId,
    name: body.name,
    args: body.args ?? {},
    projectId: body.projectId,
    allowDestructive: body.allowDestructive === true,
    allowHandoff: body.allowHandoff === true,
    timeoutMs,
  })
  if (context.response.destroyed || context.response.writableEnded) return
  sendJson(context.response, 200, { requestId, result })
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function mcpCategories(tools: BridgeToolDescriptor[]) {
  const categories = new Map<
    string,
    { id: string; title: string; group: string; tools: string[] }
  >()
  for (const tool of tools) {
    const category = tool._meta?.['freecut/category']
    if (!category) continue
    const current = categories.get(category.id) ?? { ...category, tools: [] }
    current.tools.push(tool.name)
    categories.set(category.id, current)
  }
  return [...categories.values()]
}

async function handleBridgeMcp(context: RequestContext): Promise<void> {
  const body = await readJsonBody<Record<string, unknown>>(context.request)
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    sendJson(context.response, 200, jsonRpcError(body.id, -32600, 'Invalid JSON-RPC request.'))
    return
  }
  const id = body.id
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {}

  if (body.method === 'notifications/initialized') {
    context.response.statusCode = 202
    context.response.end()
    return
  }
  if (body.method === 'initialize') {
    sendJson(
      context.response,
      200,
      jsonRpcResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: 'freecut-web-development',
          version: '1.0.0',
          title: 'FreeCut Web Development',
        },
      }),
    )
    return
  }
  if (body.method === 'ping') {
    sendJson(context.response, 200, jsonRpcResult(id, {}))
    return
  }

  const tools = context.bridge.tools()
  if (tools.length === 0) {
    sendJson(
      context.response,
      200,
      jsonRpcError(id, -32002, 'No loaded FreeCut editor is connected.'),
    )
    return
  }
  if (body.method === 'tools/list') {
    sendJson(context.response, 200, jsonRpcResult(id, { tools }))
    return
  }
  if (body.method === 'resources/list') {
    sendJson(
      context.response,
      200,
      jsonRpcResult(id, {
        resources: [
          {
            uri: 'freecut://tool-categories',
            name: 'FreeCut tool categories',
            title: 'FreeCut Tool Categories',
            mimeType: 'application/json',
          },
        ],
      }),
    )
    return
  }
  if (body.method === 'resources/read') {
    if (params.uri !== 'freecut://tool-categories') {
      sendJson(
        context.response,
        200,
        jsonRpcError(id, -32002, `Unknown FreeCut resource: ${String(params.uri)}`),
      )
      return
    }
    sendJson(
      context.response,
      200,
      jsonRpcResult(id, {
        contents: [
          {
            uri: 'freecut://tool-categories',
            mimeType: 'application/json',
            text: JSON.stringify({ categories: mcpCategories(tools) }),
          },
        ],
      }),
    )
    return
  }
  if (body.method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    if (!name) {
      sendJson(context.response, 200, jsonRpcError(id, -32602, 'Tool name is required.'))
      return
    }
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {}
    try {
      const result = await context.bridge.enqueue({
        requestId: `mcp:${randomUUID()}`,
        name,
        args,
        projectId: context.bridge.status().client?.projectId ?? undefined,
        allowDestructive: true,
        allowHandoff: true,
        timeoutMs: 120_000,
      })
      sendJson(context.response, 200, jsonRpcResult(id, result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code =
        error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code: string }).code)
          : 'TOOL_EXECUTION_FAILED'
      sendJson(
        context.response,
        200,
        jsonRpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: {
            ok: false,
            changed: false,
            finalStatus: 'failed',
            error: { code, message },
          },
        }),
      )
    }
    return
  }

  sendJson(
    context.response,
    200,
    jsonRpcError(id, -32601, `Method not found: ${body.method}`),
  )
}

const routeHandlers: Record<string, RouteHandler> = {
  'GET /info': handleInfo,
  'GET /entries': handleEntries,
  'GET /local-media': handleLocalMedia,
  'GET /local-media-file': handleLocalMediaFile,
  'GET /bridge/status': handleBridgeStatus,
  'GET /bridge/tools': handleBridgeTools,
  'GET /bridge/poll': handleBridgePoll,
  'POST /directory': handleDirectory,
  'POST /file-handle': handleFileHandle,
  'POST /bridge/register': handleBridgeRegister,
  'POST /bridge/unregister': handleBridgeUnregister,
  'POST /bridge/call': handleBridgeCall,
  'POST /bridge/mcp': handleBridgeMcp,
  'POST /bridge/result': handleBridgeResult,
  'GET /file': handleReadFile,
  'PUT /file': handleWriteFile,
  'DELETE /entry': handleDeleteEntry,
  'POST /move': handleMove,
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url || '/', 'http://localhost')
}

function findRouteHandler(context: RequestContext): RouteHandler | undefined {
  const action = context.url.pathname.slice(API_PREFIX.length) || '/'
  return routeHandlers[`${context.request.method || 'GET'} ${action}`]
}

function sendRequestError(response: ServerResponse, error: unknown): void {
  sendJson(response, errorStatus(error), {
    error: error instanceof Error ? error.message : String(error),
  })
}

async function invokeRoute(handler: RouteHandler, context: RequestContext): Promise<void> {
  try {
    await handler(context)
  } catch (error) {
    sendRequestError(context.response, error)
  }
}

async function dispatchRequest(context: RequestContext): Promise<void> {
  const handler = findRouteHandler(context)
  if (!handler) {
    sendJson(context.response, 404, { error: 'Unknown development workspace operation' })
    return
  }
  await invokeRoute(handler, context)
}

async function handleRequest(
  root: string,
  bridge: DevAiBridge,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'Development workspace bridge is local-only' })
    return
  }

  response.setHeader(BRIDGE_HEADER, '1')
  await dispatchRequest({ root, request, response, url: requestUrl(request), bridge })
}

export function devWorkspacePlugin(workspacePath: string | undefined): Plugin {
  const root = workspacePath ? resolve(workspacePath) : null
  const bridge = new DevAiBridge()

  return {
    name: 'freecut-dev-workspace',
    apply: 'serve',
    configureServer(server) {
      if (!root) return
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(API_PREFIX)) {
          next()
          return
        }
        void handleRequest(root, bridge, request, response)
      })
    },
  }
}
