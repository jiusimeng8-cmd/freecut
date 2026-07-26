import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCloudMcpTranscription, transcribeWithCloudMcp } from './dashscope-asr-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseCloudMcpTranscription', () => {
  it('maps the cloud text and duration to a transcript segment', () => {
    expect(
      parseCloudMcpTranscription({
        status: 'succeeded',
        text: '今天开始剪辑',
        durationSeconds: 2.8,
      }),
    ).toEqual({
      text: '今天开始剪辑',
      segments: [{ text: '今天开始剪辑', start: 0, end: 2.8 }],
    })
  })

  it('uses the known media duration when the cloud response omits duration', () => {
    expect(
      parseCloudMcpTranscription(
        {
          status: 'succeeded',
          text: '桌面转写',
          durationSeconds: 0,
        },
        12,
      ),
    ).toEqual({
      text: '桌面转写',
      segments: [{ text: '桌面转写', start: 0, end: 12 }],
    })
  })

  it('reports a no_speech result as an empty transcript rather than throwing', () => {
    expect(
      parseCloudMcpTranscription({ status: 'no_speech', text: '', durationSeconds: 0 }, 12),
    ).toEqual({ text: '', segments: [], noSpeech: true })
  })
})

describe('transcribeWithCloudMcp', () => {
  it('uses the configured MCP Key for Web development transcription', async () => {
    const uploadPolicyResponse = {
      uploadHost: 'https://dash-bj.oss-cn-beijing.aliyuncs.com',
      audioUrl: 'oss://dashscope-uploads/2026/asr/abc123-素材.mp4',
      maxFileSizeMb: 1024,
      fields: {
        key: 'dashscope-uploads/2026/asr/abc123-素材.mp4',
        policy: 'policy-token',
        OSSAccessKeyId: 'LTAI-fake',
        signature: 'signature-token',
        'x-oss-object-acl': 'private',
        'x-oss-forbid-overwrite': 'true',
        success_action_status: '200',
      },
    }
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url)
      calls.push({ url: urlString, init })
      if (urlString === '/__freecut_dev_mcp/api/v1/uploads/policy') {
        return new Response(JSON.stringify(uploadPolicyResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString === uploadPolicyResponse.uploadHost) {
        return new Response(null, { status: 204 })
      }
      if (urlString === '/__freecut_dev_mcp/api/v1/transcribe') {
        return new Response(
          JSON.stringify({
            status: 'succeeded',
            text: '网页转写',
            durationSeconds: 1.5,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${urlString}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      transcribeWithCloudMcp(new File(['media'], '中文素材.mp4', { type: 'video/mp4' }), {
        baseUrl: 'https://mcp.123jianhao.com',
        businessKey: 'mcp-test-key',
      }),
    ).resolves.toEqual({
      text: '网页转写',
      segments: [{ text: '网页转写', start: 0, end: 1.5 }],
    })

    expect(calls.map((call) => call.url)).toEqual([
      '/__freecut_dev_mcp/api/v1/uploads/policy',
      uploadPolicyResponse.uploadHost,
      '/__freecut_dev_mcp/api/v1/transcribe',
    ])
    expect(calls[0]?.init?.headers).toEqual({
      'X-FreeCut-Business-Key': encodeURIComponent('mcp-test-key'),
      'Content-Type': 'application/json',
    })
    const uploadBody = calls[1]?.init?.body as FormData
    expect(uploadBody.get('key')).toBe(uploadPolicyResponse.fields.key)
    expect(uploadBody.get('file')).toBeInstanceOf(File)
    const transcribeBody = JSON.parse(String(calls[2]?.init?.body))
    expect(transcribeBody.audioUrl).toBe(uploadPolicyResponse.audioUrl)
    expect(transcribeBody.context).toContain('中文素材.mp4')
  })

  it('parses the direct Desktop MCP transcription result', async () => {
    const transcribe = vi.fn().mockResolvedValue({
      taskId: 'local-task-1',
      result: {
        status: 'succeeded',
        text: '桌面转写',
        durationSeconds: 1,
      },
    })
    vi.stubGlobal('freecutDesktop', { asr: { transcribe } })
    const file = new File(['media'], 'clip.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    })

    await expect(
      transcribeWithCloudMcp(
        file,
        {
          baseUrl: 'https://mcp.123jianhao.com',
          businessKey: '',
        },
        1,
      ),
    ).resolves.toEqual({
      text: '桌面转写',
      segments: [{ text: '桌面转写', start: 0, end: 1 }],
    })
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'clip.wav',
        mimeType: 'audio/wav',
      }),
    )
  })

  it('turns the cloud no-speech error into a skippable empty transcript', async () => {
    const uploadPolicyResponse = {
      uploadHost: 'https://dash-bj.oss-cn-beijing.aliyuncs.com',
      audioUrl: 'oss://dashscope-uploads/2026/asr/silent.mp4',
      maxFileSizeMb: 1024,
      fields: {
        key: 'dashscope-uploads/2026/asr/silent.mp4',
        policy: 'policy-token',
        OSSAccessKeyId: 'LTAI-fake',
        signature: 'signature-token',
        'x-oss-object-acl': 'private',
        'x-oss-forbid-overwrite': 'true',
        success_action_status: '200',
      },
    }
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlString = String(url)
      if (urlString === '/__freecut_dev_mcp/api/v1/uploads/policy') {
        return new Response(JSON.stringify(uploadPolicyResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString === uploadPolicyResponse.uploadHost) {
        return new Response(null, { status: 204 })
      }
      return new Response(
        JSON.stringify({
          errorCode: 'ASR_NO_SPEECH_DETECTED',
          error: '这段媒体中没有检测到人声，无法生成字幕。',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      transcribeWithCloudMcp(new File(['media'], 'silent.mp4', { type: 'video/mp4' }), {
        baseUrl: 'https://mcp.123jianhao.com',
        businessKey: 'mcp-test-key',
      }),
    ).resolves.toEqual({ text: '', segments: [], noSpeech: true })
  })

  it('rejects Web transcription when the MCP Key is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      transcribeWithCloudMcp(new File(['media'], 'clip.mp4', { type: 'video/mp4' }), {
        baseUrl: 'https://mcp.123jianhao.com',
        businessKey: '',
      }),
    ).rejects.toThrow('请先配置剪好 MCP Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
