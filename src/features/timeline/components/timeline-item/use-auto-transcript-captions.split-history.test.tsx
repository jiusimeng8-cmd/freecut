import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { SubtitleSegmentItem } from '@/types/timeline'
import { useEditorStore } from '@/shared/state/editor'
import { useSelectionStore } from '@/shared/state/selection'
import { makeTimelineAudioItem, makeTimelineTrack, makeTimelineVideoItem } from '../../test-helpers'
import { mediaTranscriptionService } from '../../deps/media-transcription-service'
import { splitItem } from '../../stores/actions/item-actions'
import { useItemsStore } from '../../stores/items-store'
import { selectReplaceableCaptionClipIds } from '../../stores/items-store-indexes'
import { useKeyframesStore } from '../../stores/keyframes-store'
import { useTimelineCommandStore } from '../../stores/timeline-command-store'
import { useTimelineSettingsStore } from '../../stores/timeline-settings-store'
import { useTimelineStore } from '../../stores/timeline-store'
import { useTransitionsStore } from '../../stores/transitions-store'
import { useAutoTranscriptCaptions } from './use-auto-transcript-captions'

function makeSubtitleItem(id: string, from: number, durationInFrames: number): SubtitleSegmentItem {
  return {
    id,
    type: 'subtitle',
    trackId: 'track-captions',
    from,
    durationInFrames,
    label: 'Transcript',
    color: '#ffffff',
    mediaId: 'media-1',
    linkedGroupId: 'group-1',
    source: {
      type: 'transcript',
      mediaId: 'media-1',
      clipId: 'video-1',
    },
    cues: [
      {
        id: `${id}-cue`,
        startSeconds: 0,
        endSeconds: durationInFrames / 30,
        text: id,
      },
    ],
  }
}

describe('useAutoTranscriptCaptions after split', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    useTimelineCommandStore.getState().clearHistory()
    useTimelineSettingsStore.setState({ fps: 30, isDirty: false })
    useEditorStore.setState({ linkedSelectionEnabled: true })
    useItemsStore.getState().setTracks([
      makeTimelineTrack({
        id: 'track-captions',
        name: 'Captions',
        kind: 'video',
        order: -1,
      }),
      makeTimelineTrack({ id: 'track-v1', name: 'V1', kind: 'video', order: 0 }),
      makeTimelineTrack({ id: 'track-a1', name: 'A1', kind: 'audio', order: 1 }),
    ])
    useItemsStore.getState().setItems([
      makeTimelineVideoItem({
        id: 'video-1',
        durationInFrames: 60,
        sourceEnd: 60,
        speed: 1.25,
        linkedGroupId: 'group-1',
      }),
      makeTimelineAudioItem({
        id: 'audio-1',
        durationInFrames: 60,
        sourceEnd: 60,
        speed: 1,
        linkedGroupId: 'group-1',
      }),
      makeSubtitleItem('subtitle-left', 5, 10),
      makeSubtitleItem('subtitle-right', 40, 10),
    ])
    useTransitionsStore.getState().setTransitions([])
    useKeyframesStore.getState().setKeyframes([])
    useSelectionStore.getState().clearSelection()
  })

  it('keeps the right subtitle owned by the right clip without adding UPDATE_ITEM history', async () => {
    expect(splitItem('video-1', 30)).not.toBeNull()

    const rightVideo = useItemsStore
      .getState()
      .items.find((item) => item.type === 'video' && item.id !== 'video-1')
    expect(rightVideo?.type).toBe('video')
    if (!rightVideo || rightVideo.type !== 'video') {
      throw new Error('Missing right split video')
    }

    const rightSubtitle = useItemsStore.getState().itemById['subtitle-right']
    expect(rightSubtitle?.type).toBe('subtitle')
    if (!rightSubtitle || rightSubtitle.type !== 'subtitle') {
      throw new Error('Missing right subtitle')
    }
    expect('clipId' in rightSubtitle.source ? rightSubtitle.source.clipId : null).toBe(
      rightVideo.id,
    )

    const hasGeneratedCaptions = selectReplaceableCaptionClipIds(useItemsStore.getState()).has(
      rightVideo.id,
    )
    expect(hasGeneratedCaptions).toBe(true)

    const enableTranscriptCaptions = vi
      .spyOn(mediaTranscriptionService, 'enableTranscriptCaptions')
      .mockImplementation(async () => {
        useTimelineStore.getState().updateItem(rightVideo.id, {
          transcriptCaptions: {
            type: 'transcript',
            mediaId: rightVideo.mediaId!,
            enabled: true,
            updatedAt: Date.now(),
            cues: [],
          },
        })
        return { updatedClipCount: 1, removedItemCount: 0 }
      })

    renderHook(() =>
      useAutoTranscriptCaptions({
        item: rightVideo,
        caption: {
          canManageCaptions: true,
          canExtractEmbeddedSubtitles: false,
          hasConsolidatablePerCueCaptions: false,
          mediaHasTranscript: true,
          handleExtractEmbeddedSubtitles: undefined,
          handleConsolidateCaptionsToSegment: undefined,
        },
        hasGeneratedCaptions,
        isBroken: false,
      }),
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(enableTranscriptCaptions).not.toHaveBeenCalled()
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBe('SPLIT_ITEM')

    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items).toHaveLength(4)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)

    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items).toHaveLength(5)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
  })
})
