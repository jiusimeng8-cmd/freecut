import type { AgentRuntimeService } from './agent-runtime-service'
import type {
  AgentContextPack,
  AgentJsonValue,
  AgentRunRecord,
  AgentRuntimeRecord,
} from './agent-thread-types'

export const LOCAL_DIRECTOR_MAX_ROUNDS = 12
export const LOCAL_DIRECTOR_MAX_TOOL_CALLS_PER_ROUND = 8
/**
 * Extra rounds granted to rounds that only searched the tool catalog.
 *
 * Discovery and execution used to share one budget, so a run could spend every
 * round finding the right tool and have none left to call it — the loop found
 * `place_media` on round 10 and gave up on round 11 without a single write. A
 * round whose calls were all discovery does not advance the user's request, so
 * it is refunded rather than charged, up to this cap. The cap is what keeps a
 * model that only ever searches from looping forever.
 */
export const LOCAL_DIRECTOR_MAX_DISCOVERY_ROUNDS = 8
/** Tools that only inspect the catalog, so a round spent on them changes nothing. */
const DISCOVERY_TOOL_NAMES = new Set(['tool_search', 'tool_describe'])

/** Chinese for the codes this loop raises; anything else keeps the raw code. */
const DIRECTOR_FAILURE_TEXT: Record<string, string> = {
  LOCAL_DIRECTOR_TURN_FAILED: '这次请求没能送达云端，或者云端拒绝了它。',
  LOCAL_DIRECTOR_LEASE_LOST: '这条时间轴正被另一个任务占用，请稍后重试。',
  LOCAL_DIRECTOR_MAX_TOOL_CALLS_EXCEEDED: '这一步要做的操作太多了，请把要求拆小一些再试。',
  LOCAL_DIRECTOR_BUDGET_EXHAUSTED: '这个任务的步骤数用完了，请把要求拆小一些再试。',
}

/**
 * The code alone tells the user nothing, but it is what they screenshot, so it
 * is kept alongside the explanation rather than replaced by it.
 */
function describeDirectorFailure(errorCode: string): string {
  const explanation = DIRECTOR_FAILURE_TEXT[errorCode]
  return explanation ? `${explanation}（${errorCode}）` : `请求失败：${errorCode}`
}

/**
 * Redacts anything credential-shaped before an error message is persisted.
 *
 * Upstream text arrives here verbatim — including whole HTML error pages — so a
 * signed URL's query string is a real leak vector, even though the bearer key
 * itself only ever travels in a request header.
 */
function scrubErrorMessage(message: string): string {
  return message
    .replace(/[?#][^\s]*/g, '')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/**
 * Node's fetch reports transport failures as a bare `TypeError: fetch failed`
 * and hides the real reason on `cause`, so reading only `message` would
 * reproduce the very ambiguity this exists to remove.
 */
function extractErrorMessage(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.message) parts.push(current.message)
      current = current.cause
      continue
    }
    if (typeof current === 'string') parts.push(current)
    break
  }
  return scrubErrorMessage(parts.join(' | ')) || 'Unknown error'
}

export type LocalDirectorToolAccess = 'read' | 'write'

export interface LocalDirectorToolCall {
  id: string
  name: string
  arguments?: AgentJsonValue
}

export interface LocalDirectorToolReceipt {
  callId: string
  toolName: string
  status: 'succeeded' | 'failed'
  /**
   * The call's own arguments. Recorded because a receipt without them cannot be
   * learned from: a model that sees only `tool_search → count: 0` has no way to
   * tell whether to reword the query or abandon the approach, so it rewords
   * forever. With the arguments it can see what it already tried.
   */
  arguments?: AgentJsonValue
  output?: AgentJsonValue
  errorCode?: string
  /**
   * The tool's own failure text. An error code alone rarely says what to do
   * differently — `NO_MEDIA_IMPORTED` does not tell the model that the folder
   * held eight unsupported files, but the message does.
   */
  message?: string
}

export interface LocalDirectorTool {
  name: string
  access: LocalDirectorToolAccess
  description?: string
  execute?: (
    call: LocalDirectorToolCall,
    signal: AbortSignal,
  ) => Promise<AgentJsonValue | undefined>
}

export interface LocalDirectorTurnContext {
  run: AgentRunRecord
  round: number
  contextPack: AgentContextPack
  toolReceipts: LocalDirectorToolReceipt[]
}

export type LocalDirectorTurnResult =
  | {
      outcome: 'tool_calls'
      assistantText?: string
      toolCalls: LocalDirectorToolCall[]
    }
  | {
      outcome: 'final'
      assistantText: string
      output?: AgentJsonValue
    }

