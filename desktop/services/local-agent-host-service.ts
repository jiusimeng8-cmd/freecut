import {
  AgentRuntimeService,
  LocalDirectorLoop,
  type LocalDirectorLoopResult,
  type LocalDirectorResumeState,
  type LocalDirectorTool,
  type LocalDirectorToolCall,
  type LocalDirectorToolReceipt,
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
import { getBridgeToolFailure } from '../bridge/bridge-tool-failure'
import type { DesktopBridgeToolDescriptor } from '../desktop-types'
import { AGENT_TURN_SERVER_LIMITS } from './agent-turn-contract'
import { buildLocalAgentSummary, buildToolCatalogOutline } from './local-agent-instructions'
import { extractToolCallPath } from './tool-call-path'
import { scoreToolForQuery } from './tool-search-index'

/** Keeps one string inside the server's per-field character cap. */
function clampText(value: string): string {
  return value.length > AGENT_TURN_SERVER_LIMITS.textChars
    ? value.slice(0, AGENT_TURN_SERVER_LIMITS.textChars)
    : value
}

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
  /**
   * Authorizes the local path an approved write will touch. The in-app
   * approval card already names the path, so this replaces the separate
   * path-authorization prompt rather than adding a silent grant. Failures are
   * non-fatal: the write proceeds and the unchanged prompt still applies.
   */
  authorizeLocalPath?: (path: string) => Promise<void>
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
  /**
   * What is on the timeline right now, as the Renderer sees it — clip refs,
   * durations, the playhead. Main cannot derive this: the timeline lives in
   * Renderer stores. Without it the model starts every task blind and burns
   * rounds rediscovering the project it was just asked about.
   */
  timelineContext?: string
  input?: AgentJsonValue
  signal?: AbortSignal
}

/**
 * A pending approval as the caller sees it. The loop's own result carries the
 * resume budget too, but that is bookkeeping this service owns — it is dropped
 * here so it never reaches IPC or the Renderer.
 */
export interface LocalAgentHostWaitingApproval {
  status: 'waiting_approval'
  runId: string
  approval: LocalDirectorToolCall
}

export type LocalAgentHostRunResult =
  | Exclude<LocalDirectorLoopResult, { status: 'waiting_approval' }>
  | LocalAgentHostWaitingApproval
  | {
      status: 'lease_held'
      lease: AgentTimelineLease
    }

export type LocalAgentHostApprovalResult =
  | {
      status: 'completed' | 'failed' | 'cancelled' | 'uncertain'
      run: AgentRunRecord
      assistantText?: string
      errorCode?: string
    }
  | LocalAgentHostWaitingApproval

interface LocalAgentHostTools {
  directorTools: LocalDirectorTool[]
  turnTools: () => AgentTurnToolDescriptor[]
  /**
   * Every tool name on this machine, grouped by category, for the turn prompt.
   *
   * Sent even though most of those tools are not callable yet: a name is all
   * `tool_describe` needs, so naming them all turns discovery from "guess an
   * English search phrase" into "look one up", and lets a request that needs
   * three tools disclose all three in a single batched round.
   */
  catalogOutline: string
}

/** The two discovery tools, which are always callable and never disclosed. */
interface LocalAgentDiscoveryTools {
  directorTools: LocalDirectorTool[]
  turnTools: () => AgentTurnToolDescriptor[]
}

/**
 * Everything needed to carry one run past an approval.
 *
 * The loop is kept rather than rebuilt because its tool closures hold the
 * disclosure set: rebuilding would hide every tool the model had already found
 * and force it to search the catalog again after each approved write.
 */
interface LocalAgentPendingRun {
  loop: LocalDirectorLoop
  input: LocalAgentHostRunInput
  resume: LocalDirectorResumeState
}

const APPROVED_WRITE_TIMEOUT_BUFFER_MS = 10_000
const LOCAL_AGENT_TOOL_SEARCH = 'tool_search'
const LOCAL_AGENT_TOOL_DESCRIBE = 'tool_describe'
/**
 * The tools callable before the model has discovered anything.
 *
 * Deliberately small, and read-only by construction — `createTools` filters this
 * set by `readOnly`, so a write tool listed here would silently do nothing, and
 * forcing one through would only buy an approval prompt. Widening it was
 * simulated against 15 typical requests and lost on every axis: a 22-tool set
 * cost ~3200 prompt tokens per turn and still hit the same worst-case discovery
 * round count as the tool catalog in the summary, which costs ~930 once. The
 * catalog is the lever; this set only needs to cover the reads a first turn
 * always wants.
 */
