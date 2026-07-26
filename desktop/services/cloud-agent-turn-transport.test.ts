// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  DESKTOP_CLOUD_BASE_URL,
  DESKTOP_CREDENTIAL_KEYS,
  DESKTOP_CREDENTIAL_ORIGIN_KEYS,
} from '../desktop-types'
import { CloudBridgeService } from './cloud-bridge-service'
import { createCloudAgentTurnTransport } from './cloud-agent-turn-transport'
import type { CredentialStore } from './credential-store'
import type { AgentTurnRequest } from './local-agent-host-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function credentialStore(values: Record<string, string>): CredentialStore {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    has: vi.fn(async (key: string) => Boolean(values[key])),
  } as unknown as CredentialStore
}

function agentTurnRequest(): AgentTurnRequest {
  return {
    turnId: 'b1f0c2d4-5e6a-4b8c-9d0e-1f2a3b4c5d6e',
    profileId: 'editing-director-v2',
    context: {
      summary: '',
      recentMessages: [],
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    },
    tools: [],
  }
}

function transportFor(credentials: CredentialStore) {
  return createCloudAgentTurnTransport({
    credentials,
    cloudBridge: new CloudBridgeService(credentials),
    // The origin gate must reject before any response parsing happens.
    parseResponse: (response) => response as never,
    timeoutMs: 120_000,
  })
}

describe('createCloudAgentTurnTransport', () => {
  it('does not use a key bound to a different origin', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const transport = transportFor(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://other.example',
      }),
    )

    await expect(
      transport.run({ request: agentTurnRequest() }, new AbortController().signal),
    ).rejects.toThrow('帧剪业务 Key 与当前服务地址不匹配')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends an Agent Turn to the trusted built-in origin when the key is bound to it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'final' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock
    const transport = transportFor(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: DESKTOP_CLOUD_BASE_URL,
      }),
    )

    await expect(
      transport.run({ request: agentTurnRequest() }, new AbortController().signal),
    ).resolves.toEqual({ outcome: 'final' })

    expect(fetchMock).toHaveBeenCalledWith(
      `${DESKTOP_CLOUD_BASE_URL}/api/v1/agent-turns`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('requires a business key before reaching the network', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const transport = transportFor(credentialStore({}))

    await expect(
      transport.run({ request: agentTurnRequest() }, new AbortController().signal),
    ).rejects.toThrow('请先配置剪好 MCP Key。')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
