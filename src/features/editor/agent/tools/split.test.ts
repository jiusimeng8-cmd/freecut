import { beforeEach, describe, expect, it } from 'vite-plus/test'
import type { AudioItem, SubtitleSegmentItem, TimelineTrack, VideoItem } from '@/types/timeline'
import {
  useItemsStore,
  useKeyframesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
  useTransitionsStore,
} from '@/features/editor/deps/timeline-contract'
import { useEditorStore } from '@/shared/state/editor'
import { useSelectionStore } from '@/shared/state/selection'
import { buildClipRefs } from './clip-refs'
import { callMcpTool } from './mcp'

function makeTrack(
  overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'name' | 'order' | 'kind'>,
): TimelineTrack {
  return {
    height: 80,
    locked: false,
    syncLock: true,
    visible: true,
    muted: false,
    solo: false,
    volume: 0,
    items: [],
    ...overrides,
  }
}

function makeVideoItem(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id: 'video-1',
    type: 'video',
    trackId: 'track-v1',
    from: 0,
    durationInFrames: 944,
    label: 'clip.mp4',
    src: 'blob:video',
    mediaId: 'media-1',
    sourceStart: 0,
    sourceEnd: 944,
    sourceDuration: 1_200,
    sourceFps: 60,
    originId: 'origin-1',
    linkedGroupId: 'group-1',
    ...overrides,
  }
}

function makeAudioItem(overrides: Partial<AudioItem> = {}): AudioItem {
  return {
    id: 'audio-1',
    type: 'audio',
    trackId: 'track-a1',
    from: 0,
    durationInFrames: 944,
    label: 'clip.mp4',
    src: 'blob:audio',
    mediaId: 'media-1',
    sourceStart: 0,
    sourceEnd: 944,
    sourceDuration: 1_200,
    sourceFps: 60,
    originId: 'origin-1',
    linkedGroupId: 'group-1',
    ...overrides,
  }
}

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
    originId: 'origin-1',
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
        endSeconds: durationInFrames / 60,
        text: id,
      },
    ],
  }
}

function clipRefFor(itemId: string): string {
  const entry = buildClipRefs().find((candidate) => candidate.itemId === itemId)
  if (!entry) throw new Error(`Missing clip ref for ${itemId}`)
  return entry.ref
}

function subtitleSourceClipId(itemId: string): string | null {
  const item = useItemsStore.getState().itemById[itemId]
  return item?.type === 'subtitle' && 'clipId' in item.source ? item.source.clipId : null
}

