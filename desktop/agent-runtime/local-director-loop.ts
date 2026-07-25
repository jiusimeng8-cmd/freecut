import type { AgentRuntimeService } from './agent-runtime-service'
import type {
  AgentContextPack,
  AgentJsonValue,
  AgentRunRecord,
  AgentRuntimeRecord,
} from './agent-thread-types'

export const LOCAL_DIRECTOR_MAX_ROUNDS = 12
export const LOCAL_DIRECTOR_MAX_TOOL_CALLS_PER_ROUND = 8

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
  output?: AgentJsonValue
  errorCode?: string
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
    }
  | {
      status: 'failed' | 'cancelled'
      run: AgentRunRecord
      errorCode: string
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
    const receipts: LocalDirectorToolReceipt[] = []

    for (let round = 1; round <= LOCAL_DIRECTOR_MAX_ROUNDS; round += 1) {
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
        return this.finishFailed(
          run,
          input.holderId,
          this.errorCode(error),
          round,
        )
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
            output: await tool.execute(call, signal),
          }
          await this.persistReceipt(run, receipt, round, input)
        } catch {
          receipt = {
            callId: call.id,
            toolName: call.name,
            status: 'failed',
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
    }

    return this.finishFailed(
      run,
      input.holderId,
      'LOCAL_DIRECTOR_MAX_ROUNDS_EXCEEDED',
      LOCAL_DIRECTOR_MAX_ROUNDS,
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
        this.createTurn(run, 'assistant', `请求失败：${errorCode}`),
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