const LOCAL_AGENT_INITIAL_READ_TOOLS = new Set([
  'read_project',
  'read_timeline',
  'read_media',
  'read_history',
  'find_clips',
  'search_transcript',
])
const LOCAL_AGENT_TOOL_SEARCH_LIMIT = 8
const LOCAL_AGENT_TOOL_SEARCH_MAX_LIMIT = 16

export class LocalAgentHostService {
  private readonly createId: () => string
  private readonly now: () => number
  /**
   * Runs paused on an approval, keyed by runId.
   *
   * Held in memory on purpose: the entry owns the loop's live tool closures,
   * which cannot be serialized. A run interrupted by an app restart is already
   * marked `uncertain` by `recoverInterrupted`, so nothing here needs to
   * survive the process.
   */
  private readonly pendingRuns = new Map<string, LocalAgentPendingRun>()

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
              context: this.createTurnContext(
                context.contextPack,
                input.timelineContext,
                tools.catalogOutline,
              ),
              tools: tools.turnTools().slice(0, AGENT_TURN_SERVER_LIMITS.tools),
            },
          },
          signal,
        ),
    })

    return this.runLoop(loop, { ...input, runId: started.run.id })
  }

  /**
   * Drives one loop pass and records what an approval would need to continue.
   * Both the initial dispatch and every resumption after an approved write go
   * through here so the pending-run bookkeeping cannot drift between them.
   */
  private async runLoop(
    loop: LocalDirectorLoop,
    input: LocalAgentHostRunInput,
    resume?: LocalDirectorResumeState,
  ): Promise<LocalAgentHostRunResult> {
    const result = await loop.run({
      runId: input.runId,
      holderId: input.holderId,
      snapshotId: input.snapshotId,
      fingerprint: input.fingerprint,
      leaseTtlMs: input.leaseTtlMs,
      signal: input.signal,
      ...(resume ? { resume } : {}),
    })
    if (result.status === 'waiting_approval') {
      this.pendingRuns.set(result.runId, { loop, input, resume: result.resume })
      return {
        status: 'waiting_approval',
        runId: result.runId,
        approval: result.approval,
      }
    }
    this.pendingRuns.delete(input.runId)
    return result
  }

  async approve(input: {
    runId: string
    holderId: string
    leaseTtlMs: number
    /**
     * Aborts the rounds that run *after* the approved write lands. The write
     * itself is already dispatched and cannot be taken back, so this covers the
     * resumed loop only.
     */
    signal?: AbortSignal
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

    let result: unknown
    try {
      // The user approved this specific call, and the approval card named the
      // path, so authorize it now instead of interrupting the dispatch with a
      // second prompt for the same decision.
      const localPath = extractToolCallPath(approval.arguments)
      if (localPath && this.options.authorizeLocalPath) {
        try {
          await this.options.authorizeLocalPath(localPath)
        } catch {
          // Non-fatal: the write still runs and the path prompt still guards it.
        }
      }
      result = await this.options.bridge.call({
        requestId: bridgeRequestId,
        name: approval.name,
        args: approval.arguments ?? {},
        projectId: run.projectId,
        allowDestructive: tool.annotations?.destructiveHint === true,
        confirmedByLocalAgent: true,
        timeoutMs: Math.max(1_000, input.leaseTtlMs - APPROVED_WRITE_TIMEOUT_BUFFER_MS),
      })
      // A resolved Bridge promise only means the Renderer answered. Tool
      // failures come back as a resolved payload with `isError: true`, so
      // reporting success without this check would record a false
      // ToolReceipt and tell the user the write landed when it did not.
      const failure = getBridgeToolFailure(result)
      if (failure) throw new BridgeError(failure.code, failure.message)
    } catch (error) {
      this.pendingRuns.delete(run.id)
      const status =
        error instanceof BridgeError && error.finalStatus === 'uncertain'
          ? 'uncertain'
          : error instanceof BridgeError && error.finalStatus === 'cancelled'
            ? 'cancelled'
            : 'failed'
      const errorCode =
        error instanceof BridgeError ? error.code : 'LOCAL_AGENT_WRITE_FAILED'
      // Surface the tool's own message when it has one — a bare error code
      // leaves the user with no idea why the write did not land.
      const detail = error instanceof Error ? error.message.trim() : ''
      const reason = detail && detail !== errorCode ? `${errorCode}（${detail}）` : errorCode
      const assistantText =
        status === 'cancelled'
          ? '请求已取消。'
          : status === 'uncertain'
            ? `执行结果不确定：${reason}`
            : `请求失败：${reason}`
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
    // Deliberately outside the catch: resuming the loop finishes the run on its
    // own, and a failure in there must not be reported as a failed write nor
    // complete the same run twice.
    return this.continueAfterWrite(run, input, approval, bridgeRequestId, result)
  }

  async cancel(input: { runId: string; holderId: string }): Promise<LocalAgentHostApprovalResult> {
    const { run, approval } = await this.getPendingApproval(input.runId)
    this.pendingRuns.delete(input.runId)
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

  /**
   * Records an approved write as a tool receipt and hands control back to the
   * loop.
   *
   * The run used to end here, which capped every task at a single write — the
   * model could import media or place it, never both. Feeding the result back
   * as a receipt is also what lets the next turn see whether the write did what
   * the model expected.
   */
  private async continueAfterWrite(
    run: AgentRunRecord,
    input: { runId: string; holderId: string; leaseTtlMs: number; signal?: AbortSignal },
    approval: LocalDirectorToolCall,
    bridgeRequestId: string,
    result: unknown,
  ): Promise<LocalAgentHostApprovalResult> {
    const output = this.toAgentJsonValue(result)
    const receipt: LocalDirectorToolReceipt = {
      callId: approval.id,
      toolName: approval.name,
      status: 'succeeded',
      ...(approval.arguments === undefined ? {} : { arguments: approval.arguments }),
      ...(output === undefined ? {} : { output }),
    }
    await this.options.runtime.putRecords({
      records: [
        // The `tool` turn is the only form the model actually reads; the event
        // is for the UI and diagnostics.
        this.createToolTurn(run, JSON.stringify(receipt), await this.nextTurnSequence(run.threadId)),
        this.createEvent(run, 'toolReceipt', {
          callId: approval.id,
          toolName: approval.name,
          bridgeRequestId,
          status: 'succeeded',
          ...(output === undefined ? {} : { output }),
        }),
        this.createEvent(run, 'localAgentWriteCompleted', {
          callId: approval.id,
          toolName: approval.name,
        }),
      ],
    })

    const pending = this.pendingRuns.get(run.id)
    if (!pending) {
      // No loop to resume — the process restarted, or the run was dispatched by
      // an older build. Finish the way approvals used to, so an approved write
      // is never left hanging with its lease held.
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
        ],
      })
      return { status: 'completed', run: completed, assistantText }
    }

    this.pendingRuns.delete(run.id)
    const resumed = await this.runLoop(
      pending.loop,
      {
        ...pending.input,
        holderId: input.holderId,
        leaseTtlMs: input.leaseTtlMs,
        // The original run's signal belongs to a settled IPC call; the resumed
        // rounds are driven by the approval call, so they take its signal.
        ...(input.signal ? { signal: input.signal } : { signal: undefined }),
      },
      { ...pending.resume, receipts: [...pending.resume.receipts, receipt] },
    )
    if (resumed.status === 'waiting_approval' || resumed.status === 'lease_held') {
      // `lease_held` cannot come from a resumed loop; narrowing here keeps the
      // union honest without an assertion.
      return resumed.status === 'waiting_approval'
        ? resumed
        : {
            status: 'failed',
            run,
            errorCode: 'LOCAL_AGENT_LEASE_HELD',
          }
    }
    return resumed.status === 'completed'
      ? { status: 'completed', run: resumed.run, assistantText: resumed.assistantText }
      : {
          status: resumed.status,
          run: resumed.run,
          errorCode: resumed.errorCode,
          // Forwarded rather than rebuilt: the loop already turned the code into
          // something a user can act on, and re-deriving it here would put the
          // bare code back in the chat on exactly the resume path.
          assistantText: resumed.assistantText,
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
          const requestId = this.createId()
          // Aborting the loop is not enough on its own: a read tool already
          // dispatched to the Renderer keeps running and holds the round open.
          // Cancelling the Bridge call is what makes "停止" stop something.
          const cancel = () => {
            void this.options.bridge.cancel(requestId).catch(() => undefined)
          }
          signal.addEventListener('abort', cancel, { once: true })
          try {
            const result = await this.options.bridge.call({
              requestId,
              name: call.name,
              args: call.arguments ?? {},
              projectId: input.projectId,
            })
            return this.toAgentJsonValue(result)
          } finally {
            signal.removeEventListener('abort', cancel)
          }
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
      catalogOutline: buildToolCatalogOutline(catalog),
    }
  }

  private createDiscoveryTools(
    catalog: AgentTurnToolDescriptor[],
    catalogByName: Map<string, AgentTurnToolDescriptor>,
    disclosedToolNames: Set<string>,
  ): LocalAgentDiscoveryTools {
    const searchDescriptor: AgentTurnToolDescriptor = {
      name: LOCAL_AGENT_TOOL_SEARCH,
      title: '搜索工具目录',
      category: 'discovery',
      description:
        '按名称、说明或分类搜索本机 FreeCut 工具。命中的工具会在下一轮可用。' +
        '工具名与说明均为英文，中文查询会自动翻译，但用英文关键词（如 "place media timeline"）最准确。',
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
        const scored = catalog
          .filter((tool) => !category || tool.category.toLowerCase() === category)
          .map((tool) => ({
            tool,
            score: this.toolSearchScore(tool, query),
          }))
        const ranked = scored
          .filter(({ score }) => !query || score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.tool.name.localeCompare(right.tool.name),
          )
        // A query that matches nothing used to return an empty list, which reads
        // as "no such tool exists" and sends the model off to reword and search
        // again. The lexicon cannot cover every phrasing, so on a miss fall back
        // to the catalog itself: a truncated list the model can read beats a
        // confident zero it has no way to recover from.
        const exhausted = query.length > 0 && ranked.length === 0
        const matches = (exhausted ? scored.sort((left, right) =>
          left.tool.name.localeCompare(right.tool.name),
        ) : ranked)
          .slice(0, limit)
          .map(({ tool }) => tool)
        for (const tool of matches) disclosedToolNames.add(tool.name)
        return {
          count: matches.length,
          categories,
          ...(exhausted
            ? {
                unmatched: true,
                // Names the real problem instead of leaving the model to guess
                // that its vocabulary, not the catalog, was the mismatch.
                hint:
                  'No tool matched that query, so this is an unranked slice of the catalog. ' +
                  'Tool names and descriptions are English — search with English keywords ' +
                  '(for example "place media timeline" rather than "把素材放到时间轴"), ' +
                  'or list one category with the category argument.',
              }
            : {}),
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
    return scoreToolForQuery(tool, query)
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

  private createToolTurn(
    run: AgentRunRecord,
    body: string,
    sequence: number,
  ): AgentRuntimeRecord {
    const createdAt = this.now()
    return {
      kind: 'turn',
      id: this.createId(),
      threadId: run.threadId,
      role: 'tool',
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
      // The server requires this field. An absent schema serializes to a missing
      // key, not null, so a tool disclosed without one would reject the entire
      // turn — every other tool included — with an opaque 400.
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      handoff: tool.annotations?.handoffRequired === true,
    }
  }

  private createTurnContext(
    contextPack: AgentContextPack,
    timelineContext: string | undefined,
    toolCatalog: string,
  ): AgentTurnRequest['context'] {
    return {
      // Clamped here rather than upstream because this is the only point that
      // sees the finished wire payload. The server rejects an oversized request
      // outright, so dropping the oldest turns beats failing the whole run.
      summary: clampText(
        buildLocalAgentSummary({
          toolCatalog,
          ...(timelineContext === undefined ? {} : { timelineContext }),
          ...(contextPack.contextSummary?.summary === undefined
            ? {}
            : { threadSummary: contextPack.contextSummary.summary }),
        }),
      ),
      recentMessages: contextPack.recentTurns
        .slice(-AGENT_TURN_SERVER_LIMITS.recentMessages)
        .map((turn) => ({
          role: turn.role === 'system' ? 'assistant' : turn.role,
          text: clampText(turn.body),
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
