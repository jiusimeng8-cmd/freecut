// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { AgentRuntimeService } from './agent-runtime-service'
import {
  LOCAL_DIRECTOR_MAX_ROUNDS,
  LocalDirectorLoop,
  type LocalDirectorLoopDependencies,
} from './local-director-loop'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRuntime(now: () => number = () => 1_000): Promise<{
  runtime: AgentRuntimeService
  start: Awaited<ReturnType<AgentRuntimeService['startRun']>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'freecut-local-director-'))
  roots.push(root)
  const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
    logsPath: join(root, 'logs', 'main.log'),
    now,
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
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      {
        kind: 'turn',
        id: 'turn-user-1',
        threadId: 'thread-1',
        role: 'user',
        body: '请检查时间线。',
        sequence: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ],
  })
  const start = await runtime.startRun({
    id: 'run-1',
    threadId: 'thread-1',
    projectId: 'project-1',
    timelineId: 'timeline-1',
    holderId: 'director-1',
    leaseTtlMs: 60_000,
  })
  if (!start.started) throw new Error('Expected Agent run to start.')
  return { runtime, start }
}

function createDependencies(
  runtime: AgentRuntimeService,
  overrides: Partial<LocalDirectorLoopDependencies>,
): LocalDirectorLoopDependencies {
  let nextId = 1
  return {
    runtime,
    tools: [],
    runTurn: async () => ({ outcome: 'final', assistantText: '完成。' }),
    createId: () => `director-record-${nextId++}`,
    now: () => 1_000,
    ...overrides,
  }
}

