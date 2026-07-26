import type { MediaTranscriptSegment } from '@/types/storage'
import type { CloudMcpConfig } from '@/shared/state/cloud-mcp-config-store'
import { getDesktopFileDescriptor } from '@/infrastructure/storage/desktop-file-system-access'

interface CloudTranscriptionResponse {
  status?: string
  text?: string
  durationSeconds?: number
  error?: string
  errorCode?: string
}

interface CloudUploadPolicyResponse {
  uploadHost?: string
  audioUrl?: string
  maxFileSizeMb?: number
  fields?: {
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

export interface CloudMcpTranscription {
  text: string
  segments: MediaTranscriptSegment[]
  /** True when the cloud confirmed the media simply has no speech in it. */
  noSpeech?: boolean
}

const FALLBACK_MAX_AUDIO_BYTES = 1024 * 1024 * 1024
/** Silent media: the cloud reports it as a distinct, non-retryable outcome. */
const NO_SPEECH_ERROR_CODE = 'ASR_NO_SPEECH_DETECTED'

function assertValidBusinessKey(businessKey: string): void {
  if (!businessKey.trim()) {
    throw new Error('请先配置剪好 MCP Key')
  }
}

function devMcpHeaders(businessKey: string): HeadersInit {
  return {
    'X-FreeCut-Business-Key': encodeURIComponent(businessKey),
    'Content-Type': 'application/json',
  }
}

async function requestUploadPolicy(
  fileName: string,
  mimeType: string,
  businessKey: string,
): Promise<Required<CloudUploadPolicyResponse>> {
  const response = await fetch('/__freecut_dev_mcp/api/v1/uploads/policy', {
    method: 'POST',
    headers: devMcpHeaders(businessKey),
    body: JSON.stringify({ fileName, mimeType }),
  })
  const body = (await response.json().catch(() => ({}))) as CloudUploadPolicyResponse
  if (
    !response.ok ||
    !body.uploadHost ||
    !body.audioUrl ||
    !body.fields?.key ||
    !body.fields?.policy ||
    !body.fields?.OSSAccessKeyId ||
    !body.fields?.signature
  ) {
    throw new Error(
      body.error?.trim() || `剪好 MCP 语音识别上传通行证请求失败 (${response.status})`,
    )
  }
  return body as Required<CloudUploadPolicyResponse>
}

async function uploadToAliyun(
  policy: Required<CloudUploadPolicyResponse>,
  file: File,
): Promise<void> {
  const maxBytes =
    policy.maxFileSizeMb > 0 ? policy.maxFileSizeMb * 1024 * 1024 : FALLBACK_MAX_AUDIO_BYTES
  if (file.size > maxBytes) {
    throw new Error('转写媒体超过阿里云当前允许的上传大小。')
  }

  const form = new FormData()
  form.set('key', policy.fields.key)
  form.set('policy', policy.fields.policy)
  form.set('OSSAccessKeyId', policy.fields.OSSAccessKeyId)
  form.set('signature', policy.fields.signature)
  form.set('x-oss-object-acl', policy.fields['x-oss-object-acl'])
  form.set('x-oss-forbid-overwrite', policy.fields['x-oss-forbid-overwrite'])
  form.set('success_action_status', policy.fields.success_action_status)
  form.set('file', file, file.name)

  const response = await fetch(policy.uploadHost, { method: 'POST', body: form })
  if (!response.ok) {
    throw new Error(`语音识别音频上传到阿里云失败 (${response.status})`)
  }
}

export function parseCloudMcpTranscription(
  result: CloudTranscriptionResponse,
  fallbackDurationSeconds = 0,
): CloudMcpTranscription {
  if (result.status === 'no_speech') {
    return { text: '', segments: [], noSpeech: true }
  }
  const text = result.text?.trim() ?? ''
  if (result.status !== 'succeeded' || !text) {
    throw new Error('剪好 MCP 语音识别返回了无效结果。')
  }
  const reportedDuration = Number(result.durationSeconds)
  const durationSeconds =
    Number.isFinite(reportedDuration) && reportedDuration > 0
      ? reportedDuration
      : Math.max(0.01, fallbackDurationSeconds)
  return {
    text,
    segments: text ? [{ text, start: 0, end: durationSeconds }] : [],
  }
}

export async function transcribeWithCloudMcp(
  file: File,
  config: CloudMcpConfig,
  fallbackDurationSeconds = 0,
): Promise<CloudMcpTranscription> {
  const desktop = window.freecutDesktop
  if (desktop) {
    const handle = getDesktopFileDescriptor(file) ?? undefined
    const body = await desktop.asr.transcribe({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      handle,
      bytes: handle ? undefined : new Uint8Array(await file.arrayBuffer()),
    })
    return parseCloudMcpTranscription(
      body.result as CloudTranscriptionResponse,
      fallbackDurationSeconds,
    )
  }
  assertValidBusinessKey(config.businessKey)
  const fileName = file.name || 'media.bin'
  const mimeType = file.type || 'application/octet-stream'
  const policy = await requestUploadPolicy(fileName, mimeType, config.businessKey)
  await uploadToAliyun(policy, file)

  const response = await fetch('/__freecut_dev_mcp/api/v1/transcribe', {
    method: 'POST',
    headers: devMcpHeaders(config.businessKey),
    body: JSON.stringify({
      audioUrl: policy.audioUrl,
      context: `FreeCut Web: ${fileName} (${mimeType})`,
      idempotencyKey: `freecut-web-asr-${crypto.randomUUID()}`,
    }),
  })
  const body = (await response.json().catch(() => ({}))) as CloudTranscriptionResponse
  if (!response.ok) {
    if (body.errorCode === NO_SPEECH_ERROR_CODE) {
      return { text: '', segments: [], noSpeech: true }
    }
    throw new Error(body.error?.trim() || `剪好 MCP 语音识别请求失败 (${response.status})`)
  }
  return parseCloudMcpTranscription(body, fallbackDurationSeconds)
}
