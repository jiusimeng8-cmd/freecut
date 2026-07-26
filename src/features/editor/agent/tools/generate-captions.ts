import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import {
  mediaTranscriptionService,
  NoSpeechDetectedError,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import type { AudioItem, TimelineItem, VideoItem } from '@/types/timeline'
import { resolveTargetItems } from './clip-refs'

type CaptionableItem = (AudioItem | VideoItem) & { mediaId: string }

export interface GenerateTimelineCaptionsResult {
  mediaCount: number
  insertedCaptionCount: number
  failed: Array<{ mediaId: string; message: string }>
  /** Media with no speech in it — skipped on purpose, not a failure. */
  skipped: Array<{ mediaId: string; message: string }>
}

function isCaptionable(item: TimelineItem): item is CaptionableItem {
  return (item.type === 'video' || item.type === 'audio') && typeof item.mediaId === 'string'
}

function groupCaptionTargets(items: TimelineItem[]): Map<string, CaptionableItem[]> {
  const grouped = new Map<string, CaptionableItem[]>()
  for (const item of items) {
    if (!isCaptionable(item)) continue
    const existing = grouped.get(item.mediaId)
    if (existing) existing.push(item)
    else grouped.set(item.mediaId, [item])
  }

  for (const [mediaId, mediaItems] of grouped) {
    const videoItems = mediaItems.filter((item) => item.type === 'video')
    if (videoItems.length > 0) grouped.set(mediaId, videoItems)
  }
  return grouped
}

export async function generateTimelineCaptions(options: {
  clips?: string[]
  replaceExisting?: boolean
}): Promise<GenerateTimelineCaptionsResult> {
  const sourceItems =
    options.clips && options.clips.length > 0
      ? resolveTargetItems(options.clips)
      : useTimelineStore.getState().items
  const targets = groupCaptionTargets(sourceItems)
  if (targets.size === 0) {
    throw new Error('There are no video or audio clips to transcribe.')
  }

  let insertedCaptionCount = 0
  const failed: Array<{ mediaId: string; message: string }> = []
  const skipped: Array<{ mediaId: string; message: string }> = []
  for (const [mediaId, items] of targets) {
    try {
      const existingTranscript = await mediaTranscriptionService.getTranscript(mediaId)
      if (!existingTranscript) {
        await mediaTranscriptionService.transcribeMedia(mediaId)
      }
      useMediaLibraryStore.getState().setTranscriptStatus(mediaId, 'ready')
      const result = await mediaTranscriptionService.insertTranscriptAsCaptions(mediaId, {
        clipIds: items.map((item) => item.id),
        replaceExisting: options.replaceExisting ?? true,
        selectUpdatedClips: false,
      })
      insertedCaptionCount += result.insertedItemCount
    } catch (error) {
      // Media with no speech has nothing to caption, so the batch keeps going.
      if (error instanceof NoSpeechDetectedError) {
        useMediaLibraryStore.getState().setTranscriptStatus(mediaId, 'idle')
        skipped.push({ mediaId, message: error.message })
        continue
      }
      useMediaLibraryStore.getState().setTranscriptStatus(mediaId, 'error')
      failed.push({
        mediaId,
        message: error instanceof Error ? error.message : 'Transcription failed.',
      })
    }
  }

  return {
    mediaCount: targets.size,
    insertedCaptionCount,
    failed,
    skipped,
  }
}
