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

const UPLOAD_POLICY_RESPONSE = {
  uploadHost: 'https://dash-bj.oss-cn-beijing.aliyuncs.com',
  audioUrl: 'oss://dashscope-uploads/2026/asr/abc123-clip.wav',
  expireInSeconds: 300,
  maxFileSizeMb: 1024,
  fields: {
    key: 'dashscope-uploads/2026/asr/abc123-clip.wav',
    policy: 'policy-token',
    OSSAccessKeyId: 'LTAI-fake',
    signature: 'signature-token',
    'x-oss-object-acl': 'private',
    'x-oss-forbid-overwrite': 'true',
    success_action_status: '200',
  },
}

function mockAsrFlow(options: { onTranscribeBody?: (body: any) => void } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url)
    calls.push({ url: urlString, init })

    if (urlString === 'https://mcp.123jianhao.com/api/v1/uploads/policy') {
      expect(init?.headers).toEqual({
        Authorization: 'Bearer mcp-business-key',
        'Content-Type': 'application/json',
      })
      return jsonResponse(UPLOAD_POLICY_RESPONSE)
    }
    if (urlString === UPLOAD_POLICY_RESPONSE.uploadHost) {
      return new Response(null, { status: 204 })
    }
    if (urlString === 'https://mcp.123jianhao.com/api/v1/transcribe') {
      const body = JSON.parse(String(init?.body))
      options.onTranscribeBody?.(body)
      return jsonResponse({
        status: 'succeeded',
        text: '桌面转写',
        durationSeconds: 1,
      })
    }
    throw new Error(`unexpected fetch: ${urlString}`)
  })
  return { fetchMock, calls }
}

describe('DashScopeAsrService', () => {
  it('requests an upload policy, uploads directly to Aliyun, then submits the resulting oss:// URL', async () => {
    const { fetchMock, calls } = mockAsrFlow({
      onTranscribeBody: (body) => {
        expect(body.audioUrl).toBe(UPLOAD_POLICY_RESPONSE.audioUrl)
        expect(body.context).toContain('clip.wav')
        expect(body.idempotencyKey).toMatch(/^freecut-desktop-asr-/)
        expect(body.audio).toBeUndefined()
      },
    })
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://mcp.123jianhao.com',
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
    expect(calls.map((call) => call.url)).toEqual([
      'https://mcp.123jianhao.com/api/v1/uploads/policy',
      UPLOAD_POLICY_RESPONSE.uploadHost,
      'https://mcp.123jianhao.com/api/v1/transcribe',
    ])
    const uploadBody = calls[1].init?.body as FormData
    expect(uploadBody.get('key')).toBe(UPLOAD_POLICY_RESPONSE.fields.key)
    expect(uploadBody.get('OSSAccessKeyId')).toBe(UPLOAD_POLICY_RESPONSE.fields.OSSAccessKeyId)
    expect(uploadBody.get('file')).toBeInstanceOf(Blob)
  })

  it('returns silent media as a no_speech result instead of throwing', async () => {
    // Thrown errors lose their code crossing IPC, so this has to come back as data.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlString = String(url)
      if (urlString === 'https://mcp.123jianhao.com/api/v1/uploads/policy') {
        return jsonResponse(UPLOAD_POLICY_RESPONSE)
      }
      if (urlString === UPLOAD_POLICY_RESPONSE.uploadHost) {
        return new Response(null, { status: 204 })
      }
      return jsonResponse(
        { errorCode: 'ASR_NO_SPEECH_DETECTED', error: '这段媒体中没有检测到人声，无法生成字幕。' },
        422,
      )
    })
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://mcp.123jianhao.com',
      }),
    )

    await expect(
      service.transcribe({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({
      remoteTaskId: expect.stringMatching(/^freecut-desktop-asr-/),
      result: { status: 'no_speech', text: '', durationSeconds: 0 },
    })
  })

  it('still fails loudly when the cloud reports a real error', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlString = String(url)
      if (urlString === 'https://mcp.123jianhao.com/api/v1/uploads/policy') {
        return jsonResponse(UPLOAD_POLICY_RESPONSE)
      }
      if (urlString === UPLOAD_POLICY_RESPONSE.uploadHost) {
        return new Response(null, { status: 204 })
      }
      return jsonResponse(
        { errorCode: 'ASR_UPSTREAM_TERMINAL', error: '语音识别任务未能完成。' },
        502,
      )
    })
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://mcp.123jianhao.com',
      }),
    )

    await expect(
      service.transcribe({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow('语音识别任务未能完成。')
  })

  it('rejects media larger than the policy-reported size limit before uploading', async () => {
    const { fetchMock, calls } = mockAsrFlow()
    globalThis.fetch = fetchMock
    const service = new DashScopeAsrService(
      credentialStore({
        [DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey]: 'mcp-business-key',
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://mcp.123jianhao.com',
      }),
    )

    await expect(
      service.transcribe({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array(1),
      }),
    ).resolves.toBeDefined()
    expect(calls).toHaveLength(3)
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

  it('passes cancellation to the upload policy request', async () => {
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
        [DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey]: 'https://mcp.123jianhao.com',
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
