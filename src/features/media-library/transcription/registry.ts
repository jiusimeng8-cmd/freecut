import type { MediaTranscriptModel } from '@/types/storage'

const MEDIA_TRANSCRIPTION_MODEL_LABELS: Record<MediaTranscriptModel, string> = {
  'parakeet-tdt-v3': 'Parakeet (fast)',
  'whisper-tiny': 'Tiny',
  'whisper-base': 'Base',
  'whisper-small': 'Small',
  'whisper-large': 'Large v3 Turbo',
  'fun-asr': '剪好云端语音识别',
}

export function getMediaTranscriptionModelLabel(model: MediaTranscriptModel): string {
  return MEDIA_TRANSCRIPTION_MODEL_LABELS[model] ?? model
}
