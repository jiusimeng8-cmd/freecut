// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { AgentRuntimeService } from '../agent-runtime'
import { BridgeError } from '../bridge/bridge-service'
import type { DesktopBridgeToolDescriptor } from '../desktop-types'
import { AGENT_TURN_SERVER_LIMITS } from './agent-turn-contract'
import {
  LocalAgentHostService,
  type AgentTurnTransport,
  type LocalAgentHostApprovalResult,
} from './local-agent-host-service'
import { LOCAL_AGENT_SYSTEM_PROMPT } from './local-agent-instructions'

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

/**
 * Narrows an approval result to a finished run. An approved write can now pause
 * again on the next write, so tests that assert a terminal outcome have to say
 * which one they expect.
 */
function finished(result: LocalAgentHostApprovalResult) {
  if (result.status === 'waiting_approval') {
    throw new Error('Expected the run to finish, not to pause on another approval.')
  }
  return result
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

  it('discloses media placement from a Chinese add-media-to-timeline search', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'place_media',
        description:
          'Place existing media-library items sequentially at an exact time and track on the timeline.',
        annotations: { title: 'Place media on timeline', destructiveHint: true },
        _meta: {
          'freecut/category': { id: 'media', title: 'Media', group: 'editing' },
        },
      },
      {
        name: 'delete_track',
        description: 'Delete a timeline track and everything on it.',
        annotations: { title: 'Delete timeline track', destructiveHint: true },
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
                id: 'search-zh',
                name: 'tool_search',
                // The exact query from the production run that found nothing.
                arguments: { query: '将媒体库素材添加到时间轴' },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '已找到媒体放置工具。' }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    )

    const receipt = requests[1].request.context.recentMessages.find(
      (message) => message.role === 'tool',
    )
    // A real hit, not the unmatched catalog fallback.
    expect(receipt?.text).toContain('"name":"place_media"')
    expect(receipt?.text).not.toContain('"unmatched":true')
    expect(requests[1].request.tools.map((tool) => tool.name)).toContain('place_media')
  })

  it('falls back to the catalog and says so when a query matches nothing', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'place_media',
        description: 'Place existing media-library items on the timeline.',
        annotations: { title: 'Place media on timeline' },
        _meta: { 'freecut/category': { id: 'media', title: 'Media', group: 'editing' } },
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
                id: 'search-miss',
                name: 'tool_search',
                // Vocabulary the lexicon cannot cover.
                arguments: { query: '帮我弄一下那个东西' },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '完成。' }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    )

    const receipt = requests[1].request.context.recentMessages.find(
      (message) => message.role === 'tool',
    )
    // An empty result reads as "no such tool", which is what drove the model to
    // reword forever. A labelled catalog slice gives it something to act on.
    expect(receipt?.text).toContain('"unmatched":true')
    expect(receipt?.text).toContain('"name":"place_media"')
    expect(receipt?.text).toContain('English')
    // The fallback still discloses, so the tool is usable next round.
    expect(requests[1].request.tools.map((tool) => tool.name)).toContain('place_media')
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

  it('sends the system prompt and the timeline it was given on every turn', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        annotations: { readOnlyHint: true },
      },
    ])
    const summaries: string[] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async ({ request }) => {
        summaries.push(request.context.summary)
        if (summaries.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [{ id: 'call-read-1', name: 'read_timeline' }],
          }
        }
        return { outcome: 'final', assistantText: '共 3 个片段。' }
      }),
      createId: (() => {
        let value = 0
        return () => `host-${++value}`
      })(),
      now: () => 1_000,
    })

    await expect(
      service.run({
        ...input(),
        timelineContext: 'Project: 12.0s long at 60fps.\n  c1 video "a.mp4" 0.0-4.0s',
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'completed' }))

    // Both turns, not just the first: the loop rebuilds the request each round,
    // so grounding that is only sent once is grounding the model loses mid-task.
    expect(summaries).toHaveLength(2)
    for (const summary of summaries) {
      expect(summary).toContain(LOCAL_AGENT_SYSTEM_PROMPT)
      expect(summary).toContain('c1 video "a.mp4" 0.0-4.0s')
    }
  })

  it('tells the model the timeline is unavailable when no context was passed', async () => {
    const runtime = await createRuntime()
    const summaries: string[] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: bridge([]) as never,
      transport: transport(async ({ request }) => {
        summaries.push(request.context.summary)
        return { outcome: 'final', assistantText: '好的。' }
      }),
      createId: (() => {
        let value = 0
        return () => `host-${++value}`
      })(),
      now: () => 1_000,
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    )
    expect(summaries[0]).toContain('Current timeline: unavailable.')
  })

  it('names every tool in the turn prompt so undisclosed ones can still be asked for', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        annotations: { readOnlyHint: true },
        _meta: { 'freecut/category': { id: 'timeline', title: 'Timeline', group: 'editing' } },
      },
      {
        name: 'remove_silence',
        annotations: { readOnlyHint: false },
        _meta: { 'freecut/category': { id: 'discovery', title: 'Discovery', group: 'editing' } },
      },
      {
        name: 'add_transition',
        annotations: { readOnlyHint: false },
        _meta: { 'freecut/category': { id: 'discovery', title: 'Discovery', group: 'editing' } },
      },
    ])
    const summaries: string[] = []
    const requests: Parameters<AgentTurnTransport['run']>[0][] = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async (request) => {
        summaries.push(request.request.context.summary)
        requests.push(request)
        if (summaries.length === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [{ id: 'call-read-1', name: 'read_timeline' }],
          }
        }
        return { outcome: 'final', assistantText: '好的。' }
      }),
      createId: (() => {
        let value = 0
        return () => `host-${++value}`
      })(),
      now: () => 1_000,
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    )

    // Write tools are named here but not callable. That is the point: naming one
    // is what lets the model ask for it by exact name instead of guessing search
    // keywords for a tool it has no way to see.
    expect(summaries).toHaveLength(2)
    for (const summary of summaries) {
      expect(summary).toContain('discovery: add_transition, remove_silence')
      expect(summary).toContain('timeline: read_timeline')
    }
    expect(requests[0].request.tools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'tool_describe',
      'read_timeline',
    ])
  })

  it('discloses a whole request worth of tools in one refunded describe round', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge([
      {
        name: 'read_timeline',
        annotations: { readOnlyHint: true },
        _meta: { 'freecut/category': { id: 'timeline', title: 'Timeline', group: 'editing' } },
      },
      {
        name: 'import_local_media',
        annotations: { readOnlyHint: false },
        _meta: { 'freecut/category': { id: 'media', title: 'Media', group: 'editing' } },
      },
      {
        name: 'place_media',
        annotations: { readOnlyHint: false },
        _meta: { 'freecut/category': { id: 'media', title: 'Media', group: 'editing' } },
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
              { id: 'd-1', name: 'tool_describe', arguments: { name: 'import_local_media' } },
              { id: 'd-2', name: 'tool_describe', arguments: { name: 'place_media' } },
            ],
          }
        }
        return { outcome: 'final', assistantText: '已找到导入与放置工具。' }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({ status: 'completed' }),
    )

    // A two-tool request costs one discovery round, not two. Knowing both names
    // up front is what makes the describes batch; searching would have had to
    // run one query, read the hits, then run the next.
    expect(requests).toHaveLength(2)
    expect(requests[1].request.tools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'tool_describe',
      'read_timeline',
      'import_local_media',
      'place_media',
    ])
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
    let dispatched = 0
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => {
        dispatched += 1
        if (dispatched === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-write-1',
                name: 'freecut.color.apply_grade',
                arguments: { preset: 'cinematic' },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '调色已应用。' }
      }),
    })

    await service.run(input())
    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '调色已应用。',
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
            body: '调色已应用。',
          }),
        ]),
      }),
    )
  })

  it('continues to a second write after the first one is approved', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [
        { name: 'import_media_files', annotations: { readOnlyHint: false } },
        { name: 'place_media', annotations: { readOnlyHint: false } },
      ],
      { ok: true, mediaIds: ['media-1'] },
    )
    let dispatched = 0
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => {
        dispatched += 1
        if (dispatched === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-import-1',
                name: 'import_media_files',
                arguments: { path: 'C:\\clips' },
              },
            ],
          }
        }
        if (dispatched === 2) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-place-1',
                name: 'place_media',
                arguments: { mediaIds: ['media-1'], atSeconds: 0 },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '素材已导入并放上时间轴。' }
      }),
    })

    await expect(service.run(input())).resolves.toEqual(
      expect.objectContaining({
        status: 'waiting_approval',
        approval: expect.objectContaining({ name: 'import_media_files' }),
      }),
    )
    // Importing media and placing it are two writes. Before the loop resumed,
    // the run ended here and "导入到时间轴" could never finish.
    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'waiting_approval',
        approval: expect.objectContaining({ name: 'place_media' }),
      }),
    )
    await expect(
      service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        assistantText: '素材已导入并放上时间轴。',
      }),
    )

    expect(localBridge.call).toHaveBeenCalledTimes(2)
  })

  it('clamps every outgoing field to the server request limits', async () => {
    // The server rejects an oversized turn with a bare 400 that reaches the user
    // as an opaque code. Nothing compared these two numbers before, which is how
    // a widened client window silently broke every thread past its 24th turn.
    const runtime = await createRuntime()
    const overLimitTurns = Array.from(
      { length: AGENT_TURN_SERVER_LIMITS.recentMessages + 15 },
      (_, index) => ({
        kind: 'turn' as const,
        id: `turn-bulk-${index}`,
        threadId: 'thread-1',
        role: 'assistant' as const,
        body: 'x'.repeat(AGENT_TURN_SERVER_LIMITS.textChars + 500),
        sequence: index + 1,
        createdAt: 1_000 + index,
        updatedAt: 1_000 + index,
      }),
    )
    await runtime.putRecords({ records: overLimitTurns })

    const overLimitTools: DesktopBridgeToolDescriptor[] = Array.from(
      { length: AGENT_TURN_SERVER_LIMITS.tools + 40 },
      (_, index) => ({
        name: `bulk_tool_${index}`,
        annotations: { readOnlyHint: true },
      }),
    ) as DesktopBridgeToolDescriptor[]

    const sent: Array<Parameters<AgentTurnTransport['run']>[0]['request']> = []
    const service = new LocalAgentHostService({
      runtime,
      bridge: bridge(overLimitTools) as never,
      transport: transport(async ({ request }) => {
        sent.push(request)
        return { outcome: 'final', assistantText: '完成。' }
      }),
    })

    await service.run(input())

    const request = sent[0]!
    expect(request.context.recentMessages.length).toBeLessThanOrEqual(
      AGENT_TURN_SERVER_LIMITS.recentMessages,
    )
    expect(request.tools.length).toBeLessThanOrEqual(AGENT_TURN_SERVER_LIMITS.tools)
    expect(request.context.summary.length).toBeLessThanOrEqual(
      AGENT_TURN_SERVER_LIMITS.textChars,
    )
    for (const message of request.context.recentMessages) {
      expect(message.text.length).toBeLessThanOrEqual(AGENT_TURN_SERVER_LIMITS.textChars)
    }
    // An absent inputSchema serializes to a missing key, which the server treats
    // as a malformed request and rejects along with every other tool.
    const serialized = JSON.parse(JSON.stringify(request)) as typeof request
    for (const tool of serialized.tools) {
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('feeds an approved write result back to the model as a tool receipt', async () => {    const runtime = await createRuntime()
    const localBridge = bridge(
      [{ name: 'import_media_files', annotations: { readOnlyHint: false } }],
      { ok: true, mediaIds: ['media-7'] },
    )
    const seen: Array<Array<{ role: string; text: string }>> = []
    let dispatched = 0
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async ({ request }) => {
        seen.push(request.context.recentMessages)
        dispatched += 1
        if (dispatched === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              { id: 'call-import-2', name: 'import_media_files', arguments: { path: 'C:\\clips' } },
            ],
          }
        }
        return { outcome: 'final', assistantText: '完成。' }
      }),
    })

    await service.run(input())
    await service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 })

    // Without the receipt the resumed turn cannot know which media ids the
    // import produced, so it has nothing to place.
    expect(seen[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: expect.stringContaining('media-7'),
        }),
      ]),
    )
  })

  it('reports an approved write as failed when the tool result carries an error', async () => {
    const runtime = await createRuntime()
    // `callMcpTool` never rejects: it catches every throw and returns a
    // resolved payload with `isError: true`. Reporting success here would
    // record a false ToolReceipt and tell the user the write landed.
    const localBridge = bridge(
      [
        {
          name: 'import_media_files',
          annotations: { readOnlyHint: false },
        },
      ],
      {
        content: [{ type: 'text', text: 'Local path access was not approved.' }],
        isError: true,
        structuredContent: {
          ok: false,
          message: 'Local path access was not approved.',
          error: { code: 'TOOL_EXECUTION_FAILED', message: 'Local path access was not approved.' },
        },
      },
    )
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [
          {
            id: 'call-import-1',
            name: 'import_media_files',
            arguments: { path: 'C:\\media' },
          },
        ],
      })),
    })

    await service.run(input())
    const result = finished(
      await service.approve({
        runId: 'run-1',
        holderId: 'holder-1',
        leaseTtlMs: 60_000,
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('TOOL_EXECUTION_FAILED')
    expect(result.assistantText).not.toContain('已执行')
    // The tool's own reason must reach the user, not just the error code.
    expect(result.assistantText).toContain('Local path access was not approved.')
    expect(result.run.status).toBe('failed')
    await expect(runtime.listRecords({ threadId: 'thread-1' })).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({
            eventType: 'toolReceipt',
            payload: expect.objectContaining({ status: 'failed' }),
          }),
        ]),
      }),
    )
  })

  it('reports an approved write as failed when the tool reports ok: false without isError', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [
        {
          name: 'import_media_files',
          annotations: { readOnlyHint: false },
        },
      ],
      { structuredContent: { ok: false, message: '该路径中没有可导入的文件。' } },
    )
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [{ id: 'call-import-2', name: 'import_media_files', arguments: {} }],
      })),
    })

    await service.run(input())
    const result = finished(
      await service.approve({
        runId: 'run-1',
        holderId: 'holder-1',
        leaseTtlMs: 60_000,
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.assistantText).toContain('该路径中没有可导入的文件。')
  })

  it('authorizes the approved local path before dispatching the write', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [{ name: 'import_media_files', annotations: { readOnlyHint: false } }],
      { changed: true },
    )
    const authorized: string[] = []
    let dispatched = 0
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      authorizeLocalPath: async (path) => {
        // Must happen before dispatch, or the renderer still hits the prompt.
        expect(localBridge.call).not.toHaveBeenCalled()
        authorized.push(path)
      },
      transport: transport(async () => {
        dispatched += 1
        if (dispatched === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-import-3',
                name: 'import_media_files',
                arguments: { path: 'C:\\Users\\me\\Desktop\\clips' },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '已导入。' }
      }),
    })

    await service.run(input())
    const result = await service.approve({
      runId: 'run-1',
      holderId: 'holder-1',
      leaseTtlMs: 60_000,
    })

    expect(result.status).toBe('completed')
    expect(authorized).toEqual(['C:\\Users\\me\\Desktop\\clips'])
  })

  it('still runs the approved write when authorizing the path fails', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [{ name: 'import_media_files', annotations: { readOnlyHint: false } }],
      { changed: true },
    )
    let dispatched = 0
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      authorizeLocalPath: async () => {
        throw new Error('registry unavailable')
      },
      transport: transport(async () => {
        dispatched += 1
        if (dispatched === 1) {
          return {
            outcome: 'tool_calls',
            toolCalls: [
              {
                id: 'call-import-4',
                name: 'import_media_files',
                arguments: { path: 'C:\\clips' },
              },
            ],
          }
        }
        return { outcome: 'final', assistantText: '已导入。' }
      }),
    })

    await service.run(input())
    const result = await service.approve({
      runId: 'run-1',
      holderId: 'holder-1',
      leaseTtlMs: 60_000,
    })

    // The path prompt still guards the write, so a grant failure must not
    // block a call the user already approved.
    expect(result.status).toBe('completed')
    expect(localBridge.call).toHaveBeenCalledTimes(1)
  })

  it('does not authorize anything when the approved call names no absolute path', async () => {
    const runtime = await createRuntime()
    const localBridge = bridge(
      [{ name: 'freecut.timeline.split', annotations: { readOnlyHint: false } }],
      { changed: true },
    )
    const authorizeLocalPath = vi.fn(async () => {})
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      authorizeLocalPath,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [
          { id: 'call-split-1', name: 'freecut.timeline.split', arguments: { atSeconds: 3 } },
        ],
      })),
    })

    await service.run(input())
    await service.approve({ runId: 'run-1', holderId: 'holder-1', leaseTtlMs: 60_000 })

    expect(authorizeLocalPath).not.toHaveBeenCalled()
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
        assistantText: '执行结果不确定：LOCAL_WRITE_UNCERTAIN（Write outcome is unknown.）',
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

  it('cancels an in-flight read tool so stopping the run actually stops the work', async () => {
    const runtime = await createRuntime()
    let dispatchedRequestId: string | undefined
    let releaseCall!: () => void
    const localBridge = {
      tools: vi.fn(() => [
        {
          name: 'read_timeline',
          annotations: { readOnlyHint: true },
        } satisfies DesktopBridgeToolDescriptor,
      ]),
      call: vi.fn(async (call: { requestId: string }) => {
        dispatchedRequestId = call.requestId
        // Held open on purpose: this is the state a user hits 停止 in.
        await new Promise<void>((resolve) => {
          releaseCall = resolve
        })
        return { clipCount: 3 }
      }),
      cancel: vi.fn(async () => true),
    }
    const controller = new AbortController()
    const service = new LocalAgentHostService({
      runtime,
      bridge: localBridge as never,
      transport: transport(async () => ({
        outcome: 'tool_calls',
        toolCalls: [{ id: 'call-read-1', name: 'read_timeline' }],
      })),
    })

    const run = service.run(input(controller.signal))
    await vi.waitFor(() => expect(dispatchedRequestId).toBeDefined())

    controller.abort()
    // Aborting the loop alone leaves the Renderer still executing the tool, which
    // holds the round open — the run would keep "stopping" for as long as the
    // read takes. Cancelling the Bridge call is what makes 停止 mean stopped.
    await vi.waitFor(() => expect(localBridge.cancel).toHaveBeenCalledWith(dispatchedRequestId))

    releaseCall()
    await expect(run).resolves.toEqual(
      expect.objectContaining({ status: 'cancelled', errorCode: 'LOCAL_DIRECTOR_CANCELLED' }),
    )
  })

  /**
   * The server rejects an oversized request outright, and the client used to
   * report that as an opaque code — so a thread that simply grew past the cap
   * looked like an outage. Nothing compared the two schemas, so it shipped green.
   */
  it('keeps the outgoing turn inside the server request caps', async () => {
    const runtime = await createRuntime()
    // Well past the cap, so a regression that drops the clamp fails here.
    const overflow = AGENT_TURN_SERVER_LIMITS.recentMessages + 40
    await runtime.putRecords({
      records: Array.from({ length: overflow }, (_unused, index) => ({
        kind: 'turn' as const,
        id: `turn-flood-${index}`,
        threadId: 'thread-1',
        role: 'assistant' as const,
        body: 'x'.repeat(AGENT_TURN_SERVER_LIMITS.textChars + 500),
        sequence: index + 1,
        createdAt: 1_000,
        updatedAt: 1_000,
      })),
    })
    const localTransport = transport(async () => ({
      outcome: 'final' as const,
      assistantText: '完成。',
    }))
    const service = new LocalAgentHostService({
      runtime,
      bridge: bridge([{ name: 'read_timeline', annotations: { readOnlyHint: true } }]) as never,
      transport: localTransport,
    })

    await service.run(input())

    const sent = (localTransport.run as ReturnType<typeof vi.fn>).mock.calls[0][0].request
    expect(sent.context.recentMessages.length).toBeLessThanOrEqual(
      AGENT_TURN_SERVER_LIMITS.recentMessages,
    )
    expect(sent.context.summary.length).toBeLessThanOrEqual(AGENT_TURN_SERVER_LIMITS.textChars)
    for (const message of sent.context.recentMessages) {
      expect(message.text.length).toBeLessThanOrEqual(AGENT_TURN_SERVER_LIMITS.textChars)
    }
    expect(sent.tools.length).toBeLessThanOrEqual(AGENT_TURN_SERVER_LIMITS.tools)
    // The server requires inputSchema; an absent one serializes to a missing key
    // and rejects the whole turn, so every disclosed tool must carry one.
    for (const tool of sent.tools) {
      expect(tool.inputSchema).toBeTypeOf('object')
    }
  })

  it('finishes the local run with a diagnostic error when the transport fails', async () => {    const runtime = await createRuntime()
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
            body: '这次请求没能送达云端，或者云端拒绝了它。（LOCAL_DIRECTOR_TURN_FAILED）',
          }),
          // The transport's own words have to survive into the record. Losing
          // them is what made a one-line server rejection cost a full
          // investigation, so this asserts the detail, not just the event.
          expect.objectContaining({
            kind: 'event',
            eventType: 'directorFailed',
            payload: expect.objectContaining({
              errorCode: 'LOCAL_DIRECTOR_TURN_FAILED',
              detail: { message: 'upstream unavailable' },
            }),
          }),
        ]),
      }),
    )
  })
})
