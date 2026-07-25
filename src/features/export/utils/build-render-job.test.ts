import { describe, expect, it, vi } from 'vitest'
import type { ExportableSequence } from '@/features/export/deps/timeline-compositions'
import type { ExtendedExportSettings } from '@/types/export'

vi.mock('./render-pipeline', () => ({
  resolveClientSettings: vi.fn(async (_settings: ExtendedExportSettings, fps: number) => ({
    clientSettings: {
      mode: 'video',
      codec: 'avc',
      audioCodec: 'aac',
      container: 'mp4',
      quality: 'high',
      resolution: { width: 1920, height: 1080 },
      fps,
      subtitleMode: 'burn',
    },
    exportMode: 'video',
  })),
}))

import { buildRenderJob } from './build-render-job'

describe('buildRenderJob', () => {
  it('freezes nested compositions with the queued timeline snapshot', async () => {
    const nestedItem = {
      id: 'nested-text',
      type: 'text' as const,
      trackId: 'nested-track',
      from: 0,
      durationInFrames: 30,
      label: 'Nested title',
      text: 'Before enqueue',
      fontSize: 64,
      fontFamily: 'Inter',
      fontWeight: 'bold' as const,
      fontStyle: 'normal' as const,
      underline: false,
      color: '#ffffff',
      letterSpacing: 0,
      backgroundColor: 'transparent',
      backgroundRadius: 0,
      textAlign: 'center' as const,
      verticalAlign: 'middle' as const,
      lineHeight: 1.2,
      textPadding: 0,
    }
    const nestedTrack = {
      id: 'nested-track',
      name: 'V1',
      kind: 'video' as const,
      height: 64,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
      order: 0,
      items: [nestedItem],
    }
    const nestedComposition = {
      id: 'nested-comp',
      name: 'Nested',
      items: [nestedItem],
      tracks: [nestedTrack],
      transitions: [],
      keyframes: [],
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 30,
    }
    const wrapperItem = {
      id: 'wrapper',
      type: 'composition' as const,
      trackId: 'main-track',
      from: 0,
      durationInFrames: 30,
      label: 'Nested',
      compositionId: nestedComposition.id,
      compositionWidth: 1920,
      compositionHeight: 1080,
    }
    const sequence: ExportableSequence = {
      id: null,
      name: 'Main Timeline',
      tracks: [
        {
          id: 'main-track',
          name: 'V1',
          kind: 'video',
          height: 64,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
          items: [wrapperItem],
        },
      ],
      items: [wrapperItem],
      transitions: [],
      keyframes: [],
      fps: 30,
      width: 1920,
      height: 1080,
      masterBusDb: 0,
      durationFrames: 30,
      inPoint: null,
      outPoint: null,
      markers: [],
      compositions: [nestedComposition],
    }
    const settings: ExtendedExportSettings = {
      mode: 'video',
      codec: 'h264',
      quality: 'high',
      resolution: { width: 1920, height: 1080 },
      videoContainer: 'mp4',
      subtitleMode: 'burn',
    }

    const job = await buildRenderJob({ settings, sequence })
    nestedItem.text = 'Edited after enqueue'

    const frozen = job.snapshot.compositions?.[0]?.items[0]
    expect(frozen?.type).toBe('text')
    expect(frozen && 'text' in frozen ? frozen.text : null).toBe('Before enqueue')
    expect(job.snapshot.compositions).not.toBe(sequence.compositions)
  })
})
