import {
  AgentRuntimeService,
  LocalDirectorLoop,
  type LocalDirectorLoopResult,
  type LocalDirectorTool,
  type LocalDirectorTurnResult,
} from '../agent-runtime'
import type {
  AgentContextPack,
  AgentEventRecord,
  AgentJsonValue,
  AgentRunRecord,
  AgentRuntimeRecord,
  AgentTimelineLease,
} from '../agent-runtime/agent-thread-types'
import { BridgeError, BridgeService } from '../bridge/bridge-service'
import type { DesktopBridgeToolDescriptor } from '../desktop-types'

export interface AgentTurnToolDescriptor {
  name: string
  title: string
  category: string
  description: string
  inputSchema?: unknown
  readOnly: boolean
  destructive: boolean
  handoff: boolean
}

export interface AgentTurnRequest {
  turnId: string
  profileId: string
  context: {
    summary: string
    recentMessages: Array<{
      role: 'user' | 'assistant' | 'tool'
      text: string
    }>
    directorState?: Record<string, AgentJsonValue>
    snapshotId: string
    fingerprint: string
  }
  tools: AgentTurnToolDescriptor[]
}

export interface AgentTurnTransport {
  run(
    input: {
      request: AgentTurnRequest
    },
    signal: AbortSignal,
  ): Promise<LocalDirectorTurnResult>
}

export interface LocalAgentHostServiceOptions {
  runtime: AgentRuntimeService
  bridge: BridgeService
  transport: AgentTurnTransport
  createId?: () => string
  now?: () => number
}

export interface LocalAgentHostRunInput {
  runId: string
  profileId: string
  threadId: string
  workspaceId: string
  projectId: string
  timelineId: string
  snapshotId: string
  fingerprint: string
  holderId: string
  leaseTtlMs: number
  userMessage: string
  input?: AgentJsonValue
  signal?: AbortSignal
}

export type LocalAgentHostRunResult =
  | LocalDirectorLoopResult
  | {
      status: 'lease_held'
      lease: AgentTimelineLease
    }

export type LocalAgentHostApprovalResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'uncertain'
  run: AgentRunRecord
  assistantText?: string
  errorCode?: string
}

interface LocalAgentHostTools {
  directorTools: LocalDirectorTool[]
  turnTools: () => AgentTurnToolDescriptor[]
}

const APPROVED_WRITE_TIMEOUT_BUFFER_MS = 10_000
const LOCAL_AGENT_TOOL_SEARCH = 'tool_search'
const LOCAL_AGENT_TOOL_DESCRIBE = 'tool_describe'
const LOCAL_AGENT_INITIAL_READ_TOOLS = new Set([
  'read_project',
  'read_timeline',
  'read_history',
  'find_clips',
  'search_transcript',
])
const LOCAL_AGENT_TOOL_SEARCH_LIMIT = 8
const LOCAL_AGENT_TOOL_SEARCH_MAX_LIMIT = 16

