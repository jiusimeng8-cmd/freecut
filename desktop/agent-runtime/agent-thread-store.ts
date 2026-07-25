import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SerializedJsonFile } from '../services/serialized-json-file'
import {
  createEmptyAgentThreadStore,
  parseAgentRuntimeRecord,
  parseAgentThreadStoreDocument,
} from './agent-thread-schema'
import {
  AGENT_THREAD_STORE_HARD_LIMIT_BYTES,
  type AgentLeaseAcquireInput,
  type AgentLeaseAcquireResult,
  type AgentLeaseAssertInput,
  type AgentLeaseReleaseInput,
  type AgentLeaseRenewInput,
  type AgentPutRecordsInput,
  type AgentPutRecordsResult,
  type AgentRecordListInput,
  type AgentRecordListResult,
  type AgentRuntimeRecord,
  type AgentRuntimeRecordKind,
  type AgentThreadStoreDocument,
  type AgentTimelineLease,
} from './agent-thread-types'

const RECORD_KINDS: AgentRuntimeRecordKind[] = [
  'thread',
  'task',
  'turn',
  'run',
  'handoff',
  'event',
  'checkpoint',
  'contextSummary',
  'skillLock',
  'evidence',
]

interface AgentThreadStoreOptions {
  now?: () => number
  maxStoreBytes?: number
}

function recordKey(record: Pick<AgentRuntimeRecord, 'kind' | 'id'>): string {
  return `${record.kind}:${record.id}`
}

function assertSkillLockImmutable(existing: AgentRuntimeRecord, next: AgentRuntimeRecord): void {
  if (existing.kind !== 'skillLock' || next.kind !== 'skillLock') return
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    throw new Error('SkillLock is immutable after a run starts.')
  }
}

function countRecords(records: AgentRuntimeRecord[]): Record<AgentRuntimeRecordKind, number> {
  const counts = Object.fromEntries(RECORD_KINDS.map((kind) => [kind, 0])) as Record<
    AgentRuntimeRecordKind,
    number
  >
  for (const record of records) counts[record.kind] += 1
  return counts
}

export class AgentThreadStore {
  readonly storePath: string
  private file: SerializedJsonFile<AgentThreadStoreDocument>
  private pending: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly maxStoreBytes: number

