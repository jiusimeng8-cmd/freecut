import { beforeEach, describe, expect, it } from 'vitest'
import {
  useCompositionNavigationStore,
  useItemsStore,
  useKeyframesStore,
  useSequencesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTransitionsStore,
} from '@/features/editor/deps/timeline-contract'
import {
  makeTimelineTrack,
  makeTimelineVideoItem,
  resetTimelineCompositionTestState,
} from '@/features/editor/deps/timeline-test-helpers-contract'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import type { MediaMetadata } from '@/types/storage'
import type { SubtitleSegmentItem, TextItem } from '@/types/timeline'
import {
  CLOUD_COMPOSITE_FINGERPRINT_VERSION,
  CLOUD_COMPOSITE_SNAPSHOT_SCHEMA,
  captureCloudCompositeSnapshot,
} from './cloud-bridge-snapshots'

const media: MediaMetadata = {
  id: 'media-1',
  storageType: 'workspace',
  fileName: 'secret-file.mov',
  fileSize: 1_000,
  mimeType: 'video/mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  bitrate: 1_000_000,
  audioCodec: 'aac',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}

function seedCompositeState(): void {
  resetTimelineCompositionTestState()
  useCompositionNavigationStore.getState().resetToRoot()
  useSequencesStore.getState().reset()
  useTimelineCommandStore.getState().clearHistory()
  useTimelineSettingsStore.setState({
    fps: 30,
    scrollPosition: 0,
    snapEnabled: true,
    isDirty: false,
    isTimelineLoading: false,
  })
  usePlaybackStore.setState({
    currentFrame: 0,
    previewFrame: null,
    busAudioEq: undefined,
    masterBusDb: 0,
  })
  useSelectionStore.setState({
    selectedItemIds: [],
    selectedTrackIds: [],
    activeTrackId: 'track-v1',
    selectedTrackId: 'track-v1',
  })
  useEditorStore.setState({ linkedSelectionEnabled: true })
  useItemsStore.getState().setTracks([
    makeTimelineTrack({
      id: 'track-v1',
      name: 'Private dialogue track',
      kind: 'video',
      order: 0,
    }),
    makeTimelineTrack({
      id: 'track-caption',
      name: 'Private captions',
      kind: 'video',
      order: 1,
    }),
  ])
  const text: TextItem = {
    id: 'text-1',
    type: 'text',
    trackId: 'track-caption',
    from: 30,
    durationInFrames: 60,
    label: 'Private title label',
    text: 'Private title content',
    color: '#ffffff',
  }
  const subtitle: SubtitleSegmentItem = {
    id: 'subtitle-1',
    type: 'subtitle',
    trackId: 'track-caption',
    from: 0,
    durationInFrames: 90,
    label: 'Private subtitle label',
    color: '#ffffff',
    source: {
      type: 'transcript',
      mediaId: 'media-1',
      clipId: 'video-1',
    },
    cues: [
      {
        id: 'cue-1',
        startSeconds: 0,
        endSeconds: 3,
        text: 'Private subtitle content',
      },
    ],
  }
  useItemsStore.getState().setItems([
    makeTimelineVideoItem({
      id: 'video-1',
      trackId: 'track-v1',
      from: 0,
      durationInFrames: 300,
      mediaId: 'media-1',
      originId: 'origin-1',
      src: 'blob:private-session-url',
      transform: { x: 0, y: 0, opacity: 1 },
      effects: [],
    }),
    text,
    subtitle,
  ])
  useKeyframesStore.getState().setKeyframes([])
  useTransitionsStore.getState().setTransitions([])
  useProjectStore.setState({
    projects: [],
    currentProject: {
      id: 'project-1',
      name: 'Private project name',
      description: 'Private project description',
      createdAt: 1,
      updatedAt: 7,
      duration: 10,
      metadata: { width: 1920, height: 1080, fps: 30 },
    },
    isLoading: false,
    error: null,
  })
  useMediaLibraryStore.setState({
    currentProjectId: 'project-1',
    mediaItems: [media],
    mediaById: { [media.id]: media },
    importingIds: [],
    brokenMediaInfo: new Map(),
    proxyStatus: new Map(),
    interpolationStatus: new Map(),
    upscaleStatus: new Map(),
    transcriptStatus: new Map([['media-1', 'ready']]),
  })
}

