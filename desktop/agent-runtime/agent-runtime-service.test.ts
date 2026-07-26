// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { AgentRuntimeService } from './agent-runtime-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentRuntimeService', () => {
  it('persists the run result before removing its sandbox and releases the timeline lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-runtime-'))
    roots.push(root)
    let now = 1_000
    const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
      logsPath: join(root, 'logs', 'main.log'),
      now: () => now,
    })
    await runtime.initialize()
    await runtime.putRecords({
      records: [
        {
          kind: 'thread',
          id: 'thread-1',
          threadId: 'thread-1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    const started = await runtime.startRun({
      id: 'run-1',
      threadId: 'thread-1',
      projectId: 'project-1',
      timelineId: 'timeline-1',
      holderId: 'agent-1',
      leaseTtlMs: 10_000,
      input: 'LOCAL_ONLY_RUN_INPUT_SENTINEL',
    })
    expect(started.started).toBe(true)
    if (!started.started) throw new Error('Expected Agent run to start.')
    await runtime.writeSandbox({
      runId: 'run-1',
      path: ['result.json'],
      bytes: new TextEncoder().encode('temporary'),
    })

    now = 2_000
    await runtime.completeRun({
      runId: 'run-1',
      timelineId: 'timeline-1',
      holderId: 'agent-1',
      fence: started.lease.fence,
      status: 'succeeded',
      output: 'LOCAL_ONLY_RUN_OUTPUT_SENTINEL',
      additionalRecords: [
        {
          kind: 'checkpoint',
          id: 'checkpoint-1',
          threadId: 'thread-1',
          runId: 'run-1',
          snapshotId: 'snapshot-1',
          fingerprint: 'fingerprint-1',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    await expect(runtime.sandboxStatus('run-1')).resolves.toEqual(
      expect.objectContaining({ exists: false }),
    )
    await expect(
      runtime.assertLease({
        timelineId: 'timeline-1',
        holderId: 'agent-1',
        runId: 'run-1',
        fence: started.lease.fence,
      }),
    ).rejects.toThrow('STALE_FENCE')
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'run',
            id: 'run-1',
            status: 'succeeded',
            output: 'LOCAL_ONLY_RUN_OUTPUT_SENTINEL',
          }),
          expect.objectContaining({ kind: 'checkpoint', id: 'checkpoint-1' }),
        ]),
      }),
    )
  })

  it('reports the security contract and cleanup keeps credentials outside its deletion scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-runtime-info-'))
    roots.push(root)
    const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
      logsPath: join(root, 'logs', 'main.log'),
    })
    await runtime.initialize()
    const info = await runtime.getInfo()

    expect(info).toEqual(
      expect.objectContaining({
        contractId: 'freecut.agent-runtime.local-first.v1',
        schemaVersion: 1,
        safeStorageBoundary: {
          storesAgentContent: false,
          stores: ['business-keys', 'device-credentials'],
        },
        timelineWritePolicy: {
          mode: 'single-writer-per-timeline',
          fencing: true,
        },
      }),
    )
    await expect(runtime.cleanup({ scope: 'all' })).resolves.toEqual(
      expect.objectContaining({
        credentialsPreserved: true,
        cloudRestoreAvailable: false,
      }),
    )
  })

  it('logs only runtime metadata and never logs stored Agent content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-runtime-logs-'))
    roots.push(root)
    const logs: string[] = []
    const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
      logsPath: join(root, 'logs', 'main.log'),
      log: (message) => logs.push(message),
    })
    await runtime.initialize()
    await runtime.putRecords({
      records: [
        {
          kind: 'thread',
          id: 'thread-log-test',
          threadId: 'thread-log-test',
          workspaceId: 'workspace-log-test',
          projectId: 'project-log-test',
          body: 'LOCAL_ONLY_THREAD_BODY_SENTINEL',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          kind: 'evidence',
          id: 'evidence-log-test',
          threadId: 'thread-log-test',
          artifact: 'LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    expect(logs.join('\n')).not.toContain('LOCAL_ONLY_THREAD_BODY_SENTINEL')
    expect(logs.join('\n')).not.toContain('LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL')
  })

  it('atomically rejects a late completion from a run whose fence was replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-runtime-stale-fence-'))
    roots.push(root)
    let now = 1_000
    const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
      logsPath: join(root, 'logs', 'main.log'),
      now: () => now,
    })
    await runtime.initialize()
    await runtime.putRecords({
      records: [
        {
          kind: 'thread',
          id: 'thread-fence',
          threadId: 'thread-fence',
          workspaceId: 'workspace-fence',
          projectId: 'project-fence',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    const first = await runtime.startRun({
      id: 'run-fence-1',
      threadId: 'thread-fence',
      projectId: 'project-fence',
      timelineId: 'timeline-fence',
      holderId: 'holder-fence-1',
      leaseTtlMs: 1_000,
    })
    if (!first.started) throw new Error('Expected first run to start.')

    now = 2_001
    const second = await runtime.startRun({
      id: 'run-fence-2',
      threadId: 'thread-fence',
      projectId: 'project-fence',
      timelineId: 'timeline-fence',
      holderId: 'holder-fence-2',
      leaseTtlMs: 1_000,
    })
    expect(second.started).toBe(true)

    await expect(
      runtime.completeRun({
        runId: 'run-fence-1',
        timelineId: 'timeline-fence',
        holderId: 'holder-fence-1',
        fence: first.lease.fence,
        status: 'succeeded',
        output: 'late result',
      }),
    ).rejects.toThrow('STALE_FENCE')
    await expect(runtime.listRecords({ threadId: 'thread-fence', kinds: ['run'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            id: 'run-fence-1',
            status: 'running',
          }),
        ]),
      }),
    )
  })

  it('notifies event subscribers for both putRecords and completeRun writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-runtime-events-'))
    roots.push(root)
    const now = 1_000
    const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
      logsPath: join(root, 'logs', 'main.log'),
      now: () => now,
    })
    await runtime.initialize()

    const seen: string[] = []
    const unsubscribe = runtime.onEvent((event) => {
      seen.push(event.eventType)
    })

    await runtime.putRecords({
      records: [
        {
          kind: 'thread',
          id: 'thread-events',
          threadId: 'thread-events',
          workspaceId: 'workspace-events',
          projectId: 'project-events',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    const started = await runtime.startRun({
      id: 'run-events',
      threadId: 'thread-events',
      projectId: 'project-events',
      timelineId: 'timeline-events',
      holderId: 'holder-events',
      leaseTtlMs: 10_000,
    })
    if (!started.started) throw new Error('Expected run to start.')

    await runtime.putRecords({
      records: [
        {
          kind: 'event',
          id: 'event-mid',
          threadId: 'thread-events',
          runId: 'run-events',
          eventType: 'toolReceipt',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    await runtime.completeRun({
      runId: 'run-events',
      timelineId: 'timeline-events',
      holderId: 'holder-events',
      fence: started.lease.fence,
      status: 'succeeded',
      additionalRecords: [
        {
          kind: 'event',
          id: 'event-final',
          threadId: 'thread-events',
          runId: 'run-events',
          eventType: 'directorFinal',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })

    // completeRun writes through the store directly because it needs the fence,
    // so it bypasses putRecords entirely. The terminal event is the one the UI
    // waits for, so a channel that goes quiet exactly there is worse than none.
    expect(seen).toEqual(['toolReceipt', 'directorFinal'])

    unsubscribe()
    await runtime.putRecords({
      records: [
        {
          kind: 'event',
          id: 'event-after',
          threadId: 'thread-events',
          eventType: 'toolReceipt',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    expect(seen).toEqual(['toolReceipt', 'directorFinal'])
  })
})