export interface LocalDirectorLoopDependencies {
  runtime: AgentRuntimeService
  tools: LocalDirectorTool[]
  runTurn: (
    context: LocalDirectorTurnContext,
    tools: LocalDirectorTool[],
    signal: AbortSignal,
  ) => Promise<LocalDirectorTurnResult>
  now?: () => number
  createId?: () => string
}

export interface LocalDirectorLoopInput {
  runId: string
  holderId: string
  snapshotId: string
  fingerprint: string
  leaseTtlMs?: number
  signal?: AbortSignal
  /**
   * Round to resume from, and the discovery refunds already earned.
   *
   * An approved write returns control to the caller mid-loop, and the caller
   * re-enters here once the write lands. Without carrying the budget the round
   * counter would reset on every approval, so a task that keeps asking for
   * writes could run without bound.
   */
  resume?: LocalDirectorResumeState
}

export interface LocalDirectorResumeState {
  round: number
  discoveryRounds: number
  receipts: LocalDirectorToolReceipt[]
}

export type LocalDirectorLoopResult =
  | {
      status: 'completed'
      run: AgentRunRecord
      assistantText: string
    }
  | {
      status: 'waiting_approval'
      runId: string
      approval: LocalDirectorToolCall
      /**
       * The budget state to hand back to `run` after the write lands. Carrying
       * it is what keeps a multi-approval task bounded by the same round budget
       * as a single-approval one.
       */
      resume: LocalDirectorResumeState
    }
  | {
      status: 'failed' | 'cancelled'
      run: AgentRunRecord
      errorCode: string
      /**
       * What to show the user, in place of the raw error code.
       *
       * A code alone sent one 400 ("recentMessages too long") and one 404
       * (missing route) to the chat as the same opaque string, so neither was
       * diagnosable from a screenshot.
       */
      assistantText: string
    }

export class LocalDirectorLoop {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly toolsByName: Map<string, LocalDirectorTool>
  private nextSequence = 0

