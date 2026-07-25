import { beforeEach, describe, expect, it, vi } from 'vitest'

const silenceMocks = vi.hoisted(() => ({
  analyzeSilenceForItems: vi.fn(),
}))

vi.mock('@/features/editor/deps/timeline-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/editor/deps/timeline-contract')>()),
  analyzeSilenceForItems: silenceMocks.analyzeSilenceForItems,
}))

import {
  LEGACY_CLOUD_COMMAND_VERSION,
  listCloudCommandCapabilities,
  type CloudCommandType,
} from './cloud-command-contract'
import {
  executeCloudCommand,
  parseCloudBridgeCommand,
} from './cloud-command-runner'
import { buildClipRefs } from './tools/clip-refs'
import {
  captureSnapshot,
  useCompositionsStore,
  useCompositionNavigationStore,
  useItemsStore,
  useSequencesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import type {
  AudioItem,
  SubtitleSegmentItem,
  TimelineTrack,
  VideoItem,
} from '@/types/timeline'

type UndoCoverage =
  | 'read-only'
  | 'undo-redo'
  | 'history-control'
  | 'structure-only'

interface UndoMatrixEntry {
  type: CloudCommandType
  coverage: UndoCoverage
  reason: string
}

const CLOUD_COMMAND_UNDO_MATRIX = [
  {
    type: 'timeline.read_project',
    coverage: 'read-only',
    reason: 'Reads the project snapshot.',
  },
  {
    type: 'timeline.read_timeline',
    coverage: 'read-only',
    reason: 'Reads the structured timeline snapshot.',
  },
  {
    type: 'timeline.read_media',
    coverage: 'read-only',
    reason: 'Reads media metadata.',
  },
  {
    type: 'timeline.find_clips',
    coverage: 'read-only',
    reason: 'Reads the grounded clip inventory.',
  },
  {
    type: 'timeline.search_transcript',
    coverage: 'read-only',
    reason: 'Reads transcript matches.',
  },
  {
    type: 'timeline.import_local_media',
    coverage: 'structure-only',
    reason: 'Requires the desktop or development file-system import boundary.',
  },
  {
    type: 'timeline.generate_captions',
    coverage: 'structure-only',
    reason: 'Requires configured cloud ASR and real media.',
  },
  {
    type: 'timeline.split',
    coverage: 'undo-redo',
    reason: 'Splits a timeline item through SPLIT_ITEM.',
  },
  {
    type: 'timeline.delete_clips',
    coverage: 'undo-redo',
    reason: 'Ripple-deletes timeline items through RIPPLE_DELETE_ITEMS.',
  },
  {
    type: 'timeline.remove_silence',
    coverage: 'undo-redo',
    reason: 'Removes analyzed ranges through REMOVE_SILENCE.',
  },
  {
    type: 'timeline.trim_clip',
    coverage: 'undo-redo',
    reason: 'Trims one media item through TRIM_ITEM_END.',
  },
  {
    type: 'timeline.move_clips',
    coverage: 'undo-redo',
    reason: 'Moves timeline items through MOVE_ITEMS.',
  },
  {
    type: 'timeline.delete_items',
    coverage: 'undo-redo',
    reason: 'Deletes exact timeline items through REMOVE_ITEMS.',
  },
  {
    type: 'timeline.place_media',
    coverage: 'structure-only',
    reason: 'Requires media-library records and resolvable browser media URLs.',
  },
  {
    type: 'timeline.add_text',
    coverage: 'undo-redo',
    reason: 'Adds a text item through ADD_ITEM.',
  },
  {
    type: 'timeline.update_subtitle',
    coverage: 'undo-redo',
    reason: 'Updates an editable subtitle item through UPDATE_ITEM.',
  },
  {
    type: 'timeline.set_transform',
    coverage: 'undo-redo',
    reason: 'Updates visual geometry through AGENT_SET_TRANSFORM.',
  },
  {
    type: 'timeline.set_keyframes',
    coverage: 'undo-redo',
    reason: 'Updates animation data through AGENT_SET_KEYFRAMES.',
  },
  {
    type: 'timeline.set_volume',
    coverage: 'undo-redo',
    reason: 'Updates linear clip volume through UPDATE_ITEM.',
  },
  {
    type: 'timeline.set_audio',
    coverage: 'undo-redo',
    reason: 'Updates clip audio properties through AGENT_SET_AUDIO.',
  },
  {
    type: 'timeline.save_project',
    coverage: 'structure-only',
    reason: 'Persists current state and intentionally does not add an undo entry.',
  },
  {
    type: 'timeline.undo',
    coverage: 'history-control',
    reason: 'Consumes the latest unified command-stack entry.',
  },
  {
    type: 'timeline.redo',
    coverage: 'history-control',
    reason: 'Reapplies the latest unified redo-stack entry.',
  },
  {
    type: 'timeline.check_export',
    coverage: 'read-only',
    reason: 'Builds and checks an export snapshot without queue mutation.',
  },
  {
    type: 'timeline.enqueue_export',
    coverage: 'structure-only',
    reason: 'Requires the render queue and export preflight environment.',
  },
  {
    type: 'timeline.export_subtitles',
    coverage: 'structure-only',
    reason: 'Requires the project export file-system boundary.',
  },
] as const satisfies readonly UndoMatrixEntry[]

interface CommandInput {
  params?: Record<string, unknown>
  targetId?: string
}

interface UndoCase {
  type: CloudCommandType
  expectedHistoryCommand: string
  input: () => CommandInput
}

function makeTrack(
  overrides: Partial<TimelineTrack> & Pick<TimelineTrack, 'id' | 'name' | 'order'>,
): TimelineTrack {
  return {
    height: 80,
    locked: false,
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
    durationInFrames: 120,
    label: 'clip.mp4',
    src: 'blob:video',
    mediaId: 'media-video-1',
    sourceStart: 0,
    sourceEnd: 120,
    sourceDuration: 300,
    sourceFps: 30,
    ...overrides,
  }
}

function makeAudioItem(overrides: Partial<AudioItem> = {}): AudioItem {
  return {
    id: 'audio-1',
    type: 'audio',
    trackId: 'track-a1',
    from: 0,
    durationInFrames: 120,
    label: 'voice.wav',
    src: 'blob:audio',
    mediaId: 'media-audio-1',
    sourceStart: 0,
    sourceEnd: 120,
    sourceDuration: 240,
    sourceFps: 30,
    ...overrides,
  }
}

function clipRefFor(itemId: string): string {
  const entry = buildClipRefs().find((candidate) => candidate.itemId === itemId)
  if (!entry) throw new Error(`Missing clip ref for ${itemId}`)
  return entry.ref
}

function captureUndoState(): ReturnType<typeof captureSnapshot> {
  return structuredClone(captureSnapshot())
}

async function runCloudCommand(
  type: CloudCommandType,
  { params = {}, targetId }: CommandInput = {},
) {
  const command = parseCloudBridgeCommand({
    sequence: 0,
    type,
    params,
    ...(targetId ? { targetId } : {}),
  })
  const result = await executeCloudCommand('project-undo-matrix', command)
  expect(result.isError, result.content[0]?.text).toBe(false)
  expect(result.structuredContent).toMatchObject({
    ok: true,
    requestId: expect.any(String),
    operationId: expect.any(String),
    changed: true,
    projectRevision: null,
    changeSummary: expect.any(String),
    finalStatus: 'succeeded',
    error: null,
    warnings: expect.any(Array),
  })
  return result
}

const UNDO_CASES: readonly UndoCase[] = [
  {
    type: 'timeline.split',
    expectedHistoryCommand: 'SPLIT_ITEM',
    input: () => ({
      params: { clips: [clipRefFor('video-1')], atSeconds: 2 },
    }),
  },
  {
    type: 'timeline.delete_clips',
    expectedHistoryCommand: 'RIPPLE_DELETE_ITEMS',
    input: () => ({
      targetId: clipRefFor('video-2'),
    }),
  },
  {
    type: 'timeline.remove_silence',
    expectedHistoryCommand: 'REMOVE_SILENCE',
    input: () => ({
      targetId: clipRefFor('video-1'),
      params: {
        mode: 'speech',
        minSilenceMs: 250,
      },
    }),
  },
  {
    type: 'timeline.trim_clip',
    expectedHistoryCommand: 'TRIM_ITEM_END',
    input: () => ({
      targetId: clipRefFor('video-3'),
      params: { side: 'end', seconds: 0.5 },
    }),
  },
  {
    type: 'timeline.move_clips',
    expectedHistoryCommand: 'MOVE_ITEMS',
    input: () => ({
      targetId: 'video-3',
      params: { deltaSeconds: 1 },
    }),
  },
  {
    type: 'timeline.delete_items',
    expectedHistoryCommand: 'REMOVE_ITEMS',
    input: () => ({
      targetId: 'video-3',
      params: { ripple: false },
    }),
  },
  {
    type: 'timeline.add_text',
    expectedHistoryCommand: 'ADD_ITEM',
    input: () => ({
      params: {
        text: 'Undo matrix text',
        atSeconds: 11,
        durationSeconds: 2,
        trackId: 'track-v2',
      },
    }),
  },
  {
    type: 'timeline.update_subtitle',
    expectedHistoryCommand: 'UPDATE_ITEM',
    input: () => ({
      params: {
        item: 'subtitle-1',
        text: 'Updated subtitle',
      },
    }),
  },
  {
    type: 'timeline.set_transform',
    expectedHistoryCommand: 'AGENT_SET_TRANSFORM',
    input: () => ({
      targetId: 'video-1',
      params: {
        transform: { x: 120, y: 80, opacity: 0.75 },
      },
    }),
  },
  {
    type: 'timeline.set_keyframes',
    expectedHistoryCommand: 'AGENT_SET_KEYFRAMES',
    input: () => ({
      params: {
        operations: [
          {
            operation: 'add',
            item: 'video-1',
            property: 'opacity',
            frame: 15,
            value: 0.5,
            easing: 'ease-in-out',
          },
        ],
      },
    }),
  },
  {
    type: 'timeline.set_volume',
    expectedHistoryCommand: 'AGENT_SET_VOLUME',
    input: () => ({
      targetId: clipRefFor('audio-1'),
      params: { volume: 0.5 },
    }),
  },
  {
    type: 'timeline.set_audio',
    expectedHistoryCommand: 'AGENT_SET_AUDIO',
    input: () => ({
      targetId: 'audio-1',
      params: {
        volumeDb: -9,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 0.75,
      },
    }),
  },
]

describe('cloud P0 command undo/redo matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCompositionNavigationStore.getState().resetToRoot()
    useSequencesStore.getState().reset()
    useCompositionsStore.getState().setCompositions([])
    useTimelineStore.getState().clearTimeline()
    useTimelineSettingsStore.setState({
      fps: 30,
      scrollPosition: 0,
      snapEnabled: true,
      isDirty: false,
      isTimelineLoading: false,
    })
    useItemsStore.getState().setTracks([
      makeTrack({
        id: 'track-v1',
        name: 'V1',
        kind: 'video',
        order: 0,
        syncLock: false,
      }),
      makeTrack({
        id: 'track-v2',
        name: 'V2',
        kind: 'video',
        order: 1,
        syncLock: false,
      }),
      makeTrack({
        id: 'track-a1',
        name: 'A1',
        kind: 'audio',
        order: 2,
        syncLock: false,
      }),
    ])
    const subtitle: SubtitleSegmentItem = {
      id: 'subtitle-1',
      type: 'subtitle',
      trackId: 'track-v2',
      from: 0,
      durationInFrames: 90,
      label: 'Caption',
      color: '#ffffff',
      source: {
        type: 'transcript',
        mediaId: 'media-video-1',
        clipId: 'video-1',
      },
      cues: [
        {
          id: 'cue-1',
          startSeconds: 0,
          endSeconds: 3,
          text: 'Original subtitle',
        },
      ],
    }
    useItemsStore.getState().setItems([
      makeVideoItem({
        id: 'video-1',
        trackId: 'track-v1',
        from: 0,
        durationInFrames: 120,
        mediaId: 'media-video-1',
        sourceStart: 0,
        sourceEnd: 120,
        sourceDuration: 300,
        transform: {
          x: 0,
          y: 0,
          rotation: 0,
          opacity: 1,
        },
      }),
      makeVideoItem({
        id: 'video-2',
        trackId: 'track-v1',
        from: 120,
        durationInFrames: 120,
        mediaId: 'media-video-2',
        sourceStart: 30,
        sourceEnd: 150,
        sourceDuration: 300,
      }),
      makeVideoItem({
        id: 'video-3',
        trackId: 'track-v1',
        from: 300,
        durationInFrames: 90,
        mediaId: 'media-video-3',
        sourceStart: 30,
        sourceEnd: 120,
        sourceDuration: 240,
      }),
      makeAudioItem({
        id: 'audio-1',
        trackId: 'track-a1',
        from: 0,
        durationInFrames: 120,
        mediaId: 'media-audio-1',
        sourceStart: 0,
        sourceEnd: 120,
        sourceDuration: 240,
        volume: 0,
      }),
      subtitle,
    ])
    useProjectStore.setState({
      projects: [
        {
          id: 'project-undo-matrix',
          name: 'Undo Matrix',
          description: '',
          createdAt: 1,
          updatedAt: 1,
          duration: 0,
          metadata: {
            width: 1920,
            height: 1080,
            fps: 30,
            backgroundColor: '#000000',
          },
        },
      ],
      currentProject: {
        id: 'project-undo-matrix',
        name: 'Undo Matrix',
        description: '',
        createdAt: 1,
        updatedAt: 1,
        duration: 0,
        metadata: {
          width: 1920,
          height: 1080,
          fps: 30,
          backgroundColor: '#000000',
        },
      },
      isLoading: false,
      error: null,
    })
    useEditorStore.setState({ linkedSelectionEnabled: false })
    useSelectionStore.getState().clearSelection()
    useSelectionStore.getState().setActiveTrack('track-v2')
    usePlaybackStore.setState({
      currentFrame: 0,
      currentFrameEpoch: 0,
      previewFrame: null,
      previewFrameEpoch: 0,
      frameUpdateEpoch: 0,
      previewItemId: null,
      busAudioEq: undefined,
      masterBusDb: 0,
    })
    useTimelineSettingsStore.getState().markClean()
    useTimelineCommandStore.getState().clearHistory()
    buildClipRefs()
    silenceMocks.analyzeSilenceForItems.mockResolvedValue({
      analyzedMediaIds: ['media-video-1'],
      failedMediaIds: [],
      rangesByMediaId: {
        'media-video-1': [{ start: 2, end: 3 }],
      },
    })
  })

  it('accounts for all 26 commands without treating external boundaries as executed', () => {
    const capabilities = listCloudCommandCapabilities(LEGACY_CLOUD_COMMAND_VERSION)
    const matrixTypes = CLOUD_COMMAND_UNDO_MATRIX.map((entry) => entry.type)

    expect(CLOUD_COMMAND_UNDO_MATRIX).toHaveLength(26)
    expect(new Set(matrixTypes).size).toBe(matrixTypes.length)
    expect([...matrixTypes].sort()).toEqual(
      capabilities.map((capability) => capability.type).sort(),
    )

    for (const entry of CLOUD_COMMAND_UNDO_MATRIX) {
      const capability = capabilities.find((candidate) => candidate.type === entry.type)
      expect(capability).toBeDefined()
      expect(entry.reason).toBeTruthy()
      expect(capability?.paramsSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      })

      if (entry.coverage === 'read-only') {
        expect(capability?.readOnly).toBe(true)
      } else {
        expect(capability?.readOnly).toBe(false)
      }

      if (entry.coverage === 'undo-redo') {
        expect(capability?.tool).not.toBeNull()
        expect(capability?.handoff).toBe(false)
      }
    }

    expect(
      CLOUD_COMMAND_UNDO_MATRIX.filter((entry) => entry.coverage === 'structure-only').map(
        (entry) => entry.type,
      ),
    ).toEqual([
      'timeline.import_local_media',
      'timeline.generate_captions',
      'timeline.place_media',
      'timeline.save_project',
      'timeline.enqueue_export',
      'timeline.export_subtitles',
    ])

    expect(
      capabilities.find((capability) => capability.type === 'timeline.remove_silence'),
    ).toMatchObject({
      readOnly: false,
      destructive: true,
      handoff: false,
    })
  })

  it.each(UNDO_CASES)(
    '$type records one real command-stack entry and round-trips through undo/redo',
    async ({ type, expectedHistoryCommand, input }) => {
      const before = captureUndoState()

      await runCloudCommand(type, input())

      const historyAfterExecute = useTimelineCommandStore.getState()
      expect(historyAfterExecute.undoStack).toHaveLength(1)
      expect(historyAfterExecute.redoStack).toHaveLength(0)
      expect(historyAfterExecute.canUndo).toBe(true)
      expect(historyAfterExecute.getLastCommandType()).toBe(expectedHistoryCommand)

      const after = captureUndoState()
      expect(after).not.toEqual(before)

      historyAfterExecute.undo()
      expect(captureUndoState()).toEqual(before)
      expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
      expect(useTimelineCommandStore.getState().redoStack).toHaveLength(1)

      useTimelineCommandStore.getState().redo()
      expect(captureUndoState()).toEqual(after)
      expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
      expect(useTimelineCommandStore.getState().redoStack).toHaveLength(0)
    },
  )

  it('supports continuous cloud undo and redo after multiple mutations', async () => {
    const states = [captureUndoState()]

    await runCloudCommand('timeline.set_volume', {
      targetId: clipRefFor('audio-1'),
      params: { volume: 0.5 },
    })
    states.push(captureUndoState())

    await runCloudCommand('timeline.move_clips', {
      targetId: 'video-3',
      params: { deltaSeconds: 1 },
    })
    states.push(captureUndoState())

    await runCloudCommand('timeline.add_text', {
      params: {
        text: 'Continuous history',
        atSeconds: 11,
        durationSeconds: 2,
        trackId: 'track-v2',
      },
    })
    states.push(captureUndoState())

    await runCloudCommand('timeline.remove_silence', {
      targetId: clipRefFor('video-1'),
      params: { mode: 'speech', minSilenceMs: 250 },
    })
    states.push(captureUndoState())

    expect(
      useTimelineCommandStore.getState().undoStack.map((entry) => entry.command.type),
    ).toEqual(['AGENT_SET_VOLUME', 'MOVE_ITEMS', 'ADD_ITEM', 'REMOVE_SILENCE'])

    for (let index = states.length - 2; index >= 0; index -= 1) {
      await runCloudCommand('timeline.undo')
      expect(captureUndoState()).toEqual(states[index])
    }
    expect(useTimelineCommandStore.getState()).toMatchObject({
      canUndo: false,
      canRedo: true,
    })
    expect(useTimelineCommandStore.getState().redoStack).toHaveLength(4)

    for (let index = 1; index < states.length; index += 1) {
      await runCloudCommand('timeline.redo')
      expect(captureUndoState()).toEqual(states[index])
    }
    expect(useTimelineCommandStore.getState()).toMatchObject({
      canUndo: true,
      canRedo: false,
    })
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(4)
  })
})
