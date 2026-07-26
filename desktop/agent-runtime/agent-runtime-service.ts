import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentRunSandbox } from './agent-run-sandbox'
import { AgentThreadStore } from './agent-thread-store'
import {
  buildAgentContextPack,
  projectAgentCloudMetadata,
} from './context-pack'
import {
  AGENT_CLOUD_FORBIDDEN_CONTENT_FIELDS,
  AGENT_CLOUD_METADATA_FIELDS,
  AGENT_CONTEXT_PACK_FIELDS,
  AGENT_RUNTIME_CONTRACT_ID,
  AGENT_SANDBOX_MAX_WRITE_BYTES,
  AGENT_THREAD_STORE_HARD_LIMIT_BYTES,
  AGENT_THREAD_STORE_SCHEMA_VERSION,
  type AgentCleanupInput,
  type AgentCleanupResult,
  type AgentCloudMetadataInput,
  type AgentCloudMetadataProjection,
  type AgentCompleteRunInput,
  type AgentContextPack,
  type AgentContextPackInput,
  type AgentEventRecord,
  type AgentLeaseAcquireInput,
  type AgentLeaseAcquireResult,
  type AgentLeaseAssertInput,
  type AgentLeaseReleaseInput,
  type AgentLeaseRenewInput,
  type AgentPutRecordsInput,
  type AgentPutRecordsResult,
  type AgentRecordListInput,
  type AgentRecordListResult,
  type AgentRunRecord,
  type AgentRuntimeInfo,
  type AgentRuntimeRecord,
  type AgentSandboxStatus,
  type AgentSandboxWriteInput,
  type AgentStartRunInput,
  type AgentStartRunResult,
  type AgentTimelineLease,
} from './agent-thread-types'

interface AgentRuntimeServiceOptions {
  logsPath: string
  now?: () => number
  log?: (message: string) => void
  maxStoreBytes?: number
}

const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])

export class AgentRuntimeService {
  readonly store: AgentThreadStore
  readonly sandbox: AgentRunSandbox
  private acceptingWrites = true
  private readonly now: () => number
  private readonly log: (message: string) => void
  /**
   * Notified after every event record is durably stored.
   *
   * The Renderer used to see nothing between "sent" and the final answer, and a
   * multi-round run can take a minute — long enough to read as a hang. Emitting
   * after the write, not before, means a subscriber can never observe an event
   * that a crash would have rolled back.
   */
  private readonly eventListeners = new Set<(event: AgentEventRecord) => void>()

