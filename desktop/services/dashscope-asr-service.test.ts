// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { DESKTOP_CREDENTIAL_KEYS, DESKTOP_CREDENTIAL_ORIGIN_KEYS } from '../desktop-types'
import type { CredentialStore } from './credential-store'
import { DashScopeAsrService } from './dashscope-asr-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function credentialStore(values: Record<string, string>): CredentialStore {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as CredentialStore
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('DashScopeAsrService', () => {
  it('uses the Bridge business key for the built-in MCP transcription endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mcp.123jianhao.com/api/v1/transcribe')
      expect(init?.headers).toEqual({
        Authorization: 'Bearer mcp-business-key',
        'Content-Type': 'application/json',
      })
      const body = JSON.parse(String(init?.body)) as {
        audio: string
        context: string
        idempotencyKey: string
      }
      expect(body.audio).toBe(Buffer.from([1, 2, 3]).toString('base64'))
      expect(body.context).toContain('clip.wav')
      expect(body.idempotencyKey).toMatch(/^freecut-desktop-asr-/)
      return jsonResponse({
        status: 'succeeded',
        text: '桌面转写',
        durationSeconds: 1,
      })
    })
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]:
          'https://mcp.123jianhao.com',
      }),
    )
    const onSubmitted = vi.fn()

    await expect(
      service.transcribe(
        {
          fileName: 'clip.wav',
          mimeType: 'audio/wav',
          bytes: new Uint8Array([1, 2, 3]),
        },
        { onSubmitted },
      ),
    ).resolves.toEqual({
      remoteTaskId: expect.stringMatching(/^freecut-desktop-asr-/),
      result: {
        status: 'succeeded',
        text: '桌面转写',
        durationSeconds: 1,
      },
    })
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('does not use a key bound to a different origin', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://other.example',
      }),
    )

    await expect(
      service.transcribe({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('剪好 MCP Key 与内置服务地址不匹配')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the shared MCP Key', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(credentialStore({}))

    await expect(
      service.transcribe({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('请先配置剪好 MCP Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes cancellation to the MCP transcription request', async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          )
        }),
    )
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]:
          'https://mcp.123jianhao.com',
      }),
    )
    const controller = new AbortController()
    const request = service.transcribe(
      {
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1]),
      },
      { signal: controller.signal },
    )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort()
    await expect(request).rejects.toThrow('cancelled')
  })
})
