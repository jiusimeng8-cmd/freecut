import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { VideoItem } from '@/types/timeline'
import {
  useItemsStore,
  useKeyframesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTransitionsStore,
} from '@/features/editor/deps/timeline-contract'
import { useEditorStore } from '@/shared/state/editor'
import { useSelectionStore } from '@/shared/state/selection'

const silenceMocks = vi.hoisted(() => ({
  analyzeSilenceForItems: vi.fn(),
}))

vi.mock('@/features/editor/deps/timeline-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/editor/deps/timeline-contract')>()),
  analyzeSilenceForItems: silenceMocks.analyzeSilenceForItems,
}))

import { getEditorTool } from './registry'

function makeVideoItem(): VideoItem {
  return {
    id: 'video-1',
    type: 'video',
    trackId: 'video-track',
    from: 0,
    durationInFrames: 300,
    label: 'clip.mp4',
    src: 'blob:video',
    mediaId: 'media-1',
    originId: 'origin-1',
    sourceStart: 0,
    sourceEnd: 300,
    sourceDuration: 300,
    sourceFps: 30,
  }
}

describe('remove_silence tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTimelineCommandStore.getState().clearHistory()
    useTimelineSettingsStore.setState({ fps: 30, isDirty: false })
    useEditorStore.setState({ linkedSelectionEnabled: true })
    useItemsStore.getState().setItems([makeVideoItem()])
    useItemsStore.getState().setTracks([])
    useTransitionsStore.getState().setTransitions([])
    useKeyframesStore.getState().setKeyframes([])
    useSelectionStore.getState().clearSelection()
    silenceMocks.analyzeSilenceForItems.mockResolvedValue({
      analyzedMediaIds: ['media-1'],
      failedMediaIds: [],
      rangesByMediaId: { 'media-1': [{ start: 2, end: 4 }] },
    })
  })

  it('analyzes, removes, and restores silence through the unified command history', async () => {
    const tool = getEditorTool('remove_silence')
    expect(tool).toMatchObject({
      destructive: true,
      handoff: false,
    })

    const validation = tool!.validate({
      clips: ['video-1'],
      mode: 'speech',
      minSilenceMs: 250,
    })
    expect(validation.ok).toBe(true)
    if (!validation.ok) return

    const result = await tool!.execute(validation.value)
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      data: {
        removedRangeCount: 1,
        removedItemCount: 1,
        splitCount: 2,
      },
    })
    expect(silenceMocks.analyzeSilenceForItems).toHaveBeenCalledWith(
      ['video-1'],
      expect.objectContaining({ mode: 'speech', minSilenceMs: 250 }),
    )
    expect(useTimelineCommandStore.getState().getLastCommandType()).toBe('REMOVE_SILENCE')
    expect(useItemsStore.getState().items).toHaveLength(2)

    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items).toEqual([makeVideoItem()])

    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items).toHaveLength(2)
  })
})
