import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLocalHandles: vi.fn(),
  importHandles: vi.fn(),
  buildEntries: vi.fn(),
  resolveTargets: vi.fn(),
  getDuration: vi.fn(),
  planDrop: vi.fn(),
  resolveMediaUrl: vi.fn(),
  buildTimelineItems: vi.fn(),
  setTracks: vi.fn(),
  addItems: vi.fn(),
  selectItems: vi.fn(),
}))

vi.mock('@/infrastructure/storage/dev-workspace-handle', () => ({
  getDevLocalMediaHandles: mocks.getLocalHandles,
}))

vi.mock('@/features/editor/deps/media-library', () => ({
  resolveMediaUrl: mocks.resolveMediaUrl,
  useMediaLibraryStore: {
    getState: () => ({ importHandlesForPlacement: mocks.importHandles }),
  },
}))

vi.mock('@/features/editor/deps/projects', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { metadata: { width: 1920, height: 1080 } } }),
  },
}))

vi.mock('@/features/editor/deps/timeline-store', () => ({
  useTimelineStore: {
    getState: () => ({
      tracks: [{ id: 'v1', name: 'V1', order: 0, height: 64 }],
      items: [{ id: 'existing', trackId: 'v1', from: 0, durationInFrames: 1 }],
      fps: 30,
      setTracks: mocks.setTracks,
      addItems: mocks.addItems,
    }),
  },
}))

vi.mock('@/features/editor/deps/timeline-utils', () => ({
  buildDroppedMediaEntriesFromImportedMedia: mocks.buildEntries,
  buildDroppedMediaTimelineItems: mocks.buildTimelineItems,
  getDroppedMediaDurationInFrames: mocks.getDuration,
  planTrackMediaDropPlacements: mocks.planDrop,
  resolveSourceEditTrackTargets: mocks.resolveTargets,
}))

vi.mock('@/shared/state/playback', () => ({
  usePlaybackStore: { getState: () => ({ currentFrame: 15 }) },
}))

vi.mock('@/shared/state/selection', () => ({
  useSelectionStore: {
    getState: () => ({ activeTrackId: 'v1', selectItems: mocks.selectItems }),
  },
}))

import { importLocalMediaToTimeline } from './local-media-import'

describe('importLocalMediaToTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLocalHandles.mockResolvedValue([{ name: 'clip.mp4' }])
    mocks.importHandles.mockResolvedValue([{ id: 'media-1' }])
    mocks.buildEntries.mockReturnValue([
      {
        media: { duration: 2, audioCodec: 'aac' },
        mediaId: 'media-1',
        mediaType: 'video',
        label: 'clip.mp4',
      },
    ])
    mocks.resolveTargets.mockReturnValue({
      tracks: [
        { id: 'v1', name: 'V1', order: 0, height: 64 },
        { id: 'a1', name: 'A1', order: 1, height: 64 },
      ],
      videoTrackId: 'v1',
      audioTrackId: 'a1',
    })
    mocks.getDuration.mockReturnValue(60)
    mocks.planDrop.mockReturnValue({
      tracks: [
        { id: 'v1', name: 'V1', order: 0, height: 64 },
        { id: 'a1', name: 'A1', order: 1, height: 64 },
      ],
      plannedItems: [
        {
          linkVideoAudio: true,
          placements: [
            { trackId: 'v1', from: 30, durationInFrames: 60, mediaType: 'video' },
            { trackId: 'a1', from: 30, durationInFrames: 60, mediaType: 'audio' },
          ],
        },
      ],
    })
    mocks.resolveMediaUrl.mockResolvedValue('blob:media-1')
    mocks.buildTimelineItems.mockReturnValue([
      { id: 'video-1', trackId: 'v1' },
      { id: 'audio-1', trackId: 'a1' },
    ])
  })

  it('imports local handles and places linked video and audio items', async () => {
    const result = await importLocalMediaToTimeline('C:\\clips', 1)

    expect(result).toEqual({ importedCount: 1, placedCount: 2 })
    expect(mocks.planDrop).toHaveBeenCalledWith(
      expect.objectContaining({ dropFrame: 30, dropTargetTrackId: 'v1' }),
    )
    expect(mocks.addItems).toHaveBeenCalledWith([
      { id: 'video-1', trackId: 'v1' },
      { id: 'audio-1', trackId: 'a1' },
    ])
    expect(mocks.selectItems).toHaveBeenCalledWith(['video-1', 'audio-1'])
  })

  it('rejects a path with no files', async () => {
    mocks.getLocalHandles.mockResolvedValue([])

    await expect(importLocalMediaToTimeline('C:\\empty')).rejects.toThrow('contains no files')
  })

  it('requests recursive enumeration when enabled', async () => {
    await importLocalMediaToTimeline('C:\\clips', 1, true)

    expect(mocks.getLocalHandles).toHaveBeenCalledWith('C:\\clips', { recursive: true })
  })

  it('reports when imported media cannot be placed', async () => {
    mocks.resolveTargets.mockReturnValue(null)

    await expect(importLocalMediaToTimeline('C:\\clips')).rejects.toThrow(
      'no compatible timeline placement',
    )
    expect(mocks.addItems).not.toHaveBeenCalled()
  })
})