describe('LocalDirectorLoop', () => {
  it('persists read receipts, events, checkpoints, and reinjects them into the next turn', async () => {
    const { runtime } = await createRuntime()
    const contexts: Parameters<LocalDirectorLoopDependencies['runTurn']>[0][] = []
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        tools: [
          {
            name: 'freecut.timeline.read',
            access: 'read',
            execute: async () => ({ clipCount: 3 }),
          },
        ],
        runTurn: async (context) => {
          contexts.push(context)
          if (context.round === 1) {
            return {
              outcome: 'tool_calls',
              assistantText: '正在读取时间线。',
              toolCalls: [
                {
                  id: 'call-read-1',
                  name: 'freecut.timeline.read',
                },
              ],
            }
          }
          return {
            outcome: 'final',
            assistantText: '时间线共有 3 个片段。',
            output: { clipCount: 3 },
          }
        },
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '时间线共有 3 个片段。',
        run: expect.objectContaining({ status: 'succeeded' }),
      }),
    )
    expect(contexts).toHaveLength(2)
    expect(contexts[1].toolReceipts).toEqual([
      {
        callId: 'call-read-1',
        toolName: 'freecut.timeline.read',
        status: 'succeeded',
        output: { clipCount: 3 },
      },
    ])
    expect(contexts[1].contextPack.recentTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          body: expect.stringContaining('"callId":"call-read-1"'),
        }),
      ]),
    )
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ kind: 'event', eventType: 'toolReceipt' }),
          expect.objectContaining({ kind: 'checkpoint', snapshotId: 'snapshot-1' }),
          expect.objectContaining({ kind: 'run', status: 'succeeded' }),
        ]),
      }),
    )
    await expect(runtime.sandboxStatus('run-1')).resolves.toEqual(
      expect.objectContaining({ exists: false }),
    )
  })

  it('stops at a write tool and requests local approval without executing it', async () => {
    const { runtime } = await createRuntime()
    const execute = vi.fn()
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        tools: [
          {
            name: 'freecut.color.apply_grade',
            access: 'write',
            execute,
          },
        ],
        runTurn: async () => ({
          outcome: 'tool_calls',
          toolCalls: [
            {
              id: 'call-write-1',
              name: 'freecut.color.apply_grade',
              arguments: { preset: 'cinematic' },
            },
          ],
        }),
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    expect(result).toEqual({
      status: 'waiting_approval',
      runId: 'run-1',
      approval: {
        id: 'call-write-1',
        name: 'freecut.color.apply_grade',
        arguments: { preset: 'cinematic' },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    await expect(runtime.listRecords({ threadId: 'thread-1', kinds: ['event', 'run'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'event',
            eventType: 'approvalRequested',
            payload: expect.objectContaining({
              toolName: 'freecut.color.apply_grade',
            }),
          }),
          expect.objectContaining({ kind: 'run', status: 'running' }),
        ]),
      }),
    )
    await expect(runtime.listRecords({ threadId: 'thread-1', kinds: ['checkpoint'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            snapshot: expect.objectContaining({
              state: 'waiting_approval',
              callId: 'call-write-1',
            }),
          }),
        ]),
      }),
    )
  })

  it('renews the lease when a write approval is requested after a long turn', async () => {
    let now = 1_000
    const { runtime } = await createRuntime(() => now)
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        tools: [{ name: 'freecut.timeline.place_media', access: 'write' }],
        runTurn: async () => {
          now = 59_500
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-place-media-1',
                name: 'freecut.timeline.place_media',
                arguments: { mediaIds: ['media-1'], atSeconds: 0 },
              },
            ],
          }
        },
      }),
    )

    await expect(
      loop.run({
        runId: 'run-1',
        holderId: 'director-1',
        snapshotId: 'snapshot-1',
        fingerprint: 'fingerprint-1',
        leaseTtlMs: 60_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'waiting_approval',
      }),
    )

    await expect(runtime.store.getDocument()).resolves.toEqual(
      expect.objectContaining({
        leases: expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-1',
            fence: 1,
            expiresAt: 119_500,
          }),
        ]),
      }),
    )
  })

  it('fails the run and releases its lease after a read tool fails', async () => {
    const { runtime } = await createRuntime()
    const contexts: Parameters<LocalDirectorLoopDependencies['runTurn']>[0][] = []
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        tools: [
          {
            name: 'freecut.timeline.read',
            access: 'read',
            execute: async () => {
              throw new Error('read failed')
            },
          },
        ],
        runTurn: async (context) => {
          contexts.push(context)
          if (context.round === 1) {
            return {
              outcome: 'tool_calls',
              toolCalls: [
                {
                  id: 'call-read-failed-1',
                  name: 'freecut.timeline.read',
                },
              ],
            }
          }
          throw new Error('A second turn must not run after a read failure.')
        },
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
        run: expect.objectContaining({ status: 'failed' }),
      }),
    )
    expect(contexts).toHaveLength(1)
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'event',
            eventType: 'toolReceipt',
            payload: expect.objectContaining({
              status: 'failed',
              errorCode: 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
            }),
          }),
          expect.objectContaining({
            kind: 'checkpoint',
            snapshot: expect.objectContaining({
              status: 'failed',
              callId: 'call-read-failed-1',
            }),
          }),
          expect.objectContaining({
            kind: 'event',
            eventType: 'directorFailed',
            payload: expect.objectContaining({
              errorCode: 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
            }),
          }),
          expect.objectContaining({
            kind: 'run',
            status: 'failed',
            errorCode: 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
          }),
        ]),
      }),
    )
    await expect(
      runtime.acquireLease({
        timelineId: 'timeline-1',
        holderId: 'director-2',
        runId: 'run-2',
        ttlMs: 60_000,
      }),
    ).resolves.toEqual(expect.objectContaining({ acquired: true }))
  })

  it('fails before executing a turn with more than eight tool calls', async () => {
    const { runtime } = await createRuntime()
    const execute = vi.fn()
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        tools: [
          {
            name: 'freecut.timeline.read',
            access: 'read',
            execute,
          },
        ],
        runTurn: async () => ({
          outcome: 'tool_calls',
          toolCalls: Array.from({ length: 9 }, (_, index) => ({
            id: `call-${index + 1}`,
            name: 'freecut.timeline.read',
          })),
        }),
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_DIRECTOR_MAX_TOOL_CALLS_EXCEEDED',
      }),
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('cancels without dispatching a model turn and records a diagnostic event', async () => {
    const { runtime } = await createRuntime()
    const runTurn = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        runTurn,
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
      signal: controller.signal,
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        errorCode: 'LOCAL_DIRECTOR_CANCELLED',
      }),
    )
    expect(runTurn).not.toHaveBeenCalled()
    await expect(runtime.listRecords({ threadId: 'thread-1', kinds: ['event'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            eventType: 'directorCancelled',
            payload: expect.objectContaining({
              errorCode: 'LOCAL_DIRECTOR_CANCELLED',
            }),
          }),
        ]),
      }),
    )
  })

  it('fails after the twelfth non-final turn', async () => {
    const { runtime } = await createRuntime()
    const runTurn = vi.fn(async () => ({
      outcome: 'tool_calls' as const,
      toolCalls: [],
    }))
    const loop = new LocalDirectorLoop(
      createDependencies(runtime, {
        runTurn,
      }),
    )

    const result = await loop.run({
      runId: 'run-1',
      holderId: 'director-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_DIRECTOR_MAX_ROUNDS_EXCEEDED',
      }),
    )
    expect(runTurn).toHaveBeenCalledTimes(LOCAL_DIRECTOR_MAX_ROUNDS)
  })
})
