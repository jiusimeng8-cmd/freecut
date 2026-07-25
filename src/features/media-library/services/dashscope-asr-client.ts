import type { MediaTranscriptSegment } from '@/types/storage'
import type { CloudMcpConfig } from '@/shared/state/cloud-mcp-config-store'
import { getDesktopFileDescriptor } from '@/infrastructure/storage/desktop-file-system-access'

interface CloudTranscriptionResponse {
  status?: string
  text?: string
  durationSeconds?: number
}

interface DevelopmentAsrResponse {
  result?: CloudTranscriptionResponse
  error?: string
}

export interface CloudMcpTranscription {
  text: string
  segments: MediaTranscriptSegment[]
}

function assertValidBusinessKey(businessKey: string): void {
  if (!businessKey.trim()) {
    throw new Error('请先配置剪好 MCP Key')
  }
}

export function parseCloudMcpTranscription(
  result: CloudTranscriptionResponse,
  fallbackDurationSeconds = 0,
): CloudMcpTranscription {
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
  const response = await fetch('/__freecut_dev_asr/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-FreeCut-Business-Key': encodeURIComponent(config.businessKey),
      'X-FreeCut-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  })
  const body = (await response.json()) as DevelopmentAsrResponse
  if (!response.ok || !body.result) {
    throw new Error(body.error ?? `剪好 MCP 语音识别请求失败 (${response.status})`)
  }
  return parseCloudMcpTranscription(body.result, fallbackDurationSeconds)
}