  constructor(
    readonly dataRoot: string,
    options: AgentThreadStoreOptions = {},
  ) {
    this.storePath = join(dataRoot, 'thread-store.json')
    this.now = options.now ?? Date.now
    this.maxStoreBytes = options.maxStoreBytes ?? AGENT_THREAD_STORE_HARD_LIMIT_BYTES
    this.file = this.createFile()
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(this.dataRoot, { recursive: true })
      await this.file.read()
    })
  }

  async getDocument(): Promise<AgentThreadStoreDocument> {
    return this.enqueue(() => this.file.read())
  }

  async getRecord(kind: AgentRuntimeRecordKind, id: string): Promise<AgentRuntimeRecord | null> {
    return this.enqueue(async () => {
      const document = await this.file.read()
      return document.records.find((record) => record.kind === kind && record.id === id) ?? null
    })
  }

  async listRecords(input: AgentRecordListInput = {}): Promise<AgentRecordListResult> {
    return this.enqueue(async () => {
      const document = await this.file.read()
      const kinds = input.kinds ? new Set(input.kinds) : null
      const records = document.records
        .filter((record) => (!input.threadId || record.threadId === input.threadId) && (!kinds || kinds.has(record.kind)))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      const offset = input.offset ?? 0
      const limit = input.limit ?? 100
      const page = records.slice(offset, offset + limit)
      return {
        revision: document.revision,
        records: page,
        offset,
        nextOffset: offset + page.length < records.length ? offset + page.length : undefined,
        total: records.length,
      }
    })
  }

  async putRecords(
    input: AgentPutRecordsInput,
    leaseAssertion?: AgentLeaseAssertInput,
  ): Promise<AgentPutRecordsResult> {
    const parsedRecords = input.records.map(parseAgentRuntimeRecord)
    return this.enqueue(async () => {
      let stored: Array<{ kind: AgentRuntimeRecordKind; id: string }> = []
      const document = await this.file.update((current) => {
        if (leaseAssertion) {
          const now = this.now()
          const lease = current.leases.find(
            (candidate) =>
              candidate.timelineId === leaseAssertion.timelineId &&
              candidate.holderId === leaseAssertion.holderId &&
              candidate.runId === leaseAssertion.runId &&
              candidate.fence === leaseAssertion.fence &&
              candidate.expiresAt > now,
          )
          if (!lease) throw new Error('STALE_FENCE')
        }
        if (
          input.expectedRevision !== undefined &&
          current.revision !== input.expectedRevision
        ) {
          throw new Error(
            `Agent Thread Store revision mismatch: expected ${input.expectedRevision}, received ${current.revision}.`,
          )
        }

        const records = new Map(current.records.map((record) => [recordKey(record), record]))
        const knownThreads = new Set(
          current.records
            .filter((record) => record.kind === 'thread')
            .map((record) => record.threadId),
        )
        for (const record of parsedRecords) {
          if (record.kind === 'thread') knownThreads.add(record.threadId)
        }
        for (const record of parsedRecords) {
          if (!knownThreads.has(record.threadId)) {
            throw new Error(`Unknown Agent thread: ${record.threadId}`)
          }
          const key = recordKey(record)
          const existing = records.get(key)
          if (existing) assertSkillLockImmutable(existing, record)
          records.set(key, record)
        }

        const nextRecords = [...records.values()]
        const changed =
          parsedRecords.some((record) => {
            const previous = current.records.find(
              (candidate) => candidate.kind === record.kind && candidate.id === record.id,
            )
            return JSON.stringify(previous) !== JSON.stringify(record)
          }) || parsedRecords.some((record) => !current.records.some((candidate) => recordKey(candidate) === recordKey(record)))
        stored = parsedRecords.map((record) => ({ kind: record.kind, id: record.id }))
        if (!changed) return current
        const next = {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.now(),
          records: nextRecords,
        }
        this.assertStoreSize(next)
        return next
      })
      return { revision: document.revision, stored }
    })
  }

  async recoverInterrupted(): Promise<{ interruptedRunIds: string[]; uncertainRunIds: string[] }> {
    return this.enqueue(async () => {
      const interruptedRunIds: string[] = []
      const uncertainRunIds: string[] = []
      await this.file.update((current) => {
        let changed = current.leases.length > 0
        const records = current.records.map((record) => {
          if (record.kind === 'run' && record.status === 'created') {
            changed = true
            interruptedRunIds.push(record.id)
            return {
              ...record,
              status: 'interrupted' as const,
              errorCode: 'APP_RESTARTED_BEFORE_DISPATCH',
              updatedAt: this.now(),
              finishedAt: this.now(),
            }
          }
          if (record.kind === 'run' && record.status === 'running') {
            changed = true
            uncertainRunIds.push(record.id)
            return {
              ...record,
              status: 'uncertain' as const,
              errorCode: 'APP_RESTARTED_AFTER_DISPATCH',
              updatedAt: this.now(),
            }
          }
          if (record.kind === 'task' && (record.status === 'queued' || record.status === 'running')) {
            changed = true
            return {
              ...record,
              status: record.status === 'queued' ? ('interrupted' as const) : ('uncertain' as const),
              errorCode:
                record.status === 'queued'
                  ? 'APP_RESTARTED_BEFORE_DISPATCH'
                  : 'APP_RESTARTED_AFTER_DISPATCH',
              updatedAt: this.now(),
            }
          }
          return record
        })
        return changed
          ? {
              ...current,
              revision: current.revision + 1,
              updatedAt: this.now(),
              records,
              leases: [],
            }
          : current
      })
      return { interruptedRunIds, uncertainRunIds }
    })
  }

  async acquireLease(input: AgentLeaseAcquireInput): Promise<AgentLeaseAcquireResult> {
    return this.enqueue(async () => {
      let result: AgentLeaseAcquireResult | null = null
      await this.file.update((current) => {
        const now = this.now()
        const active = current.leases.find(
          (lease) => lease.timelineId === input.timelineId && lease.expiresAt > now,
        )
        if (
          active &&
          (active.holderId !== input.holderId || active.runId !== input.runId)
        ) {
          result = { acquired: false, reason: 'LEASE_HELD', lease: active }
          return current
        }
        if (active) {
          const lease = { ...active, expiresAt: now + input.ttlMs }
          result = { acquired: true, lease }
          return {
            ...current,
            revision: current.revision + 1,
            updatedAt: now,
            leases: current.leases.map((candidate) =>
              candidate.timelineId === input.timelineId ? lease : candidate,
            ),
          }
        }
        const lease: AgentTimelineLease = {
          timelineId: input.timelineId,
          holderId: input.holderId,
          runId: input.runId,
          fence: current.nextFence,
          acquiredAt: now,
          expiresAt: now + input.ttlMs,
        }
        result = { acquired: true, lease }
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
          leases: [
            ...current.leases.filter((candidate) => candidate.timelineId !== input.timelineId),
            lease,
          ],
          nextFence: current.nextFence + 1,
        }
      })
      if (!result) throw new Error('Timeline lease acquisition did not complete.')
      return result
    })
  }

  async renewLease(input: AgentLeaseRenewInput): Promise<AgentTimelineLease> {
    return this.enqueue(async () => {
      let renewed: AgentTimelineLease | null = null
      await this.file.update((current) => {
        const now = this.now()
        const lease = current.leases.find(
          (candidate) =>
            candidate.timelineId === input.timelineId &&
            candidate.holderId === input.holderId &&
            candidate.runId === input.runId &&
            candidate.fence === input.fence &&
            candidate.expiresAt > now,
        )
        if (!lease) throw new Error('STALE_FENCE')
        renewed = { ...lease, expiresAt: now + input.ttlMs }
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
          leases: current.leases.map((candidate) =>
            candidate.timelineId === input.timelineId ? renewed! : candidate,
          ),
        }
      })
      return renewed!
    })
  }

  async releaseLease(input: AgentLeaseReleaseInput): Promise<boolean> {
    return this.enqueue(async () => {
      let released = false
      await this.file.update((current) => {
        const next = current.leases.filter((lease) => {
          const matches =
            lease.timelineId === input.timelineId &&
            lease.holderId === input.holderId &&
            lease.runId === input.runId &&
            lease.fence === input.fence
          if (matches) released = true
          return !matches
        })
        return released
          ? {
              ...current,
              revision: current.revision + 1,
              updatedAt: this.now(),
              leases: next,
            }
          : current
      })
      return released
    })
  }

  async assertLease(input: AgentLeaseAssertInput): Promise<AgentTimelineLease> {
    return this.enqueue(async () => {
      const now = this.now()
      const document = await this.file.read()
      const lease = document.leases.find(
        (candidate) =>
          candidate.timelineId === input.timelineId &&
          candidate.holderId === input.holderId &&
          candidate.runId === input.runId &&
          candidate.fence === input.fence &&
          candidate.expiresAt > now,
      )
      if (!lease) throw new Error('STALE_FENCE')
      return lease
    })
  }

  async cleanupThread(threadId: string): Promise<number> {
    return this.enqueue(async () => {
      let removed = 0
      await this.file.update((current) => {
        const runIds = new Set(
          current.records
            .filter((record) => record.threadId === threadId && record.kind === 'run')
            .map((record) => record.id),
        )
        const records = current.records.filter((record) => record.threadId !== threadId)
        removed = current.records.length - records.length
        if (removed === 0) return current
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.now(),
          records,
          leases: current.leases.filter((lease) => !runIds.has(lease.runId)),
        }
      })
      return removed
    })
  }

  async cleanupAll(): Promise<number> {
    return this.enqueue(async () => {
      const removedRecords = await this.file
        .read()
        .then((document) => document.records.length)
        .catch(() => 0)
      const entries = await readdir(this.dataRoot).catch(() => [])
      await Promise.all(
        entries
          .filter((name) => name.startsWith('thread-store.json'))
          .map((name) => rm(join(this.dataRoot, name), { force: true })),
      )
      this.file = this.createFile()
      return removedRecords
    })
  }

  async recordCounts(): Promise<Record<AgentRuntimeRecordKind, number>> {
    return countRecords((await this.getDocument()).records)
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      await this.file.read()
    })
  }

  private createFile(): SerializedJsonFile<AgentThreadStoreDocument> {
    return new SerializedJsonFile(this.storePath, () => createEmptyAgentThreadStore(this.now()), {
      parse: parseAgentThreadStoreDocument,
    })
  }

  private assertStoreSize(document: AgentThreadStoreDocument): void {
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > this.maxStoreBytes) {
      throw new Error('Agent Thread Store capacity exceeded.')
    }
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.pending.then(operation, operation)
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
