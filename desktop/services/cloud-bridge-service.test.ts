// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { DESKTOP_CREDENTIAL_KEYS, DESKTOP_CREDENTIAL_ORIGIN_KEYS } from '../desktop-types'
import type { CredentialStore } from './credential-store'
import {
  CloudBridgeRequestTimeoutError,
  CloudBridgeService,
} from './cloud-bridge-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function credentialStore(values: Record<string, string>): CredentialStore {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as CredentialStore
}

describe('CloudBridgeService', () => {
  it('keeps the business key in Main and attaches it to an allowed request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )

    await expect(
      service.request({
        requestId: 'request-1',
        baseUrl: 'https://api.freecut.example/',
        path: '/api/bridge/poll',
        body: { deviceId: 'device-1' },
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.freecut.example/api/bridge/poll',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        },
      }),
    )
  })

  it('aborts a running cloud request', async () => {
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    )
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )
    const request = service.request({
      requestId: 'request-2',
      baseUrl: 'https://api.freecut.example',
      path: '/api/v1/agents/run',
      body: { prompt: 'trim' },
    })

    await vi.waitFor(() => expect(service.cancel('request-2')).toBe(true))
    await expect(request).rejects.toThrow('aborted')
    expect(service.cancel('request-2')).toBe(false)
  })

  it('does not send a business key to a different origin', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )

    await expect(
      service.request({
        requestId: 'request-3',
        baseUrl: 'https://other.example',
        path: '/api/bridge/poll',
        body: {},
      }),
    ).rejects.toThrow('帧剪业务 Key 与当前服务地址不匹配')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows only the exact per-run cancellation endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'cancelled' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )

    await service.request({
      requestId: 'request-cancel',
      baseUrl: 'https://api.freecut.example',
      method: 'POST',
      path: '/api/v1/agent-runs/a15c7220-469b-4fcc-85da-e31f6512539e/cancel',
      body: {},
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.freecut.example/api/v1/agent-runs/a15c7220-469b-4fcc-85da-e31f6512539e/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('allows the exact stateless Agent Turn endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'final' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchMock
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )

    await service.request({
      requestId: 'agent-turn-1',
      baseUrl: 'https://api.freecut.example',
      method: 'POST',
      path: '/api/v1/agent-turns',
      body: { turnId: 'e5fe4a90-49fe-4c6e-a1c9-1c3375af5f5a' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.freecut.example/api/v1/agent-turns',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('caps an Agent Turn request at the configured 120 second boundary', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    )
    const service = new CloudBridgeService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'secret-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://api.freecut.example',
      }),
    )

    const request = service.request({
      requestId: 'agent-turn-timeout',
      baseUrl: 'https://api.freecut.example',
      path: '/api/v1/agent-turns',
      timeoutMs: 120_000,
      body: {},
    })
    const rejection = expect(request).rejects.toBeInstanceOf(CloudBridgeRequestTimeoutError)
    await vi.advanceTimersByTimeAsync(120_000)

    await rejection
    expect(service.cancel('agent-turn-timeout')).toBe(false)
  })
})
