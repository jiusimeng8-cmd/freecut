// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { AgentRuntimeService } from '../agent-runtime'
import { BridgeError } from '../bridge/bridge-service'
import type { DesktopBridgeToolDescriptor } from '../desktop-types'
import { LocalAgentHostService, type AgentTurnTransport } from './local-agent-host-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRuntime(seed = true): Promise<AgentRuntimeService> {
  const root = await mkdtemp(join(tmpdir(), 'freecut-local-agent-host-'))
  roots.push(root)
  const runtime = new AgentRuntimeService(join(root, 'agent-runtime'), {
    logsPath: join(root, 'logs', 'main.log'),
    now: () => 1_000,
  })
  await runtime.initialize()
  if (!seed) return runtime
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
        body: '请读取时间线。',
        sequence: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ],
  })
  return runtime
}

function bridge(tools: DesktopBridgeToolDescriptor[], result: unknown = { clipCount: 3 }) {
  return {
    tools: vi.fn(() => tools),
    call: vi.fn(async () => result),
  }
}

function transport(
  run: AgentTurnTransport['run'],
): AgentTurnTransport {
  return { run: vi.fn(run) }
}

function input(signal?: AbortSignal) {
  return {
    runId: 'run-1',
    profileId: 'editing-director-v2',
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    timelineId: 'timeline-1',
    snapshotId: 'snapshot-1',
    fingerprint: 'fingerprint-1',
    holderId: 'holder-1',
    leaseTtlMs: 60_000,
    userMessage: '请读取时间线。',
    signal,
  }
}

