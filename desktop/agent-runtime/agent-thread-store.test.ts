// @vitest-environment node

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { AgentThreadStore } from './agent-thread-store'
import type { AgentRuntimeRecord } from './agent-thread-types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createStore(options?: { now?: () => number; maxStoreBytes?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'freecut-agent-store-'))
  roots.push(root)
  const store = new AgentThreadStore(root, options)
  await store.initialize()
  return { root, store }
}

function localFirstRecords(now = 1): AgentRuntimeRecord[] {
  const threadId = 'thread-local-first'
  const runId = 'run-local-first'
  return [
    {
      kind: 'thread',
      id: threadId,
      threadId,
      workspaceId: 'workspace-local-first',
      projectId: 'project-local-first',
      title: 'LOCAL_ONLY_THREAD_SENTINEL',
      body: 'LOCAL_ONLY_THREAD_BODY_SENTINEL',
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'run',
      id: runId,
      threadId,
      projectId: 'project-local-first',
      timelineId: 'timeline-local-first',
      status: 'succeeded',
      input: 'LOCAL_ONLY_RUN_INPUT_SENTINEL',
      output: 'LOCAL_ONLY_RUN_OUTPUT_SENTINEL',
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'handoff',
      id: 'handoff-local-first',
      threadId,
      runId,
      version: 1,
      body: 'LOCAL_ONLY_HANDOFF_BODY_SENTINEL',
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'checkpoint',
      id: 'checkpoint-local-first',
      threadId,
      runId,
      snapshotId: 'snapshot-local-first',
      fingerprint: 'fingerprint-local-first',
      snapshot: 'LOCAL_ONLY_CHECKPOINT_SNAPSHOT_SENTINEL',
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'skillLock',
      id: 'skill-lock-local-first',
      threadId,
      schemaVersion: 1,
      taskId: 'task-local-first',
      runId,
      skillId: 'local-first-e2e',
      skillVersion: '2026.07.22',
      skillDigest: 'a'.repeat(64),
      lockHash: 'b'.repeat(64),
      lockedAt: now,
      source: 'cloud',
      workspaceId: 'workspace-local-first',
      projectId: 'project-local-first',
      createdAt: now,
      updatedAt: now,
    },
    {
      kind: 'evidence',
      id: 'evidence-local-first',
      threadId,
      runId,
      artifact: 'LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

describe('AgentThreadStore', () => {
  it('persists the six Local-First acceptance record kinds and reads them after restart', async () => {
    const { root, store } = await createStore()
    await store.putRecords({ records: localFirstRecords() })

    const restarted = new AgentThreadStore(root)
    await restarted.initialize()
    const result = await restarted.listRecords({
      threadId: 'thread-local-first',
      limit: 100,
    })

    expect(result.records.map((record) => record.kind)).toEqual([
      'checkpoint',
      'evidence',
      'handoff',
      'run',
      'skillLock',
      'thread',
    ])
    const serialized = JSON.stringify(result.records)
    for (const sentinel of [
      'LOCAL_ONLY_THREAD_BODY_SENTINEL',
      'LOCAL_ONLY_RUN_INPUT_SENTINEL',
      'LOCAL_ONLY_RUN_OUTPUT_SENTINEL',
      'LOCAL_ONLY_HANDOFF_BODY_SENTINEL',
      'LOCAL_ONLY_CHECKPOINT_SNAPSHOT_SENTINEL',
      'LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL',
    ]) {
      expect(serialized).toContain(sentinel)
    }
  })

  it('keeps a SkillLock immutable after the run starts', async () => {
    const { store } = await createStore()
    const records = localFirstRecords()
    await store.putRecords({ records })
    const lock = records.find((record) => record.kind === 'skillLock')
    expect(lock?.kind).toBe('skillLock')

    await expect(
      store.putRecords({
        records: [
          {
            ...lock!,
            skillVersion: '2026.07.23',
          },
        ],
      }),
    ).rejects.toThrow('SkillLock is immutable')
  })

  it('enforces one writer per timeline and rejects a stale fence after takeover', async () => {
    let now = 1_000
    const { store } = await createStore({ now: () => now })
    const first = await store.acquireLease({
      timelineId: 'timeline-1',
      holderId: 'holder-1',
      runId: 'run-1',
      ttlMs: 1_000,
    })
    expect(first.acquired).toBe(true)
    if (!first.acquired) throw new Error('Expected first lease.')

    await expect(
      store.acquireLease({
        timelineId: 'timeline-1',
        holderId: 'holder-2',
        runId: 'run-2',
        ttlMs: 1_000,
      }),
    ).resolves.toEqual(expect.objectContaining({ acquired: false, reason: 'LEASE_HELD' }))

    now = 2_001
    const second = await store.acquireLease({
      timelineId: 'timeline-1',
      holderId: 'holder-2',
      runId: 'run-2',
      ttlMs: 1_000,
    })
    expect(second.acquired).toBe(true)
    if (!second.acquired) throw new Error('Expected takeover lease.')
    expect(second.lease.fence).toBeGreaterThan(first.lease.fence)
    await expect(
      store.assertLease({
        timelineId: 'timeline-1',
        holderId: 'holder-1',
        runId: 'run-1',
        fence: first.lease.fence,
      }),
    ).rejects.toThrow('STALE_FENCE')
  })

  it('marks created work interrupted, dispatched work uncertain, and clears leases on restart', async () => {
    const { root, store } = await createStore()
    const thread = localFirstRecords()[0]!
    const now = 10
    await store.putRecords({
      records: [
        thread,
        {
          kind: 'run',
          id: 'run-created',
          threadId: thread.threadId,
          projectId: 'project-local-first',
          timelineId: 'timeline-created',
          status: 'created',
          createdAt: now,
          updatedAt: now,
        },
        {
          kind: 'run',
          id: 'run-running',
          threadId: thread.threadId,
          projectId: 'project-local-first',
          timelineId: 'timeline-running',
          status: 'running',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await store.acquireLease({
      timelineId: 'timeline-running',
      holderId: 'holder-running',
      runId: 'run-running',
      ttlMs: 10_000,
    })

    const restarted = new AgentThreadStore(root)
    await restarted.initialize()
    const recovery = await restarted.recoverInterrupted()
    const document = await restarted.getDocument()

    expect(recovery).toEqual({
      interruptedRunIds: ['run-created'],
      uncertainRunIds: ['run-running'],
    })
    expect(document.leases).toEqual([])
    expect(document.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'run-created', status: 'interrupted' }),
        expect.objectContaining({ id: 'run-running', status: 'uncertain' }),
      ]),
    )
  })

  it('removes all local content and cannot read it back after explicit cleanup', async () => {
    const { store } = await createStore()
    await store.putRecords({ records: localFirstRecords() })

    await expect(store.cleanupAll()).resolves.toBe(6)
    await expect(stat(store.storePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.listRecords({ limit: 100 })).resolves.toEqual(
      expect.objectContaining({ total: 0, records: [] }),
    )
  })

  it('does not silently replace an invalid authoritative store with an empty one', async () => {
    const { root, store } = await createStore()
    await store.putRecords({ records: localFirstRecords() })
    await writeFile(store.storePath, '{"schemaVersion":1,"records":"invalid"}')

    const restarted = new AgentThreadStore(root)
    await expect(restarted.initialize()).rejects.toThrow()
    await expect(restarted.cleanupAll()).resolves.toBe(0)
    await expect(restarted.listRecords({ limit: 100 })).resolves.toEqual(
      expect.objectContaining({ total: 0, records: [] }),
    )
  })

  it('rejects a capacity overflow without persisting a partial record', async () => {
    const { store } = await createStore({ maxStoreBytes: 256 })
    await expect(
      store.putRecords({
        records: [
          {
            kind: 'thread',
            id: 'thread-capacity',
            threadId: 'thread-capacity',
            workspaceId: 'workspace-capacity',
            projectId: 'project-capacity',
            body: 'x'.repeat(512),
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ).rejects.toThrow('capacity exceeded')
    await expect(store.listRecords({ limit: 100 })).resolves.toEqual(
      expect.objectContaining({ total: 0, records: [] }),
    )
  })
})
