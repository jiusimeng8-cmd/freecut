import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCloudMcpTranscription,
  transcribeWithCloudMcp,
} from './dashscope-asr-client'

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
})

describe('transcribeWithCloudMcp', () => {
  it('uses the configured MCP Key for Web development transcription', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            status: 'succeeded',
            text: '网页转写',
            durationSeconds: 1.5,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      transcribeWithCloudMcp(
        new File(['media'], '中文素材.mp4', { type: 'video/mp4' }),
        {
          baseUrl: 'https://mcp.123jianhao.com',
          businessKey: 'mcp-test-key',
        },
      ),
    ).resolves.toEqual({
      text: '网页转写',
      segments: [{ text: '网页转写', start: 0, end: 1.5 }],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/__freecut_dev_asr/transcribe',
      expect.objectContaining({
        headers: {
          'Content-Type': 'video/mp4',
          'X-FreeCut-Business-Key': encodeURIComponent('mcp-test-key'),
          'X-FreeCut-File-Name': encodeURIComponent('中文素材.mp4'),
        },
      }),
    )
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

  it('rejects Web transcription when the MCP Key is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      transcribeWithCloudMcp(
        new File(['media'], 'clip.mp4', { type: 'video/mp4' }),
        {
          baseUrl: 'https://mcp.123jianhao.com',
          businessKey: '',
        },
      ),
    ).rejects.toThrow('请先配置剪好 MCP Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