describe('LocalAgentHostService', () => {
  it('executes a read tool, reinjects its receipt, and forwards the configured profile', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        description: 'Read the current timeline.',
        inputSchema: { type: 'object' },
        annotations: { title: 'Read timeline', readOnlyHint: true, requiresProject: true },
        _meta: {
          'freecut/category': { id: 'timeline', title: 'Timeline', group: 'editing' },
        },
      },
    ])
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const localTransport = transport(async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        return {
          outcome: 'tool_calls',
          assistantText: '正在读取时间线。',
          toolCalls: [{ id: 'call-read-1', name: 'read_timeline' }],
        }
      }
      return {
        outcome: 'final',
        assistantText: '时间线共有 3 个片段。',
        output: { clipCount: 3 },
      }
    })
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: localTransport,
      createId: (() => {
        let value = 0
        return () => `host-${++value}`
      })(),
      now: () => 1_000,
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '时间线共有 3 个片段。',
      }),
    )

    expect(localBridge.call).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_timeline',
        projectId: 'project-1',
      }),
    )
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(
      expect.objectContaining({
        request: expect.objectContaining({
          turnId: expect.any(String),
          profileId: 'editing-director-v2',
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'read_timeline',
              readOnly: true,
              category: 'timeline',
            }),
          ]),
        }),
      }),
    )
    expect(requests[1].request.context.recentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining('"callId":"call-read-1"'),
        }),
      ]),
    )
    await expect(runtime.listRecords({ threadId: 'thread-1', kinds: ['turn'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ role: 'user', body: '请读取时间线。', sequence: 1 }),
        ]),
      }),
    )
  })

  it('projects renderer read results to strict JSON before persisting the receipt', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [
        {
          name: 'read_timeline',
          description: 'Read the current timeline.',
          annotations: { title: 'Read timeline', readOnlyHint: true },
        },
      ],
      {
        structuredContent: {
          tracks: [
            {
              id: 'track-1',
              data: {
                isGroup: undefined,
                parentTrackId: undefined,
                isCollapsed: false,
              },
            },
          ],
        },
      },
    )
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [{ id: 'read-1', name: 'read_timeline' }],
          }
        }
        return {
          outcome: 'final',
          assistantText: '读取完成。',
        }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '读取完成。',
      }),
    )
    expect(requests[1].request.context.recentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining(
            '"data":{"isCollapsed":false}',
          ),
        }),
      ]),
    )
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'event',
            eventType: 'toolReceipt',
            payload: expect.objectContaining({
              output: {
                structuredContent: {
                  tracks: [
                    {
                      id: 'track-1',
                      data: { isCollapsed: false },
                    },
                  ],
                },
              },
            }),
          }),
          expect.objectContaining({
            kind: 'run',
            status: 'succeeded',
          }),
        ]),
      }),
    )
  })

  it('terminally fails and releases the lease when a read result is not serializable', async () => {
    const runtime = await createRuntime()
    const circular: { self?: unknown } = {}
    circular.self = circular
    const localBridge = bridge(
      [
        {
          name: 'read_timeline',
          description: 'Read the current timeline.',
          annotations: { title: 'Read timeline', readOnlyHint: true },
        },
      ],
      circular,
    )
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [{ id: 'read-1', name: 'read_timeline' }],
      })),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_DIRECTOR_READ_TOOL_FAILED',
        run: expect.objectContaining({ status: 'failed' }),
      }),
    )
    expect(localBridge.call).toHaveBeenCalledTimes(1)
    await expect(
      runtime.acquireLease({
        timelineId: 'timeline-1',
        holderId: 'holder-2',
        runId: 'run-2',
        ttlMs: 60_000,
      }),
    ).resolves.toEqual(expect.objectContaining({ acquired: true }))
  })

  it('keeps a large tool catalog out of the first turn and discloses search hits next', async () => {
    const runtime = await createRuntime()
    const catalog: DesktopBridgeToolDescriptor[] = [
      {
        name: 'read_timeline',
        description: 'Read the current timeline.',
        annotations: { title: 'Read timeline', readOnlyHint: true },
        _meta: {
          'freecut/category': { id: 'timeline', title: 'Timeline', group: 'editing' },
        },
      },
      {
        name: 'apply_color_grade',
        description: 'Apply a color grade to selected clips.',
        inputSchema: {
          type: 'object',
          properties: { preset: { type: 'string' } },
        },
        annotations: { title: 'Apply color grade', destructiveHint: true },
        _meta: {
          'freecut/category': { id: 'color', title: 'Color', group: 'creative' },
        },
      },
      ...Array.from({ length: 168 }, (_, index) => ({
        name: `catalog_tool_${index}`,
        description: `Catalog tool ${index}.`,
        annotations: { title: `Catalog tool ${index}` },
        _meta: {
          'freecut/category': {
            id: `category_${index % 12}`,
            title: `Category ${index % 12}`,
            group: 'editing',
          },
        },
      })),
    ]
    const localBridge = bridge(catalog)
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'search-1',
                name: 'tool_search',
                arguments: { query: 'color grade' },
              },
            ],
          }
        }
        return {
          outcome: 'final',
          assistantText: '已找到调色工具。',
        }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '已找到调色工具。',
      }),
    )

    const firstNames = requests[0].request.tools.map((tool) => tool.name)
    const secondNames = requests[1].request.tools.map((tool) => tool.name)
    expect(firstNames).toEqual(['tool_search', 'tool_describe', 'read_timeline'])
    expect(firstNames).not.toContain('apply_color_grade')
    expect(secondNames).toEqual([
      'tool_search',
      'tool_describe',
      'read_timeline',
      'apply_color_grade',
    ])
    expect(requests[1].request.context.recentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining('"name":"apply_color_grade"'),
        }),
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining('"id":"color"'),
        }),
      ]),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
  })

  it('discloses media placement from an underscored add-media-to-timeline search', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'place_media',
        description:
          'Place existing media-library items sequentially at an exact time and track on the timeline.',
        inputSchema: {
          type: 'object',
          properties: { mediaIds: { type: 'array' } },
          required: ['mediaIds'],
        },
        annotations: { title: 'Place media on timeline', destructiveHint: true },
        _meta: {
          'freecut/category': { id: 'media', title: 'Media', group: 'editing' },
        },
      },
    ])
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'search-place-media',
                name: 'tool_search',
                arguments: { query: 'call_search_add_media_to_timeline' },
              },
            ],
          }
        }
        return {
          outcome: 'final',
          assistantText: '已找到媒体放置工具。',
        }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '已找到媒体放置工具。',
      }),
    )

    expect(requests).toHaveLength(2)
    expect(requests[0].request.tools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'tool_describe',
    ])
    expect(requests[1].request.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'place_media',
          inputSchema: expect.objectContaining({
            required: ['mediaIds'],
          }),
        }),
      ]),
    )
    expect(requests[1].request.context.recentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining('"name":"place_media"'),
        }),
      ]),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
  })

  it('discloses one exact tool after a local tool_describe receipt', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'trim_clip',
        description: 'Trim one clip.',
        inputSchema: {
          type: 'object',
          properties: { targetId: { type: 'string' } },
          required: ['targetId'],
        },
        annotations: { title: 'Trim clip', destructiveHint: true },
        _meta: {
          'freecut/category': { id: 'timeline', title: 'Timeline', group: 'editing' },
        },
      },
    ])
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'describe-1',
                name: 'tool_describe',
                arguments: { name: 'trim_clip' },
              },
            ],
          }
        }
        return {
          outcome: 'final',
          assistantText: '已读取裁剪工具说明。',
        }
      }),
    })

    await service.run(input())

    expect(requests[0].request.tools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'tool_describe',
    ])
    expect(requests[1].request.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'trim_clip',
          inputSchema: expect.objectContaining({
            required: ['targetId'],
          }),
        }),
      ]),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
  })

  it('creates the project thread and persists user and assistant turns', async () => {
    const runtime = await createRuntime(false)
    const service = new LocalAgentHostService({
      runtime,
      bridge: bridge([]) as never,
      transport: transport(async () => ({
        outcome: 'final',
        assistantText: '已完成。',
      })),
      createId: (() => {
        let value = 0
        return () => `host-${++value}`
      })(),
      now: () => 1_000,
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '已完成。',
      }),
    )
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'thread',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
          }),
          expect.objectContaining({
            kind: 'turn',
            role: 'user',
            body: '请读取时间线。',
          }),
          expect.objectContaining({
            kind: 'turn',
            role: 'assistant',
            body: '已完成。',
          }),
        ]),
      }),
    )
  })

  it('does not bridge a write tool before local approval', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'freecut.color.apply_grade',
        annotations: { readOnlyHint: false },
      },
    ])
    const localTransport = transport(async () => ({
      outcome: 'tool_calls',
      toolCalls: [
        {
          id: 'call-write-1',
          name: 'freecut.color.apply_grade',
          arguments: { preset: 'cinematic' },
        },
      ],
    }))
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: localTransport,
    })

    await expect(service.run(input())).resolves.toEqual({
      status: 'waiting_approval',
      runId: 'run-1',
      approval: {
        id: 'call-write-1',
        name: 'freecut.color.apply_grade',
        arguments: { preset: 'cinematic' },
      },
    })

    expect(localBridge.call).not.toHaveBeenCalled()
    await expect(runtime.listRecords({ threadId: 'thread-1', kinds: ['event'] })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ eventType: 'approvalRequested' }),
        ]),
      }),
    )
  })

  it('executes an approved write once and persists its receipt and final turn', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'freecut.color.apply_grade',
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ], { changed: true })
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [
          {
            id: 'call-write-1',
            name: 'freecut.color.apply_grade',
            arguments: { preset: 'cinematic' },
          },
        ],
      })),
    })

    await service.run(input())
    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '已执行 freecut.color.apply_grade。',
        run: expect.objectContaining({ status: 'succeeded' }),
      }),
    )

    expect(localBridge.call).toHaveBeenCalledTimes(1)
    expect(localBridge.call).toHaveBeenCalledWith({
      requestId: expect.any(String),
      name: 'freecut.color.apply_grade',
      args: { preset: 'cinematic' },
      projectId: 'project-1',
      allowDestructive: true,
      confirmedByLocalAgent: true,
      timeoutMs: 50_000,
    })
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ eventType: 'approvalGranted' }),
          expect.objectContaining({
            eventType: 'toolReceipt',
            payload: expect.objectContaining({ status: 'succeeded' }),
          }),
          expect.objectContaining({
            kind: 'turn',
            role: 'assistant',
            body: '已执行 freecut.color.apply_grade。',
          }),
        ]),
      }),
    )
  })

  it('returns a recoverable approval-expired result without dispatching a write', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'freecut.timeline.split',
        annotations: { readOnlyHint: false },
      },
    ])
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [{ id: 'call-write-1', name: 'freecut.timeline.split' }],
      })),
    })

    await service.run(input())
    await runtime.releaseLease({
      timelineId: 'timeline-1',
      holderId: 'holder-1',
      runId: 'run-1',
      fence: 1,
    })

    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_AGENT_APPROVAL_EXPIRED',
        assistantText: '本地审批已过期，请重新提交该操作。',
      }),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
  })

  it('cancels a run waiting for approval without executing the write', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'freecut.color.apply_grade',
        annotations: { readOnlyHint: false },
      },
    ])
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [
          {
            id: 'call-write-1',
            name: 'freecut.color.apply_grade',
            arguments: { preset: 'cinematic' },
          },
        ],
      })),
    })

    await service.run(input())
    await expect(
      service.cancel({ runId: 'run-1', holderId: 'holder-1' }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'cancelled',
        assistantText: '请求已取消。',
        run: expect.objectContaining({ status: 'cancelled' }),
      }),
    )

    expect(localBridge.call).not.toHaveBeenCalled()
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ eventType: 'approvalCancelled' }),
          expect.objectContaining({
            kind: 'turn',
            role: 'assistant',
            body: '请求已取消。',
          }),
        ]),
      }),
    )
  })

  it('persists an uncertain approved write without retrying it', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'freecut.color.apply_grade',
        annotations: { readOnlyHint: false },
      },
    ])
    localBridge.call.mockRejectedValueOnce(
      new BridgeError('LOCAL_WRITE_UNCERTAIN', 'Write outcome is unknown.', 'uncertain'),
    )
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [
          {
            id: 'call-write-1',
            name: 'freecut.color.apply_grade',
          },
        ],
      })),
    })

    await service.run(input())
    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'uncertain',
        assistantText: '执行结果不确定：LOCAL_WRITE_UNCERTAIN',
        errorCode: 'LOCAL_WRITE_UNCERTAIN',
        run: expect.objectContaining({ status: 'uncertain' }),
      }),
    )
    expect(localBridge.call).toHaveBeenCalledTimes(1)
  })

  it('cancels an aborted turn without calling the bridge', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        annotations: { readOnlyHint: true },
      },
    ])
    const controller = new AbortController()
    controller.abort()
    const localTransport = transport(async (_request, signal) => {
      expect(signal.aborted).toBe(true)
      throw new Error('cancelled')
    })
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: localTransport,
    })

    await expect(service.run(input(controller.signal))).resolves.toEqual(
      expect.objectContaining({
        status: 'cancelled',
        errorCode: 'LOCAL_DIRECTOR_CANCELLED',
      }),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
  })

  it('finishes the local run with a diagnostic error when the transport fails', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        annotations: { readOnlyHint: true },
      },
    ])
    const localTransport = transport(async () => {
      throw new Error('upstream unavailable')
    })
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: localTransport,
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'LOCAL_DIRECTOR_TURN_FAILED',
        run: expect.objectContaining({ status: 'failed' }),
      }),
    )
    expect(localBridge.call).not.toHaveBeenCalled()
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            kind: 'turn',
            role: 'assistant',
            body: '请求失败：LOCAL_DIRECTOR_TURN_FAILED',
          }),
          expect.objectContaining({
            kind: 'event',
            eventType: 'directorFailed',
          }),
        ]),
      }),
    )
  })
})