  constructor(private readonly dependencies: LocalDirectorLoopDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => globalThis.crypto.randomUUID())
    this.toolsByName = new Map(dependencies.tools.map((tool) => [tool.name, tool]))
  }

  async run(input: LocalDirectorLoopInput): Promise<LocalDirectorLoopResult> {
    const run = await this.getRunningRun(input.runId)
    await this.initializeTurnSequence(run.threadId)
    const signal = input.signal ?? new AbortController().signal
    const receipts: LocalDirectorToolReceipt[] = [...(input.resume?.receipts ?? [])]
    // Counts rounds that only searched the catalog, so they can be refunded
    // against the round budget without letting a search-only run go unbounded.
    let discoveryRounds = input.resume?.discoveryRounds ?? 0
    const firstRound = input.resume ? input.resume.round + 1 : 1

    for (
      let round = firstRound;
      round <= LOCAL_DIRECTOR_MAX_ROUNDS + discoveryRounds;
      round += 1
    ) {
      if (signal.aborted) {
        return this.finishCancelled(run, input.holderId, round)
      }
      if (input.leaseTtlMs) {
        try {
          await this.dependencies.runtime.renewLease({
            timelineId: run.timelineId,
            holderId: input.holderId,
            runId: run.id,
            fence: this.requireFence(run),
            ttlMs: input.leaseTtlMs,
          })
        } catch {
          return this.finishFailed(run, input.holderId, 'LOCAL_DIRECTOR_LEASE_LOST', round)
        }
      }

      let turn: LocalDirectorTurnResult
      try {
        turn = await this.dependencies.runTurn(
          {
            run,
            round,
            contextPack: await this.dependencies.runtime.buildContextPack({
              threadId: run.threadId,
              runId: run.id,
              snapshotId: input.snapshotId,
              fingerprint: input.fingerprint,
            }),
            toolReceipts: [...receipts],
          },
          this.dependencies.tools,
          signal,
        )
      } catch (error) {
        if (signal.aborted) return this.finishCancelled(run, input.holderId, round)
        // The message is the whole diagnosis. Dropping it once turned a one-line
        // server rejection into a full forensic investigation, so it is recorded
        // even though the chat shows only the friendly text.
        return this.finishFailed(run, input.holderId, this.errorCode(error), round, {
          message: extractErrorMessage(error),
        })
      }

      if (turn.outcome === 'final') {
        const records = [
          this.createTurn(run, 'assistant', turn.assistantText),
          this.createEvent(run, 'directorFinal', { round }),
        ]
        const completed = await this.dependencies.runtime.completeRun({
          runId: run.id,
          timelineId: run.timelineId,
          holderId: input.holderId,
          fence: this.requireFence(run),
          status: 'succeeded',
          output: turn.output ?? { assistantText: turn.assistantText },
          additionalRecords: records,
        })
        return {
          status: 'completed',
          run: completed,
          assistantText: turn.assistantText,
        }
      }

      if (turn.toolCalls.length > LOCAL_DIRECTOR_MAX_TOOL_CALLS_PER_ROUND) {
        return this.finishFailed(
          run,
          input.holderId,
          'LOCAL_DIRECTOR_MAX_TOOL_CALLS_EXCEEDED',
          round,
          { requested: turn.toolCalls.length },
        )
      }

      if (turn.assistantText) {
        await this.dependencies.runtime.putRecords({
          records: [this.createTurn(run, 'assistant', turn.assistantText)],
        })
      }

      for (const call of turn.toolCalls) {
        if (signal.aborted) return this.finishCancelled(run, input.holderId, round)

        const tool = this.toolsByName.get(call.name)
        if (!tool) {
          return this.finishFailed(
            run,
            input.holderId,
            'LOCAL_DIRECTOR_UNKNOWN_TOOL',
            round,
            { toolName: call.name },
          )
        }
        if (tool.access === 'write') {
          if (input.leaseTtlMs) {
            try {
              await this.dependencies.runtime.renewLease({
                timelineId: run.timelineId,
                holderId: input.holderId,
                runId: run.id,
                fence: this.requireFence(run),
                ttlMs: input.leaseTtlMs,
              })
            } catch {
              return this.finishFailed(run, input.holderId, 'LOCAL_DIRECTOR_LEASE_LOST', round)
            }
          }
          await this.dependencies.runtime.putRecords({
            records: [
              this.createEvent(run, 'approvalRequested', {
                round,
                callId: call.id,
                toolName: call.name,
                arguments: call.arguments ?? null,
              }),
              {
                kind: 'checkpoint',
                id: this.createId(),
                threadId: run.threadId,
                runId: run.id,
                snapshotId: input.snapshotId,
                fingerprint: input.fingerprint,
                snapshot: {
                  round,
                  state: 'waiting_approval',
                  callId: call.id,
                  toolName: call.name,
                },
                createdAt: this.now(),
                updatedAt: this.now(),
              },
            ],
          })
          return {
            status: 'waiting_approval',
            runId: run.id,
            approval: call,
            resume: { round, discoveryRounds, receipts: [...receipts] },
          }
        }
        if (!tool.execute) {
          return this.finishFailed(
            run,
            input.holderId,
            'LOCAL_DIRECTOR_READ_TOOL_UNAVAILABLE',
            round,
            { toolName: call.name },
          )
        }

        let receipt: LocalDirectorToolReceipt
        try {
          receipt = {
            callId: call.id,
            toolName: call.name,
            status: 'succeeded',
            ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
            output: await tool.execute(call, signal),
          }
          await this.persistReceipt(run, receipt, round, input)
        } catch {
          receipt = {
            callId: call.id,
            toolName: call.name,
            status: 'failed',
            ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
            errorCode: signal.aborted
              ? 'LOCAL_DIRECTOR_CANCELLED'
              : 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
          }
          try {
            await this.persistReceipt(run, receipt, round, input)
          } catch {}
          if (signal.aborted) return this.finishCancelled(run, input.holderId, round)
          return this.finishFailed(
            run,
            input.holderId,
            'LOCAL_DIRECTOR_READ_TOOL_FAILED',
            round,
            { toolName: call.name },
          )
        }

        receipts.push(receipt)
        if (signal.aborted) return this.finishCancelled(run, input.holderId, round)
      }

      // Refund a round that only inspected the catalog. Checked after the calls
      // ran so an approval or failure returns first and cannot earn a refund.
      if (
        discoveryRounds < LOCAL_DIRECTOR_MAX_DISCOVERY_ROUNDS &&
        turn.toolCalls.length > 0 &&
        turn.toolCalls.every((call) => DISCOVERY_TOOL_NAMES.has(call.name))
      ) {
        discoveryRounds += 1
      }
    }

    return this.finishFailed(
      run,
      input.holderId,
      'LOCAL_DIRECTOR_MAX_ROUNDS_EXCEEDED',
      LOCAL_DIRECTOR_MAX_ROUNDS + discoveryRounds,
      { discoveryRounds },
    )
  }

  private async persistReceipt(
    run: AgentRunRecord,
    receipt: LocalDirectorToolReceipt,
    round: number,
    input: LocalDirectorLoopInput,
  ): Promise<void> {
    await this.dependencies.runtime.putRecords({
      records: [
        this.createTurn(run, 'tool', JSON.stringify(receipt)),
        this.createEvent(run, 'toolReceipt', this.createReceiptPayload(receipt, round)),
        {
          kind: 'checkpoint',
          id: this.createId(),
          threadId: run.threadId,
          runId: run.id,
          snapshotId: input.snapshotId,
          fingerprint: input.fingerprint,
          snapshot: {
            round,
            callId: receipt.callId,
            toolName: receipt.toolName,
            status: receipt.status,
          },
          createdAt: this.now(),
          updatedAt: this.now(),
        },
      ],
    })
  }

  private async finishCancelled(
    run: AgentRunRecord,
    holderId: string,
    round: number,
  ): Promise<LocalDirectorLoopResult> {
    const completed = await this.dependencies.runtime.completeRun({
      runId: run.id,
      timelineId: run.timelineId,
      holderId,
      fence: this.requireFence(run),
      status: 'cancelled',
      errorCode: 'LOCAL_DIRECTOR_CANCELLED',
      additionalRecords: [
        this.createTurn(run, 'assistant', '请求已取消。'),
        this.createEvent(run, 'directorCancelled', {
          round,
          errorCode: 'LOCAL_DIRECTOR_CANCELLED',
        }),
      ],
    })
    return {
      status: 'cancelled',
      run: completed,
      errorCode: 'LOCAL_DIRECTOR_CANCELLED',
      assistantText: '请求已取消。',
    }
  }

  private async finishFailed(
    run: AgentRunRecord,
    holderId: string,
    errorCode: string,
    round: number,
    detail?: AgentJsonValue,
  ): Promise<LocalDirectorLoopResult> {
    const completed = await this.dependencies.runtime.completeRun({
      runId: run.id,
      timelineId: run.timelineId,
      holderId,
      fence: this.requireFence(run),
      status: 'failed',
      errorCode,
      additionalRecords: [
        this.createTurn(run, 'assistant', describeDirectorFailure(errorCode)),
        this.createEvent(run, 'directorFailed', {
          round,
          errorCode,
          detail: detail ?? null,
        }),
      ],
    })
    return {
      status: 'failed',
      run: completed,
      errorCode,
      assistantText: describeDirectorFailure(errorCode),
    }
  }

  private async getRunningRun(runId: string): Promise<AgentRunRecord> {
    const record = await this.dependencies.runtime.store.getRecord('run', runId)
    if (!record || record.kind !== 'run' || record.status !== 'running') {
      throw new Error(`Local Director requires a running Agent run: ${runId}`)
    }
    return record
  }

  private requireFence(run: AgentRunRecord): number {
    if (!run.fence) throw new Error(`Local Director run is missing a fence: ${run.id}`)
    return run.fence
  }

  private errorCode(error: unknown): string {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{1,127}$/.test(error.code)
    ) {
      return error.code
    }
    return 'LOCAL_DIRECTOR_TURN_FAILED'
  }

  private createTurn(
    run: AgentRunRecord,
    role: 'assistant' | 'tool',
    body: string,
  ): AgentRuntimeRecord {
    return {
      kind: 'turn',
      id: this.createId(),
      threadId: run.threadId,
      role,
      body,
      sequence: this.nextSequence++,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
  }

  private createEvent(
    run: AgentRunRecord,
    eventType: string,
    payload?: AgentJsonValue,
  ): AgentRuntimeRecord {
    return {
      kind: 'event',
      id: this.createId(),
      threadId: run.threadId,
      runId: run.id,
      eventType,
      payload,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
  }

  private createReceiptPayload(
    receipt: LocalDirectorToolReceipt,
    round: number,
  ): AgentJsonValue {
    return {
      round,
      callId: receipt.callId,
      toolName: receipt.toolName,
      status: receipt.status,
      ...(receipt.arguments === undefined ? {} : { arguments: receipt.arguments }),
      ...(receipt.output === undefined ? {} : { output: receipt.output }),
      ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
    }
  }

  private async initializeTurnSequence(threadId: string): Promise<void> {
    const turns = await this.dependencies.runtime.listRecords({
      threadId,
      kinds: ['turn'],
      limit: Number.MAX_SAFE_INTEGER,
    })
    this.nextSequence =
      turns.records
        .filter((record) => record.kind === 'turn')
        .reduce((maximum, record) => Math.max(maximum, record.sequence), -1) + 1
  }
}