describe('Renderer composite snapshot', () => {
  beforeEach(seedCompositeState)

  it('keeps a stable semantic fingerprint and excludes local/private content', () => {
    const before = captureCloudCompositeSnapshot('project-1')

    usePlaybackStore.setState({ currentFrame: 180 })
    useSelectionStore.setState({ selectedItemIds: ['video-1'] })
    useItemsStore.setState((state) => ({
      items: state.items.map((item) =>
        item.id === 'video-1' && item.type === 'video'
          ? { ...item, src: 'blob:another-session-url' }
          : item,
      ),
    }))
    const afterViewOnlyChanges = captureCloudCompositeSnapshot('project-1')

    expect(before.schema).toBe(CLOUD_COMPOSITE_SNAPSHOT_SCHEMA)
    expect(before.fingerprintVersion).toBe(CLOUD_COMPOSITE_FINGERPRINT_VERSION)
    expect(afterViewOnlyChanges.hash).toBe(before.hash)
    expect(afterViewOnlyChanges.fingerprints).toEqual(before.fingerprints)
    expect(before.timeline).toMatchObject({
      trackCount: 2,
      itemCount: 3,
      textCount: 1,
    })
    expect(before.captions.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'subtitle-1',
          sourceType: 'transcript',
          cueCount: 1,
        }),
      ]),
    )

    const serialized = JSON.stringify(before)
    expect(serialized).not.toContain('Private title content')
    expect(serialized).not.toContain('Private subtitle content')
    expect(serialized).not.toContain('Private project name')
    expect(serialized).not.toContain('secret-file.mov')
    expect(serialized).not.toContain('blob:')
  })

  it('changes domain fingerprints for timeline, caption, and asset readiness state', () => {
    const base = captureCloudCompositeSnapshot('project-1')

    useItemsStore.setState((state) => ({
      items: state.items.map((item) =>
        item.id === 'video-1'
          ? {
              ...item,
              volume: -6,
              effects: [
                {
                  id: 'fx-1',
                  enabled: true,
                  effect: {
                    type: 'gpu-effect',
                    gpuEffectType: 'gpu-blur',
                    params: { amount: 0.5 },
                  },
                },
              ],
            }
          : item,
      ),
    }))
    const timelineChanged = captureCloudCompositeSnapshot('project-1')
    expect(timelineChanged.fingerprints.timeline).not.toBe(base.fingerprints.timeline)
    expect(timelineChanged.hash).not.toBe(base.hash)

    useItemsStore.setState((state) => ({
      items: state.items.map((item) =>
        item.id === 'subtitle-1' && item.type === 'subtitle'
          ? {
              ...item,
              cues: item.cues.map((cue) => ({ ...cue, text: 'Corrected subtitle content' })),
            }
          : item,
      ),
    }))
    const captionChanged = captureCloudCompositeSnapshot('project-1')
    expect(captionChanged.fingerprints.captions).not.toBe(timelineChanged.fingerprints.captions)

    useMediaLibraryStore.setState({
      proxyStatus: new Map([['media-1', 'generating']]),
      transcriptStatus: new Map([['media-1', 'error']]),
    })
    const assetChanged = captureCloudCompositeSnapshot('project-1')
    expect(assetChanged.fingerprints.assets).not.toBe(captionChanged.fingerprints.assets)
    expect(assetChanged.assets.readiness[0]).toMatchObject({
      id: 'media-1',
      transcriptStatus: 'error',
      proxy: 'generating',
    })
  })
})
