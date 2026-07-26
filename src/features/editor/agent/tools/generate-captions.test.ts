import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineItem } from '@/types/timeline'

const mocks = vi.hoisted(() => ({
  items: [] as TimelineItem[],
  getTranscript: vi.fn(),
  transcribeMedia: vi.fn(),
  insertTranscriptAsCaptions: vi.fn(),
  setTranscriptStatus: vi.fn(),
  resolveTargetItems: vi.fn(),
  // The real class, not a stub: the tool discriminates with `instanceof`.
  NoSpeechDetectedError: class NoSpeechDetectedError extends Error {
    constructor(fileName?: string) {
      super(`"${fileName}" 中没有检测到人声，已跳过字幕生成。`)
      this.name = 'NoSpeechDetectedError'
    }
  },
}))

vi.mock('@/features/editor/deps/timeline-store', () => ({
  useTimelineStore: {
    getState: () => ({ items: mocks.items }),
  },
}))

vi.mock('@/features/editor/deps/media-library', () => ({
  mediaTranscriptionService: {
    getTranscript: mocks.getTranscript,
    transcribeMedia: mocks.transcribeMedia,
    insertTranscriptAsCaptions: mocks.insertTranscriptAsCaptions,
  },
  NoSpeechDetectedError: mocks.NoSpeechDetectedError,
  useMediaLibraryStore: {
    getState: () => ({ setTranscriptStatus: mocks.setTranscriptStatus }),
  },
}))

vi.mock('./clip-refs', () => ({
  resolveTargetItems: mocks.resolveTargetItems,
}))

const { generateTimelineCaptions } = await import('./generate-captions')

function mediaItem(id: string, mediaId: string, type: 'video' | 'audio'): TimelineItem {
  return {
    id,
    mediaId,
    type,
    trackId: type === 'video' ? 'video-track' : 'audio-track',
    label: id,
    from: 0,
    durationInFrames: 30,
  } as TimelineItem
}

describe('generateTimelineCaptions', () => {
  beforeEach(() => {
    mocks.items = []
    mocks.getTranscript.mockReset()
    mocks.transcribeMedia.mockReset()
    mocks.insertTranscriptAsCaptions.mockReset()
    mocks.setTranscriptStatus.mockReset()
    mocks.resolveTargetItems.mockReset()
    mocks.insertTranscriptAsCaptions.mockResolvedValue({
      insertedItemCount: 1,
      removedItemCount: 0,
    })
  })

  it('deduplicates linked audio/video and reuses an existing transcript', async () => {
    mocks.items = [
      mediaItem('video-1', 'media-1', 'video'),
      mediaItem('audio-1', 'media-1', 'audio'),
      mediaItem('audio-2', 'media-2', 'audio'),
    ]
    mocks.getTranscript.mockImplementation(async (mediaId: string) =>
      mediaId === 'media-1' ? { mediaId } : undefined,
    )
    mocks.transcribeMedia.mockResolvedValue({ mediaId: 'media-2' })

    const result = await generateTimelineCaptions({})

    expect(mocks.transcribeMedia).toHaveBeenCalledTimes(1)
    expect(mocks.transcribeMedia).toHaveBeenCalledWith('media-2')
    expect(mocks.insertTranscriptAsCaptions).toHaveBeenCalledWith(
      'media-1',
      expect.objectContaining({ clipIds: ['video-1'] }),
    )
    expect(mocks.insertTranscriptAsCaptions).toHaveBeenCalledWith(
      'media-2',
      expect.objectContaining({ clipIds: ['audio-2'] }),
    )
    expect(result).toEqual({
      mediaCount: 2,
      insertedCaptionCount: 2,
      failed: [],
      skipped: [],
    })
  })

  it('skips media with no speech instead of failing the batch', async () => {
    mocks.items = [
      mediaItem('audio-1', 'silent-media', 'audio'),
      mediaItem('audio-2', 'speaking-media', 'audio'),
    ]
    mocks.getTranscript.mockResolvedValue(undefined)
    mocks.transcribeMedia.mockImplementation(async (mediaId: string) => {
      if (mediaId === 'silent-media') throw new mocks.NoSpeechDetectedError('quiet.mp4')
      return { mediaId }
    })

    const result = await generateTimelineCaptions({})

    // The speaking clip still gets captions, and the silent one is not a failure.
    expect(result.insertedCaptionCount).toBe(1)
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([
      { mediaId: 'silent-media', message: expect.stringContaining('quiet.mp4') },
    ])
    expect(mocks.setTranscriptStatus).toHaveBeenCalledWith('silent-media', 'idle')
    expect(mocks.insertTranscriptAsCaptions).toHaveBeenCalledTimes(1)
    expect(mocks.insertTranscriptAsCaptions).toHaveBeenCalledWith(
      'speaking-media',
      expect.objectContaining({ clipIds: ['audio-2'] }),
    )
  })
})