export class LocalAgentHostService {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: LocalAgentHostServiceOptions) {
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    this.now = options.now ?? Date.now
  }

  async run(input: LocalAgentHostRunInput): Promise<LocalAgentHostRunResult> {
    await this.ensureThreadAndUserTurn(input)
    const started = await this.options.runtime.startRun({
      id: input.runId,
      threadId: input.threadId,
      projectId: input.projectId,
      timelineId: input.timelineId,
      holderId: input.holderId,
      leaseTtlMs: input.leaseTtlMs,
      input: input.input ?? { profileId: input.profileId },
    })
    if (!started.started) {
      return {
        status: 'lease_held',
        lease: started.lease,
      }
    }

    const tools = this.createTools(input)
    await this.options.runtime.putRecords({
      records: [
        this.createEvent(started.run, 'localAgentHostStarted', {
          profileId: input.profileId,
        }),
      ],
    })

    const loop = new LocalDirectorLoop({
      runtime: this.options.runtime,
      tools: tools.directorTools,
      createId: this.createId,
      now: this.now,
      runTurn: async (context, _directorTools, signal) =>
        this.options.transport.run(
          {
            request: {
              turnId: this.createId(),
              profileId: input.profileId,
              context: this.createTurnContext(context.contextPack),
              tools: tools.turnTools(),
            },
          },
          signal,
        ),
    })

    return loop.run({
      runId: started.run.id,
      holderId: input.holderId,
      snapshotId: input.snapshotId,
      fingerprint: input.fingerprint,
      leaseTtlMs: input.leaseTtlMs,
      signal: input.signal,
    })
  }

  async approve(input: {
    runId: string
    holderId: string
    leaseTtlMs: number
  }): Promise<LocalAgentHostApprovalResult> {
    const { run, approval } = await this.getPendingApproval(input.runId)
    try {
      await this.options.runtime.renewLease({
        timelineId: run.timelineId,
        holderId: input.holderId,
        runId: run.id,
        fence: this.requireFence(run),
        ttlMs: input.leaseTtlMs,
      })
    } catch {
      return {
        status: 'failed',
        run,
        assistantText: '本地审批已过期，请重新提交该操作。',
        errorCode: 'LOCAL_AGENT_APPROVAL_EXPIRED',
      }
    }
    const bridgeRequestId = this.createId()
    await this.options.runtime.putRecords({
      records: [
        this.createEvent(run, 'approvalGranted', {
          callId: approval.id,
          toolName: approval.name,
          bridgeRequestId,
        }),
      ],
    })

    const tool = this.options.bridge.tools().find((candidate) => candidate.name === approval.name)
    if (!tool) {
      return this.finishApprovalFailure(
        run,
        input.holderId,
        'LOCAL_AGENT_TOOL_UNAVAILABLE',
        approval,
      )
    }

    try {
      const result = await this.options.bridge.call({
        requestId: bridgeRequestId,
        name: approval.name,
        args: approval.arguments ?? {},
        projectId: run.projectId,
        allowDestructive: tool.annotations?.destructiveHint === true,
        confirmedByLocalAgent: true,
        timeoutMs: Math.max(1_000, input.leaseTtlMs - APPROVED_WRITE_TIMEOUT_BUFFER_MS),
      })
      const assistantText = `已执行 ${approval.name}。`
      const completed = await this.options.runtime.completeRun({
        runId: run.id,
        timelineId: run.timelineId,
        holderId: input.holderId,
        fence: this.requireFence(run),
        status: 'succeeded',
        output: { toolName: approval.name },
        additionalRecords: [
          this.createTurn(run, 'assistant', assistantText, await this.nextTurnSequence(run.threadId)),
          this.createEvent(run, 'toolReceipt', {
            callId: approval.id,
            toolName: approval.name,
            bridgeRequestId,
            status: 'succeeded',
            ...(this.isJsonValue(result) ? { output: result } : {}),
          }),
          this.createEvent(run, 'localAgentWriteCompleted', {
            callId: approval.id,
            toolName: approval.name,
          }),
        ],
      })
      return { status: 'completed', run: completed, assistantText }
    } catch (error) {
      const status =
        error instanceof BridgeError && error.finalStatus === 'uncertain'
          ? 'uncertain'
          : error instanceof BridgeError && error.finalStatus === 'cancelled'
            ? 'cancelled'
            : 'failed'
      const errorCode =
        error instanceof BridgeError ? error.code : 'LOCAL_AGENT_WRITE_FAILED'
      const assistantText =
        status === 'cancelled'
          ? '请求已取消。'
          : status === 'uncertain'
            ? `执行结果不确定：${errorCode}`
            : `请求失败：${errorCode}`
      const completed = await this.options.runtime.completeRun({
        runId: run.id,
        timelineId: run.timelineId,
        holderId: input.holderId,
        fence: this.requireFence(run),
        status,
        errorCode,
        additionalRecords: [
          this.createTurn(run, 'assistant', assistantText, await this.nextTurnSequence(run.threadId)),
          this.createEvent(run, 'toolReceipt', {
            callId: approval.id,
            toolName: approval.name,
            bridgeRequestId,
            status: 'failed',
            errorCode,
          }),
        ],
      })
      return { status, run: completed, assistantText, errorCode }
    }
  }

  async cancel(input: { runId: string; holderId: string }): Promise<LocalAgentHostApprovalResult> {
    const { run, approval } = await this.getPendingApproval(input.runId)
    const assistantText = '请求已取消。'
    const completed = await this.options.runtime.completeRun({
      runId: run.id,
      timelineId: run.timelineId,
      holderId: input.holderId,
      fence: this.requireFence(run),
      status: 'cancelled',
      errorCode: 'LOCAL_AGENT_CANCELLED',
      additionalRecords: [
        this.createTurn(run, 'assistant', assistantText, await this.nextTurnSequence(run.threadId)),
        this.createEvent(run, 'approvalCancelled', {
          callId: approval.id,
          toolName: approval.name,
        }),
        this.createEvent(run, 'localAgentCancelled', {
          errorCode: 'LOCAL_AGENT_CANCELLED',
        }),
      ],
    })
    return {
      status: 'cancelled',
      run: completed,
      assistantText,
      errorCode: 'LOCAL_AGENT_CANCELLED',
    }
  }

  private createTools(input: LocalAgentHostRunInput): LocalAgentHostTools {
    const catalog = this.options.bridge
      .tools()
      .filter(
        (tool) =>
          tool.name !== LOCAL_AGENT_TOOL_SEARCH && tool.name !== LOCAL_AGENT_TOOL_DESCRIBE,
      )
      .map((tool) => this.createTurnTool(tool))
    const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]))
    const disclosedToolNames = new Set(
      catalog
        .filter(
          (tool) => tool.readOnly && LOCAL_AGENT_INITIAL_READ_TOOLS.has(tool.name),
        )
        .map((tool) => tool.name),
    )
    const discoveryTools = this.createDiscoveryTools(catalog, catalogByName, disclosedToolNames)
    const directorTools: LocalDirectorTool[] = catalog.map((tool) => {
      const descriptor: LocalDirectorTool = {
        name: tool.name,
        access: tool.readOnly ? 'read' : 'write',
        description: tool.description,
      }
      if (tool.readOnly) {
        descriptor.execute = async (call, signal) => {
          if (signal.aborted) throw new Error('Local Agent run was cancelled.')
          const result = await this.options.bridge.call({
            requestId: this.createId(),
            name: call.name,
            args: call.arguments ?? {},
            projectId: input.projectId,
          })
          return this.toAgentJsonValue(result)
        }
      }
      return descriptor
    })
    return {
      directorTools: [...directorTools, ...discoveryTools.directorTools],
      turnTools: () => [
        ...discoveryTools.turnTools(),
        ...catalog.filter((tool) => disclosedToolNames.has(tool.name)),
      ],
    }
  }

  private createDiscoveryTools(
    catalog: AgentTurnToolDescriptor[],
    catalogByName: Map<string, AgentTurnToolDescriptor>,
    disclosedToolNames: Set<string>,
  ): LocalAgentHostTools {
    const searchDescriptor: AgentTurnToolDescriptor = {
      name: LOCAL_AGENT_TOOL_SEARCH,
      title: '搜索工具目录',
      category: 'discovery',
      description: '按名称、说明或分类搜索本机 FreeCut 工具。命中的工具会在下一轮可用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          category: { type: 'string' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: LOCAL_AGENT_TOOL_SEARCH_MAX_LIMIT,
          },
        },
        additionalProperties: false,
      },
      readOnly: true,
      destructive: false,
      handoff: false,
    }
    const describeDescriptor: AgentTurnToolDescriptor = {
      name: LOCAL_AGENT_TOOL_DESCRIBE,
      title: '查看工具说明',
      category: 'discovery',
      description: '按精确工具名读取一个本机 FreeCut 工具说明，并在下一轮启用该工具。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      readOnly: true,
      destructive: false,
      handoff: false,
    }
    const categoryCounts = new Map<string, number>()
    for (const tool of catalog) {
      categoryCounts.set(tool.category, (categoryCounts.get(tool.category) ?? 0) + 1)
    }
    const categories = [...categoryCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, count]) => ({ id, count }))
    const searchTool: LocalDirectorTool = {
      name: LOCAL_AGENT_TOOL_SEARCH,
      access: 'read',
      description: searchDescriptor.description,
      execute: async (call) => {
        const input = this.requireObjectArguments(call.arguments, LOCAL_AGENT_TOOL_SEARCH)
        const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
        const category =
          typeof input.category === 'string' ? input.category.trim().toLowerCase() : ''
        const limit =
          typeof input.limit === 'number' && Number.isInteger(input.limit)
            ? Math.min(
                LOCAL_AGENT_TOOL_SEARCH_MAX_LIMIT,
                Math.max(1, input.limit),
              )
            : LOCAL_AGENT_TOOL_SEARCH_LIMIT
        const matches = catalog
          .filter((tool) => !category || tool.category.toLowerCase() === category)
          .map((tool) => ({
            tool,
            score: this.toolSearchScore(tool, query),
          }))
          .filter(({ score }) => !query || score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.tool.name.localeCompare(right.tool.name),
          )
          .slice(0, limit)
          .map(({ tool }) => tool)
        for (const tool of matches) disclosedToolNames.add(tool.name)
        return {
          count: matches.length,
          categories,
          tools: matches.map((tool) => this.createToolSummary(tool)),
        }
      },
    }
    const describeTool: LocalDirectorTool = {
      name: LOCAL_AGENT_TOOL_DESCRIBE,
      access: 'read',
      description: describeDescriptor.description,
      execute: async (call) => {
        const input = this.requireObjectArguments(call.arguments, LOCAL_AGENT_TOOL_DESCRIBE)
        if (typeof input.name !== 'string' || !input.name.trim()) {
          throw new Error('tool_describe requires a tool name.')
        }
        const tool = catalogByName.get(input.name.trim())
        if (!tool) return { tool: null }
        disclosedToolNames.add(tool.name)
        return { tool: this.createToolSummary(tool) }
      },
    }
    return {
      directorTools: [searchTool, describeTool],
      turnTools: () => [searchDescriptor, describeDescriptor],
    }
  }

  private requireObjectArguments(
    value: AgentJsonValue | undefined,
    toolName: string,
  ): Record<string, AgentJsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${toolName} requires object arguments.`)
    }
    return value
  }

  private toolSearchScore(tool: AgentTurnToolDescriptor, query: string): number {
    if (!query) return 0
    const terms = query.split(/[\s_./:-]+/).filter(Boolean)
    const name = tool.name.toLowerCase()
    const title = tool.title.toLowerCase()
    const text = `${name} ${title} ${tool.description.toLowerCase()} ${tool.category.toLowerCase()}`
    return terms.reduce((score, term) => {
      if (name.includes(term)) return score + 4
      if (title.includes(term)) return score + 3
      if (text.includes(term)) return score + 1
      return score
    }, 0)
  }

  private createToolSummary(tool: AgentTurnToolDescriptor): AgentJsonValue {
    return {
      name: tool.name,
      title: tool.title,
      category: tool.category,
      description: tool.description,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      handoff: tool.handoff,
    }
  }

  private async ensureThreadAndUserTurn(input: LocalAgentHostRunInput): Promise<void> {
    const existing = await this.options.runtime.listRecords({
      threadId: input.threadId,
      kinds: ['thread', 'turn'],
      limit: Number.MAX_SAFE_INTEGER,
    })
    const now = this.now()
    const records: AgentRuntimeRecord[] = []
    if (!existing.records.some((record) => record.kind === 'thread')) {
      records.push({
        kind: 'thread',
        id: input.threadId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdAt: now,
        updatedAt: now,
      })
    }
    const nextSequence =
      existing.records
        .filter((record) => record.kind === 'turn')
        .reduce(
          (maximum, record) => Math.max(maximum, record.sequence),
          -1,
        ) + 1
    records.push({
      kind: 'turn',
      id: this.createId(),
      threadId: input.threadId,
      role: 'user',
      body: input.userMessage,
      sequence: nextSequence,
      createdAt: now,
      updatedAt: now,
    })
    await this.options.runtime.putRecords({ records })
  }

  private async getPendingApproval(runId: string): Promise<{
    run: AgentRunRecord
    approval: { id: string; name: string; arguments?: AgentJsonValue }
  }> {
    const run = await this.getRunningRun(runId)
    const events = await this.options.runtime.listRecords({
      threadId: run.threadId,
      kinds: ['event'],
      limit: Number.MAX_SAFE_INTEGER,
    })
    const event = [...events.records]
      .reverse()
      .find(
        (record): record is AgentEventRecord =>
          record.kind === 'event' &&
          record.runId === run.id &&
          record.eventType === 'approvalRequested',
      )
    if (!event || !this.isApprovalPayload(event.payload)) {
      throw new Error('Local Agent run is not waiting for approval.')
    }
    return {
      run,
      approval: {
        id: event.payload.callId,
        name: event.payload.toolName,
        ...(event.payload.arguments === undefined
          ? {}
          : { arguments: event.payload.arguments }),
      },
    }
  }

  private async finishApprovalFailure(
    run: AgentRunRecord,
    holderId: string,
    errorCode: string,
    approval: { id: string; name: string },
  ): Promise<LocalAgentHostApprovalResult> {
    const assistantText = `请求失败：${errorCode}`
    const completed = await this.options.runtime.completeRun({
      runId: run.id,
      timelineId: run.timelineId,
      holderId,
      fence: this.requireFence(run),
      status: 'failed',
      errorCode,
      additionalRecords: [
        this.createTurn(run, 'assistant', assistantText, await this.nextTurnSequence(run.threadId)),
        this.createEvent(run, 'toolReceipt', {
          callId: approval.id,
          toolName: approval.name,
          status: 'failed',
          errorCode,
        }),
      ],
    })
    return { status: 'failed', run: completed, assistantText, errorCode }
  }

  private async getRunningRun(runId: string): Promise<AgentRunRecord> {
    const record = await this.options.runtime.store.getRecord('run', runId)
    if (!record || record.kind !== 'run' || record.status !== 'running') {
      throw new Error('Local Agent run is not active.')
    }
    return record
  }

  private requireFence(run: AgentRunRecord): number {
    if (!run.fence) throw new Error(`Local Agent run is missing a fence: ${run.id}`)
    return run.fence
  }

  private async nextTurnSequence(threadId: string): Promise<number> {
    const turns = await this.options.runtime.listRecords({
      threadId,
      kinds: ['turn'],
      limit: Number.MAX_SAFE_INTEGER,
    })
    return (
      turns.records
        .filter((record) => record.kind === 'turn')
        .reduce((maximum, record) => Math.max(maximum, record.sequence), -1) + 1
    )
  }

  private createTurn(
    run: AgentRunRecord,
    role: 'assistant',
    body: string,
    sequence: number,
  ): AgentRuntimeRecord {
    const createdAt = this.now()
    return {
      kind: 'turn',
      id: this.createId(),
      threadId: run.threadId,
      role,
      body,
      sequence,
      createdAt,
      updatedAt: createdAt,
    }
  }

  private isApprovalPayload(
    value: AgentJsonValue | undefined,
  ): value is { callId: string; toolName: string; arguments?: AgentJsonValue } {
    return (
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.callId === 'string' &&
      typeof value.toolName === 'string'
    )
  }

  private isJsonValue(value: unknown): value is AgentJsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every((item) => this.isJsonValue(item))
    return (
      !!value &&
      typeof value === 'object' &&
      Object.values(value).every((item) => this.isJsonValue(item))
    )
  }

  private toAgentJsonValue(value: unknown): AgentJsonValue | undefined {
    if (value === undefined) return undefined
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    return JSON.parse(serialized) as AgentJsonValue
  }

  private createTurnTool(tool: DesktopBridgeToolDescriptor): AgentTurnToolDescriptor {
    return {
      name: tool.name,
      title: tool.annotations?.title ?? tool.name,
      category: tool._meta?.['freecut/category']?.id ?? 'general',
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      handoff: tool.annotations?.handoffRequired === true,
    }
  }

  private createTurnContext(contextPack: AgentContextPack): AgentTurnRequest['context'] {
    return {
      summary: contextPack.contextSummary?.summary ?? '',
      recentMessages: contextPack.recentTurns.map((turn) => ({
        role: turn.role === 'system' ? 'assistant' : turn.role,
        text: turn.body,
      })),
      ...(contextPack.directorState === undefined
        ? {}
        : { directorState: contextPack.directorState }),
      snapshotId: contextPack.snapshotId,
      fingerprint: contextPack.fingerprint,
    }
  }

  private createEvent(
    run: { id: string; threadId: string },
    eventType: string,
    payload: AgentJsonValue,
  ): AgentEventRecord {
    const createdAt = this.now()
    return {
      kind: 'event',
      id: this.createId(),
      threadId: run.threadId,
      runId: run.id,
      eventType,
      payload,
      createdAt,
      updatedAt: createdAt,
    }
  }
}
