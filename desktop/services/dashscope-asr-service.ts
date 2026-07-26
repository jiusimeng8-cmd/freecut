import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import {
  DESKTOP_CLOUD_BASE_URL,
  DESKTOP_CREDENTIAL_KEYS,
  DESKTOP_CREDENTIAL_ORIGIN_KEYS,
} from '../desktop-types'
import type { CredentialStore } from './credential-store'

/**
 * The trusted service base. Shared with the agent transport so the two
 * credential-bound cloud paths cannot drift onto different origins — one
 * hardened and the other not.
 */
const DEFAULT_CLOUD_BASE_URL = DESKTOP_CLOUD_BASE_URL
const FALLBACK_MAX_AUDIO_BYTES = 1024 * 1024 * 1024
/** Silent media: the cloud reports it as a distinct, non-retryable outcome. */
const NO_SPEECH_ERROR_CODE = 'ASR_NO_SPEECH_DETECTED'

interface CloudTranscriptionResponse {
  status: 'succeeded' | 'no_speech'
  text: string
  durationSeconds: number
  error?: string
  errorCode?: string
}

interface CloudUploadPolicyResponse {
  uploadHost: string
  audioUrl: string
  expireInSeconds: number
  maxFileSizeMb: number
  fields: {
    key: string
    policy: string
    OSSAccessKeyId: string
    signature: string
    'x-oss-object-acl': string
    'x-oss-forbid-overwrite': string
    success_action_status: string
  }
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
    // Silent media is a legitimate result, so it travels back as data. Thrown
    // errors lose their code crossing the IPC boundary, leaving callers unable
    // to tell "nobody spoke" apart from a real outage.
    if (body.errorCode === NO_SPEECH_ERROR_CODE) {
      return { status: 'no_speech', text: '', durationSeconds: 0 }
    }
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

async function readUploadPolicyResponse(response: Response): Promise<CloudUploadPolicyResponse> {
  const body = (await response.json().catch(() => ({}))) as CloudUploadPolicyResponse
  if (!response.ok) {
    throw new Error(
      body.error?.trim() || `剪好 MCP 语音识别上传通行证请求失败 (${response.status})`,
    )
  }
  if (
    !body.uploadHost ||
    !body.audioUrl ||
    !body.fields?.key ||
    !body.fields?.policy ||
    !body.fields?.OSSAccessKeyId ||
    !body.fields?.signature
  ) {
    throw new Error('剪好 MCP 语音识别上传通行证返回了无效结果。')
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

    const policyResponse = await fetch(`${baseUrl}/api/v1/uploads/policy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${businessKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileName, mimeType }),
      signal: options.signal,
    })
    const policy = await readUploadPolicyResponse(policyResponse)
    const maxBytes =
      policy.maxFileSizeMb > 0 ? policy.maxFileSizeMb * 1024 * 1024 : FALLBACK_MAX_AUDIO_BYTES
    if (blob.size > maxBytes) {
      throw new Error('转写媒体超过阿里云当前允许的上传大小。')
    }

    const uploadForm = new FormData()
    uploadForm.set('key', policy.fields.key)
    uploadForm.set('policy', policy.fields.policy)
    uploadForm.set('OSSAccessKeyId', policy.fields.OSSAccessKeyId)
    uploadForm.set('signature', policy.fields.signature)
    uploadForm.set('x-oss-object-acl', policy.fields['x-oss-object-acl'])
    uploadForm.set('x-oss-forbid-overwrite', policy.fields['x-oss-forbid-overwrite'])
    uploadForm.set('success_action_status', policy.fields.success_action_status)
    uploadForm.set('file', blob, fileName)

    const uploadResponse = await fetch(policy.uploadHost, {
      method: 'POST',
      body: uploadForm,
      signal: options.signal,
    })
    if (!uploadResponse.ok) {
      throw new Error(`语音识别音频上传到阿里云失败 (${uploadResponse.status})`)
    }

    const remoteTaskId = `freecut-desktop-asr-${randomUUID()}`
    const transcribeResponse = await fetch(`${baseUrl}/api/v1/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${businessKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audioUrl: policy.audioUrl,
        context: `FreeCut Desktop: ${fileName} (${mimeType})`,
        idempotencyKey: remoteTaskId,
      }),
      signal: options.signal,
    })
    const result = await readCloudResponse(transcribeResponse)
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