describe('split tool', () => {
  beforeEach(() => {
    useTimelineCommandStore.getState().clearHistory()
    useTimelineSettingsStore.setState({ fps: 60, isDirty: false })
    useEditorStore.setState({ linkedSelectionEnabled: true })
    useItemsStore
      .getState()
      .setTracks([
        makeTrack({ id: 'track-captions', name: 'V2', kind: 'video', order: -1 }),
        makeTrack({ id: 'track-v1', name: 'V1', kind: 'video', order: 0 }),
        makeTrack({ id: 'track-a1', name: 'A1', kind: 'audio', order: 1 }),
      ])
    useItemsStore.getState().setItems([])
    useTransitionsStore.getState().setTransitions([])
    useKeyframesStore.getState().setKeyframes([])
    useSelectionStore.getState().clearSelection()
  })

  it('splits synchronized video/audio while segmented subtitles share the linked group', async () => {
    useItemsStore
      .getState()
      .setItems([
        makeVideoItem(),
        makeAudioItem(),
        makeSubtitleItem('subtitle-before', 4, 66),
        makeSubtitleItem('subtitle-crossing', 100, 80),
        makeSubtitleItem('subtitle-after', 158, 387),
      ])

    const result = await callMcpTool(
      'split',
      { clips: [clipRefFor('video-1')], atSeconds: 2 },
      { requestId: 'split-linked-subtitles' },
    )

    expect(result.isError, result.content[0]?.text).toBe(false)
    expect(result.structuredContent).toMatchObject({
      ok: true,
      changed: true,
      data: {
        itemIds: ['video-1'],
        frame: 120,
      },
      finalStatus: 'succeeded',
    })
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBe('SPLIT_ITEM')

    const splitItems = useItemsStore.getState().items
    expect(splitItems).toHaveLength(7)
    const videos = splitItems
      .filter((item) => item.type === 'video')
      .sort((left, right) => left.from - right.from)
    const audios = splitItems
      .filter((item) => item.type === 'audio')
      .sort((left, right) => left.from - right.from)
    expect(
      videos.map((item) => ({ from: item.from, durationInFrames: item.durationInFrames })),
    ).toEqual([
      { from: 0, durationInFrames: 120 },
      { from: 120, durationInFrames: 824 },
    ])
    expect(
      audios.map((item) => ({ from: item.from, durationInFrames: item.durationInFrames })),
    ).toEqual([
      { from: 0, durationInFrames: 120 },
      { from: 120, durationInFrames: 824 },
    ])
    expect(
      splitItems
        .filter((item) => item.type === 'subtitle')
        .map((item) => ({
          id: item.id,
          from: item.from,
          durationInFrames: item.durationInFrames,
          linkedGroupId: item.linkedGroupId,
        })),
    ).toEqual([
      {
        id: 'subtitle-before',
        from: 4,
        durationInFrames: 66,
        linkedGroupId: videos[0]?.linkedGroupId,
      },
      {
        id: 'subtitle-crossing',
        from: 100,
        durationInFrames: 80,
        linkedGroupId: videos[0]?.linkedGroupId,
      },
      {
        id: 'subtitle-after',
        from: 158,
        durationInFrames: 387,
        linkedGroupId: videos[1]?.linkedGroupId,
      },
    ])
    expect(videos[0]?.linkedGroupId).toBe(audios[0]?.linkedGroupId)
    expect(videos[1]?.linkedGroupId).toBe(audios[1]?.linkedGroupId)
    expect(videos[0]?.linkedGroupId).not.toBe(videos[1]?.linkedGroupId)
    expect(subtitleSourceClipId('subtitle-after')).toBe(videos[1]?.id)

    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items).toHaveLength(5)
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBeNull()

    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items).toHaveLength(7)
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBe('SPLIT_ITEM')
  })

  it('returns changed=false when the timeline action rejects the split', async () => {
    useEditorStore.setState({ linkedSelectionEnabled: false })
    useItemsStore.getState().setItems([
      makeVideoItem({
        id: 'video-left',
        durationInFrames: 60,
        sourceEnd: 60,
        linkedGroupId: undefined,
      }),
      makeVideoItem({
        id: 'video-right',
        from: 60,
        durationInFrames: 60,
        sourceStart: 30,
        sourceEnd: 90,
        linkedGroupId: undefined,
      }),
    ])
    expect(
      useTimelineStore.getState().addTransition('video-left', 'video-right', 'crossfade', 20),
    ).toBe(true)
    useTimelineCommandStore.getState().clearHistory()

    const result = await callMcpTool(
      'split',
      { clips: [clipRefFor('video-left')], atSeconds: 55 / 60 },
      { requestId: 'split-transition-overlap' },
    )

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      ok: false,
      changed: false,
      finalStatus: 'failed',
    })
    expect(useItemsStore.getState().items).toHaveLength(2)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
  })

  it('splits after the targeted video speed diverges from its linked audio', async () => {
    useItemsStore
      .getState()
      .setItems([
        makeVideoItem(),
        makeAudioItem(),
        makeSubtitleItem('subtitle-before', 4, 66),
        makeSubtitleItem('subtitle-after', 158, 387),
      ])
    const videoRef = clipRefFor('video-1')

    const speedResult = await callMcpTool(
      'set_speed',
      { clips: [videoRef], speed: 1.25, preserveDuration: true },
      { requestId: 'split-after-speed-set-speed' },
    )
    expect(speedResult.structuredContent).toMatchObject({
      ok: true,
      changed: true,
    })

    const splitResult = await callMcpTool(
      'split',
      { clips: [videoRef], atSeconds: 2 },
      { requestId: 'split-after-speed-split' },
    )

    expect(splitResult.isError, splitResult.content[0]?.text).toBe(false)
    expect(splitResult.structuredContent).toMatchObject({
      ok: true,
      changed: true,
      data: {
        itemIds: ['video-1'],
        frame: 120,
      },
    })
    const items = useItemsStore.getState().items
    const videos = items
      .filter((item) => item.type === 'video')
      .sort((left, right) => left.from - right.from)
    expect(videos.map((item) => [item.from, item.durationInFrames])).toEqual([
      [0, 120],
      [120, 824],
    ])
    expect(items.filter((item) => item.type === 'audio')).toHaveLength(1)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(2)
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBe('SPLIT_ITEM')

    const rightVideo = videos[1]!
    expect(subtitleSourceClipId('subtitle-after')).toBe(rightVideo.id)
    expect(rightVideo.embeddedAudioMuted).toBe(true)

    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items).toHaveLength(4)
    expect(useItemsStore.getState().itemById['video-1']?.speed).toBe(1.25)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)

    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items).toHaveLength(5)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(2)
  })

  it('counts actual successful linked anchors instead of crossing items', async () => {
    useItemsStore.getState().setItems([
      makeVideoItem({ durationInFrames: 120, sourceEnd: 120 }),
      makeAudioItem({ durationInFrames: 120, sourceEnd: 120 }),
      makeVideoItem({
        id: 'video-2',
        trackId: 'track-captions',
        durationInFrames: 120,
        sourceEnd: 120,
        mediaId: 'media-2',
        linkedGroupId: undefined,
      }),
    ])
    const refs = ['video-1', 'audio-1', 'video-2'].map(clipRefFor)

    const result = await callMcpTool(
      'split',
      { clips: refs, atSeconds: 1 },
      { requestId: 'split-actual-count' },
    )

    expect(result.isError, result.content[0]?.text).toBe(false)
    expect(result.content[0]?.text).toBe('Split 2 clips.')
    expect(result.structuredContent).toMatchObject({
      ok: true,
      changed: true,
      data: {
        itemIds: ['video-1', 'video-2'],
        frame: 60,
      },
    })
    expect(useItemsStore.getState().items).toHaveLength(6)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(2)
  })
})