  constructor(
    readonly dataRoot: string,
    private readonly options: AgentRuntimeServiceOptions,
  ) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    this.store = new AgentThreadStore(dataRoot, {
      now: this.now,
      maxStoreBytes: options.maxStoreBytes,
    })
    this.sandbox = new AgentRunSandbox(join(dataRoot, 'sandboxes'))
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true })
    await Promise.all([this.store.initialize(), this.sandbox.initialize()])
    const recovery = await this.store.recoverInterrupted()
    const document = await this.store.getDocument()
    const retainedRunIds = new Set(
      document.records
        .filter((record) => record.kind === 'run' && record.status === 'uncertain')
        .map((record) => record.id),
    )
    const removedSandboxes = await this.sandbox.cleanupExcept(retainedRunIds)
    this.log(
      `initialized contract=${AGENT_RUNTIME_CONTRACT_ID} revision=${document.revision} ` +
        `interrupted=${recovery.interruptedRunIds.length} uncertain=${recovery.uncertainRunIds.length} ` +
        `removedSandboxes=${removedSandboxes}`,
    )
  }

  async getInfo(): Promise<AgentRuntimeInfo> {
    const document = await this.store.getDocument()
    return {
      contractId: AGENT_RUNTIME_CONTRACT_ID,
      schemaVersion: AGENT_THREAD_STORE_SCHEMA_VERSION,
      dataRoot: this.dataRoot,
      storePath: this.store.storePath,
      sandboxRoot: this.sandbox.root,
      logsPath: this.options.logsPath,
      storeRevision: document.revision,
      recordCounts: await this.store.recordCounts(),
      sandboxLifecycle: {
        create: 'run-start',
        cleanup: 'after-durable-terminal-result',
        uncertainRunPolicy: 'retain-for-reconciliation',
      },
      contextPackAllowlist: AGENT_CONTEXT_PACK_FIELDS,
      safeStorageBoundary: {
        storesAgentContent: false,
        stores: ['business-keys', 'device-credentials'],
      },
      timelineWritePolicy: {
        mode: 'single-writer-per-timeline',
        fencing: true,
      },
      cleanupPolicy: {
        explicitOnly: true,
        credentialsPreserved: true,
        cloudRestoreAvailable: false,
      },
      capacityPolicy: {
        durableStoreHardLimitBytes: AGENT_THREAD_STORE_HARD_LIMIT_BYTES,
        sandboxMaxWriteBytes: AGENT_SANDBOX_MAX_WRITE_BYTES,
        automaticContentEviction: false,
      },
      cloudZeroRetention: {
        persistedMetadataAllowlist: AGENT_CLOUD_METADATA_FIELDS,
        forbiddenContentFields: AGENT_CLOUD_FORBIDDEN_CONTENT_FIELDS,
        assertions: [
          'Agent content is persisted only in the local Thread Store.',
          'Cloud persistence accepts only the metadata allowlist.',
          'ContextPack is transient and must not be written to cloud storage or logs.',
          'Deleting local Agent data cannot restore content from the cloud.',
        ],
      },
    }
  }

  listRecords(input: AgentRecordListInput): Promise<AgentRecordListResult> {
    return this.store.listRecords(input)
  }

  /**
   * Subscribes to event records as they are stored. Returns an unsubscribe.
   */
  onEvent(listener: (event: AgentEventRecord) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  private emitEvents(records: AgentRuntimeRecord[]): void {
    if (this.eventListeners.size === 0) return
    for (const record of records) {
      if (record.kind !== 'event') continue
      for (const listener of this.eventListeners) {
        // One bad subscriber must not fail the write that already succeeded.
        try {
          listener(record)
        } catch (error) {
          this.log(`event listener failed: ${String(error)}`)
        }
      }
    }
  }

  async putRecords(input: AgentPutRecordsInput): Promise<AgentPutRecordsResult> {
    this.assertAcceptingWrites()
    const result = await this.store.putRecords(input)
    await Promise.all(
      input.records
        .filter(
          (record): record is AgentRunRecord =>
            record.kind === 'run' && TERMINAL_RUN_STATUSES.has(record.status),
        )
        .map((run) => this.sandbox.cleanup(run.id)),
    )
    this.log(`records stored revision=${result.revision} count=${result.stored.length}`)
    this.emitEvents(input.records)
    return result
  }

  async startRun(input: AgentStartRunInput): Promise<AgentStartRunResult> {
    this.assertAcceptingWrites()
    const leaseResult = await this.store.acquireLease({
      timelineId: input.timelineId,
      holderId: input.holderId,
      runId: input.id,
      ttlMs: input.leaseTtlMs,
    })
    if (!leaseResult.acquired) {
      return {
        started: false,
        reason: leaseResult.reason,
        lease: leaseResult.lease,
      }
    }

    try {
      await this.sandbox.create(input.id)
    } catch (error) {
      await this.store.releaseLease({
        timelineId: input.timelineId,
        holderId: input.holderId,
        runId: input.id,
        fence: leaseResult.lease.fence,
      })
      throw error
    }
    const now = this.now()
    const run: AgentRunRecord = {
      kind: 'run',
      id: input.id,
      threadId: input.threadId,
      projectId: input.projectId,
      timelineId: input.timelineId,
      status: 'running',
      input: input.input,
      smokeRunId: input.smokeRunId,
      fence: leaseResult.lease.fence,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    }
    try {
      const stored = await this.store.putRecords(
        { records: [run] },
        {
          timelineId: input.timelineId,
          holderId: input.holderId,
          runId: input.id,
          fence: leaseResult.lease.fence,
        },
      )
      this.log(
        `run started runId=${run.id} threadId=${run.threadId} timelineId=${run.timelineId} ` +
          `fence=${leaseResult.lease.fence}`,
      )
      return {
        started: true,
        run,
        lease: leaseResult.lease,
        revision: stored.revision,
      }
    } catch (error) {
      await Promise.all([
        this.sandbox.cleanup(input.id),
        this.store.releaseLease({
          timelineId: input.timelineId,
          holderId: input.holderId,
          runId: input.id,
          fence: leaseResult.lease.fence,
        }),
      ])
      throw error
    }
  }

  async completeRun(input: AgentCompleteRunInput): Promise<AgentRunRecord> {
    this.assertAcceptingWrites()
    const current = await this.store.getRecord('run', input.runId)
    if (!current || current.kind !== 'run') throw new Error(`Unknown Agent run: ${input.runId}`)
    const now = this.now()
    const completed: AgentRunRecord = {
      ...current,
      status: input.status,
      output: input.output,
      errorCode: input.errorCode,
      updatedAt: now,
      finishedAt: input.status === 'uncertain' ? undefined : now,
    }
    await this.store.putRecords(
      {
        records: [completed, ...(input.additionalRecords ?? [])],
      },
      {
        timelineId: input.timelineId,
        holderId: input.holderId,
        runId: input.runId,
        fence: input.fence,
      },
    )
    if (input.status !== 'uncertain') {
      await this.store.releaseLease({
        timelineId: input.timelineId,
        holderId: input.holderId,
        runId: input.runId,
        fence: input.fence,
      })
      await this.sandbox.cleanup(input.runId)
    }
    this.log(
      `run completed runId=${input.runId} status=${input.status} fence=${input.fence}`,
    )
    // completeRun writes through the store directly (it needs the fence), so it
    // has to emit for itself — the terminal `directorFinal`/`directorFailed`
    // events ride along here and are exactly the ones the UI waits for.
    this.emitEvents(input.additionalRecords ?? [])
    return completed
  }

  async buildContextPack(input: AgentContextPackInput): Promise<AgentContextPack> {
    return buildAgentContextPack(await this.store.getDocument(), input)
  }

  projectCloudMetadata(input: AgentCloudMetadataInput): AgentCloudMetadataProjection {
    return projectAgentCloudMetadata(input)
  }

  acquireLease(input: AgentLeaseAcquireInput): Promise<AgentLeaseAcquireResult> {
    this.assertAcceptingWrites()
    return this.store.acquireLease(input)
  }

  renewLease(input: AgentLeaseRenewInput): Promise<AgentTimelineLease> {
    this.assertAcceptingWrites()
    return this.store.renewLease(input)
  }

  releaseLease(input: AgentLeaseReleaseInput): Promise<boolean> {
    this.assertAcceptingWrites()
    return this.store.releaseLease(input)
  }

  assertLease(input: AgentLeaseAssertInput): Promise<AgentTimelineLease> {
    return this.store.assertLease(input)
  }

  async writeSandbox(input: AgentSandboxWriteInput): Promise<number> {
    this.assertAcceptingWrites()
    const run = await this.store.getRecord('run', input.runId)
    if (!run || run.kind !== 'run' || run.status !== 'running') {
      throw new Error('Agent sandbox writes require a running Run.')
    }
    return this.sandbox.write(input)
  }

  sandboxStatus(runId: string): Promise<AgentSandboxStatus> {
    return this.sandbox.status(runId)
  }

  async cleanup(input: AgentCleanupInput): Promise<AgentCleanupResult> {
    this.assertAcceptingWrites()
    if (input.scope === 'all') {
      const removedRecords = await this.store.cleanupAll()
      const removedSandboxes = await this.sandbox.cleanupAll()
      this.log(
        `cleanup scope=all removedRecords=${removedRecords} removedSandboxes=${removedSandboxes}`,
      )
      return {
        scope: 'all',
        removedRecords,
        removedSandboxes,
        credentialsPreserved: true,
        cloudRestoreAvailable: false,
      }
    }

    const document = await this.store.getDocument()
    const runIds = document.records
      .filter((record) => record.threadId === input.threadId)
      .filter((record) => record.kind === 'run')
      .map((record) => record.id)
    const removedRecords = await this.store.cleanupThread(input.threadId)
    const removedSandboxFlags = await Promise.all(
      runIds.map((runId) => this.sandbox.cleanup(runId)),
    )
    const removedSandboxes = removedSandboxFlags.filter(Boolean).length
    this.log(
      `cleanup scope=thread threadId=${input.threadId} removedRecords=${removedRecords} ` +
        `removedSandboxes=${removedSandboxes}`,
    )
    return {
      scope: 'thread',
      removedRecords,
      removedSandboxes,
      credentialsPreserved: true,
      cloudRestoreAvailable: false,
    }
  }

  async dispose(): Promise<void> {
    this.acceptingWrites = false
    await this.store.flush()
  }

  private assertAcceptingWrites(): void {
    if (!this.acceptingWrites) throw new Error('Agent Runtime is shutting down.')
  }
}
