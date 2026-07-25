import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCloudAgentTurnInput,
  parseCloudAgentTurnResponse,
  runCloudAgentTurn,
  type CloudAgentTurnInput,
} from './agent-turn-client'

const originalFetch = globalThis.fetch

const input: CloudAgentTurnInput = {
  turnId: 'e5fe4a90-49fe-4c6e-a1c9-1c3375af5f5a',
  profileId: 'editor-expert',
  context: {
    summary: '项目包含一段口播。',
    recentMessages: [{ role: 'user', text: '统一画面色调。' }],
    snapshotId: 'snapshot-1',
    fingerprint: 'fnv1a64:1234',
  },
  tools: [
    {
      name: 'freecut.timeline.read',
      title: '读取时间线',
      category: 'timeline',
      description: '读取当前时间线。',
      inputSchema: { type: 'object' },
      readOnly: true,
      destructive: false,
      handoff: false,
    },
  ],
}

function wireResponse(overrides: Record<string, unknown> = {}) {
  return {
    turnId: input.turnId,
    outcome: 'tool_calls',
    assistantText: '我先读取时间线。',
    toolCalls: [
      {
        id: 'call-1',
        name: 'freecut.timeline.read',
        arguments: {},
      },
    ],
    usage: {
      inputUnits: 123,
      outputUnits: 45,
      charged: true,
    },
    routing: {
      profileId: 'editor-expert',
      providerId: 'provider-1',
      modelId: 'resolved-model-1',
      channelId: 'channel-1',
      protocol: 'responses',
    },
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('Agent Turn cloud client', () => {
  it('posts only to the stateless Agent Turn endpoint and parses a valid tool call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wireResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock

    await expect(
      runCloudAgentTurn(
        { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
        input,
      ),
    ).resolves.toMatchObject({
      turnId: input.turnId,
      outcome: 'tool_calls',
      routing: {
        profileId: 'editor-expert',
        providerId: 'provider-1',
        modelId: 'resolved-model-1',
        channelId: 'channel-1',
        protocol: 'responses',
      },
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__freecut_dev_mcp/api/v1/agent-turns')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-FreeCut-Business-Key': encodeURIComponent('temporary-key'),
      }),
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      profileId: 'editor-expert',
      tools: [{ name: 'freecut.timeline.read' }],
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('businessModel')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/agent-runs')
  })

  it('rejects unknown response fields and invalid tool call shapes', () => {
    expect(() =>
      parseCloudAgentTurnResponse(
        wireResponse({
          unexpected: true,
        }),
        input,
      ),
    ).toThrow('未知字段')

    expect(() =>
      parseCloudAgentTurnResponse(
        wireResponse({
          toolCalls: [
            {
              id: 'call-1',
              name: 'freecut.timeline.read',
              arguments: {},
              rawOutput: 'must not cross the boundary',
            },
          ],
        }),
        input,
      ),
    ).toThrow('未知字段')

    expect(() =>
      parseCloudAgentTurnResponse(
        wireResponse({
          outcome: 'final',
        }),
        input,
      ),
    ).toThrow('final 不能包含工具调用')

    expect(() =>
      parseCloudAgentTurnResponse(
        wireResponse({
          routing: {
            businessModel: 'legacy-profile',
            upstreamModel: 'legacy-model',
            channelId: 'legacy-channel',
          },
        }),
        input,
      ),
    ).toThrow('未知字段')
  })

  it('accepts a format-valid profileId without restricting it to a fixed enum', () => {
    expect(
      parseCloudAgentTurnInput({
        ...input,
        profileId: 'team-a.editor:preview',
      }).profileId,
    ).toBe('team-a.editor:preview')
  })

  it('uses the cloud model slug contract for profileId', () => {
    expect(() =>
      parseCloudAgentTurnInput({
        ...input,
        profileId: 'Editor-Expert',
      }),
    ).toThrow('profileId 无效')
    expect(() =>
      parseCloudAgentTurnInput({
        ...input,
        profileId: `a${'b'.repeat(100)}`,
      }),
    ).toThrow('profileId 无效')
  })

  it('propagates caller cancellation without creating an Agent Run', async () => {
    const controller = new AbortController()
    globalThis.fetch = vi.fn(
      (_url, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          )
        }),
    )

    const pending = runCloudAgentTurn(
      { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
      input,
      controller.signal,
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('returns the upstream error without falling back to the legacy Agent Run endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errorCode: 'MODEL_UPSTREAM_FAILED',
          error: '上游推理请求失败。',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    globalThis.fetch = fetchMock

    await expect(
      runCloudAgentTurn(
        { baseUrl: 'https://api.freecut.example', businessKey: 'temporary-key' },
        input,
      ),
    ).rejects.toThrow('上游推理请求失败')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/__freecut_dev_mcp/api/v1/agent-turns')
  })
})
