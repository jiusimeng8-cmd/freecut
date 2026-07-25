import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import { DESKTOP_CREDENTIAL_KEYS, DESKTOP_CREDENTIAL_ORIGIN_KEYS } from '../desktop-types'
import type { CredentialStore } from './credential-store'

const DEFAULT_CLOUD_BASE_URL = 'https://mcp.123jianhao.com'
const MAX_CLOUD_AUDIO_BASE64_LENGTH = 50_000_000
const MAX_CLOUD_AUDIO_BYTES = Math.floor((MAX_CLOUD_AUDIO_BASE64_LENGTH * 3) / 4)

interface CloudTranscriptionResponse {
  status: 'succeeded'
  text: string
  durationSeconds: number
  error?: string
}

export interface DashScopeAsrInput {
  fileName: string
  mimeType?: string
  path?: string
  bytes?: Uint8Array
}

export interface DashScopeAsrSubmission {
  remoteTaskId: string
  baseUrl: string
  model: string
}

export interface DashScopeAsrRunOptions {
  signal?: AbortSignal
  onSubmitted?: (submission: DashScopeAsrSubmission) => Promise<void> | void
}

export interface DashScopeAsrResumeInput {
  baseUrl: string
  remoteTaskId: string
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  const isLoopbackHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('剪好 MCP 服务必须使用 HTTPS。')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

async function readCloudResponse(response: Response): Promise<CloudTranscriptionResponse> {
  const body = (await response.json().catch(() => ({}))) as CloudTranscriptionResponse
  if (!response.ok) {
    throw new Error(body.error?.trim() || `剪好 MCP 语音识别请求失败 (${response.status})`)
  }
  if (
    body.status !== 'succeeded' ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    !Number.isFinite(body.durationSeconds) ||
    body.durationSeconds < 0
  ) {
    throw new Error('剪好 MCP 语音识别返回了无效结果。')
  }
  return body
}

export class DashScopeAsrService {
  constructor(private readonly credentials: CredentialStore) {}

  async transcribe(
    input: DashScopeAsrInput,
    options: DashScopeAsrRunOptions = {},
  ): Promise<{ remoteTaskId: string; result: unknown }> {
    const { baseUrl, businessKey } = await this.resolveContext(DEFAULT_CLOUD_BASE_URL)
    const fileName = basename(input.fileName.replaceAll('\0', '')).slice(0, 180) || 'media.bin'
    const mimeType = input.mimeType?.trim() || 'application/octet-stream'
    options.signal?.throwIfAborted()
    const blob = input.path
      ? await openAsBlob(input.path, { type: mimeType })
      : new Blob([Uint8Array.from(input.bytes ?? []).buffer], { type: mimeType })
    if (blob.size === 0) throw new Error('转写媒体为空。')
    if (blob.size > MAX_CLOUD_AUDIO_BYTES) {
      throw new Error('转写媒体超过剪好 MCP 当前支持的大小。')
    }

    const audio = Buffer.from(await blob.arrayBuffer()).toString('base64')

    const remoteTaskId = `freecut-desktop-asr-${randomUUID()}`
    const response = await fetch(`${baseUrl}/api/v1/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${businessKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio,
        context: `FreeCut Desktop: ${fileName} (${mimeType})`,
        idempotencyKey: remoteTaskId,
      }),
      signal: options.signal,
    })
    const result = await readCloudResponse(response)
    return { remoteTaskId, result }
  }

  async resume(
    _input: DashScopeAsrResumeInput,
    _options: Pick<DashScopeAsrRunOptions, 'signal'> = {},
  ): Promise<{ remoteTaskId: string; result: unknown }> {
    throw new Error('剪好 MCP 语音识别需要原媒体，请使用重试。')
  }

  private async resolveContext(
    rawBaseUrl: string,
  ): Promise<{ baseUrl: string; businessKey: string }> {
    const baseUrl = normalizeBaseUrl(rawBaseUrl)
    const [storedBusinessKey, boundOrigin] = await Promise.all([
      this.credentials.get(DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey),
      this.credentials.get(DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey),
    ])
    const businessKey = storedBusinessKey?.trim() ?? ''
    if (!businessKey) throw new Error('请先配置剪好 MCP Key')
    if (boundOrigin !== new URL(baseUrl).origin) {
      throw new Error('剪好 MCP Key 与内置服务地址不匹配，请重新配置')
    }
    return { baseUrl, businessKey }
  }
}
