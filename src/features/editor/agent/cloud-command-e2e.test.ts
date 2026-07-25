import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useItemsStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import {
  makeTimelineTrack,
  makeTimelineVideoItem,
  resetTimelineCompositionTestState,
} from '@/features/editor/deps/timeline-test-helpers-contract'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import type { SubtitleSegmentItem } from '@/types/timeline'
import {
  LEGACY_CLOUD_COMMAND_VERSION,
  listCloudCommandCapabilities,
  type CloudCommandTargetParam,
  type CloudCommandType,
} from './cloud-command-contract'
import {
  describeCloudCommand,
  executeCloudCommand,
  parseCloudBridgeCommand,
} from './cloud-command-runner'
import { buildClipRefs, getEditorTool, type ToolResult } from './tools'

const silenceMocks = vi.hoisted(() => ({
  analyzeSilenceForItems: vi.fn(),
}))

vi.mock('@/features/editor/deps/timeline-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/editor/deps/timeline-contract')>()),
  analyzeSilenceForItems: silenceMocks.analyzeSilenceForItems,
}))

type VerificationLevel =
  | 'local-store'
  | 'transcript-service'
  | 'project-storage'
  | 'media-storage'
  | 'filesystem'
  | 'cloud-asr'
  | 'render-workspace'

interface CloudCommandMatrixRow {
  type: CloudCommandType
  tool: string
  params: Record<string, unknown>
  targetId?: string
  targetParam?: CloudCommandTargetParam
  expectedArgs: Record<string, unknown>
  verification: VerificationLevel
}

const CLOUD_COMMAND_MATRIX: readonly CloudCommandMatrixRow[] = [
  {
    type: 'timeline.read_project',
    tool: 'read_project',
    params: { projectId: 'project-1' },
    expectedArgs: { projectId: 'project-1' },
    verification: 'project-storage',
  },
  {
    type: 'timeline.read_timeline',
    tool: 'read_timeline',
    params: { scope: 'main', detail: 'full' },
    expectedArgs: { scope: 'main', detail: 'full' },
    verification: 'local-store',
  },
  {
    type: 'timeline.read_media',
    tool: 'read_media',
    params: { projectId: 'project-1', mediaIds: ['media-1'] },
    expectedArgs: { projectId: 'project-1', mediaIds: ['media-1'] },
    verification: 'media-storage',
  },
  {
    type: 'timeline.find_clips',
    tool: 'find_clips',
    params: { type: 'video' },
    expectedArgs: { type: 'video' },
    verification: 'local-store',
  },
  {
    type: 'timeline.search_transcript',
    tool: 'search_transcript',
    params: { query: 'mistake' },
    expectedArgs: { query: 'mistake' },
    verification: 'transcript-service',
  },
  {
    type: 'timeline.import_local_media',
    tool: 'import_local_media',
    params: { path: 'D:\\clips', atSeconds: 0, recursive: true },
    expectedArgs: { path: 'D:\\clips', atSeconds: 0, recursive: true },
    verification: 'filesystem',
  },
  {
    type: 'timeline.generate_captions',
    tool: 'generate_captions',
    params: { clips: ['c1'], replaceExisting: true },
    expectedArgs: { clips: ['c1'], replaceExisting: true },
    verification: 'cloud-asr',
  },
  {
    type: 'timeline.split',
    tool: 'split',
    params: { clips: ['c1'], atSeconds: 1 },
    expectedArgs: { clips: ['c1'], atSeconds: 1 },
    verification: 'local-store',
  },
  {
    type: 'timeline.delete_clips',
    tool: 'delete_clips',
    targetId: 'c1',
    targetParam: 'clips',
    params: {},
    expectedArgs: { clips: ['c1'] },
    verification: 'local-store',
  },
  {
    type: 'timeline.remove_silence',
    tool: 'remove_silence',
    targetId: 'c1',
    targetParam: 'clips',
    params: { mode: 'speech', minSilenceMs: 250 },
    expectedArgs: { clips: ['c1'], mode: 'speech', minSilenceMs: 250 },
    verification: 'local-store',
  },
  {
    type: 'timeline.trim_clip',
    tool: 'trim_clip',
    targetId: 'c1',
    targetParam: 'clip',
    params: { side: 'start', seconds: 0.5 },
    expectedArgs: { clip: 'c1', side: 'start', seconds: 0.5 },
    verification: 'local-store',
  },
  {
    type: 'timeline.move_clips',
    tool: 'move_clips',
    targetId: 'clip-a',
    targetParam: 'items',
    params: { deltaSeconds: 1, trackId: 'track-v1' },
    expectedArgs: { items: ['clip-a'], deltaSeconds: 1, trackId: 'track-v1' },
    verification: 'local-store',
  },
  {
    type: 'timeline.delete_items',
    tool: 'delete_items',
    targetId: 'clip-a',
    targetParam: 'items',
    params: { ripple: false },
    expectedArgs: { items: ['clip-a'], ripple: false },
    verification: 'local-store',
  },
  {
    type: 'timeline.place_media',
    tool: 'place_media',
    params: { mediaIds: ['media-broll'], atSeconds: 3, layout: 'cover' },
    expectedArgs: { mediaIds: ['media-broll'], atSeconds: 3, layout: 'cover' },
    verification: 'media-storage',
  },
  {
    type: 'timeline.add_text',
    tool: 'add_text',
    params: { text: 'Keyword', atSeconds: 20, durationSeconds: 1.5, role: 'title' },
    expectedArgs: {
      text: 'Keyword',
      atSeconds: 20,
      durationSeconds: 1.5,
      role: 'title',
    },
    verification: 'local-store',
  },
  {
    type: 'timeline.update_subtitle',
    tool: 'update_subtitle',
    targetId: 'subtitle-1',
    targetParam: 'item',
    params: { text: 'Corrected text', startSeconds: 20, endSeconds: 22 },
    expectedArgs: {
      item: 'subtitle-1',
      text: 'Corrected text',
      startSeconds: 20,
      endSeconds: 22,
    },
    verification: 'local-store',
  },
  {
    type: 'timeline.set_transform',
    tool: 'set_transform',
    targetId: 'clip-a',
    targetParam: 'items',
    params: { transform: { width: 2304, height: 1296 } },
    expectedArgs: { items: ['clip-a'], transform: { width: 2304, height: 1296 } },
    verification: 'local-store',
  },
  {
    type: 'timeline.set_keyframes',
    tool: 'set_keyframes',
    params: {
      operations: [
        {
          operation: 'add',
          item: 'clip-a',
          property: 'transform.x',
          frame: 30,
          value: 120,
          easing: 'ease-out',
        },
      ],
    },
    expectedArgs: {
      operations: [
        {
          operation: 'add',
          item: 'clip-a',
          property: 'transform.x',
          frame: 30,
          value: 120,
          easing: 'ease-out',
        },
      ],
    },
    verification: 'local-store',
  },
  {
    type: 'timeline.set_volume',
    tool: 'set_volume',
    targetId: 'c1',
    targetParam: 'clips',
    params: { volume: 0.5 },
    expectedArgs: { clips: ['c1'], volume: 0.5 },
    verification: 'local-store',
  },
  {
    type: 'timeline.set_audio',
    tool: 'set_audio',
    targetId: 'clip-a',
    targetParam: 'items',
    params: { volumeDb: -3, fadeInSeconds: 0.25, fadeOutSeconds: 0.25 },
    expectedArgs: {
      items: ['clip-a'],
      volumeDb: -3,
      fadeInSeconds: 0.25,
      fadeOutSeconds: 0.25,
    },
    verification: 'local-store',
  },
  {
    type: 'timeline.save_project',
    tool: 'save_project',
    params: { projectId: 'project-1' },
    expectedArgs: { projectId: 'project-1' },
    verification: 'project-storage',
  },
  {
    type: 'timeline.undo',
    tool: 'undo',
    params: {},
    expectedArgs: {},
    verification: 'local-store',
  },
  {
    type: 'timeline.redo',
    tool: 'redo',
    params: {},
    expectedArgs: {},
    verification: 'local-store',
  },
  {
    type: 'timeline.check_export',
    tool: 'check_export',
    params: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
    },
    expectedArgs: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
    },
    verification: 'render-workspace',
  },
  {
    type: 'timeline.enqueue_export',
    tool: 'enqueue_export',
    params: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
      fileName: 'final.mp4',
    },
    expectedArgs: {
      mode: 'video',
      codec: 'h264',
      videoContainer: 'mp4',
      subtitleMode: 'burn',
      quality: 'high',
      fileName: 'final.mp4',
    },
    verification: 'render-workspace',
  },
  {
    type: 'timeline.export_subtitles',
    tool: 'export_subtitles',
    params: { sequenceId: null, fileName: 'captions.srt', rangeMode: 'whole' },
    expectedArgs: { sequenceId: null, fileName: 'captions.srt', rangeMode: 'whole' },
    verification: 'render-workspace',
  },
]

interface LocalExecutionCase {
  type: CloudCommandType
  command: () => {
    type: CloudCommandType
    params?: Record<string, unknown>
    targetId?: string
  }
  verify: (result: ToolResult) => void
}

function makeSubtitleItem(): SubtitleSegmentItem {
  return {
    id: 'subtitle-1',
    type: 'subtitle',
    trackId: 'track-subtitle',
    from: 600,
    durationInFrames: 60,
    label: 'Transcript',
    mediaId: 'media-1',
    source: {
      type: 'transcript',
      mediaId: 'media-1',
      clipId: 'clip-a',
    },
    cues: [{ id: 'cue-1', startSeconds: 0, endSeconds: 2, text: 'Original text' }],
    color: '#ffffff',
  }
}

function seedLocalTimeline(): void {
  resetTimelineCompositionTestState()
  useTimelineSettingsStore.setState({ fps: 30, isDirty: false })
  useItemsStore.getState().setTracks([
    makeTimelineTrack({ id: 'track-v1', name: 'V1', kind: 'video', order: 0 }),
    makeTimelineTrack({
      id: 'track-subtitle',
      name: 'Subtitles',
      kind: 'video',
      order: 1,
    }),
  ])
  useItemsStore.getState().setItems([
    makeTimelineVideoItem({
      id: 'clip-a',
      trackId: 'track-v1',
      from: 0,
      durationInFrames: 300,
      label: 'A-roll mistake',
      originId: 'origin-a',
      transform: {},
    }),
    makeTimelineVideoItem({
      id: 'clip-b',
      trackId: 'track-v1',
      from: 300,
      durationInFrames: 300,
      label: 'B-roll',
      mediaId: 'media-2',
      originId: 'origin-b',
      transform: {},
    }),
    makeSubtitleItem(),
  ])
  useSelectionStore.setState({
    selectedItemIds: [],
    selectedTrackIds: [],
    activeTrackId: 'track-v1',
    selectedTrackId: 'track-v1',
  })
  useEditorStore.setState({ linkedSelectionEnabled: true })
  usePlaybackStore.setState({ currentFrame: 0, previewFrame: null })
  silenceMocks.analyzeSilenceForItems.mockReset().mockResolvedValue({
    analyzedMediaIds: ['media-1'],
    failedMediaIds: [],
    rangesByMediaId: { 'media-1': [{ start: 2, end: 4 }] },
  })
  buildClipRefs()
}

async function executeLocalCommand(input: ReturnType<LocalExecutionCase['command']>) {
  const command = parseCloudBridgeCommand({
    sequence: 0,
    type: input.type,
    params: input.params ?? {},
    ...(input.targetId ? { targetId: input.targetId } : {}),
  })
  const result = await executeCloudCommand('project-local', command)
  expect(result.isError).toBe(false)
  expect(result.structuredContent).toBeDefined()
  const structured = result.structuredContent as ToolResult
  expect(structured.ok).toBe(true)
  expect(structured.message).toEqual(expect.any(String))
  return structured
}

function createUndoableVolumeChange(): void {
  useTimelineStore.getState().updateItem('clip-a', { volume: -3 })
}

const LOCAL_EXECUTION_CASES = [
  {
    type: 'timeline.read_timeline',
    command: () => ({
      type: 'timeline.read_timeline',
      params: { scope: 'main', detail: 'full' },
    }),
    verify: (result) =>
      expect(result.data).toMatchObject({
        tracks: expect.arrayContaining([expect.objectContaining({ id: 'track-v1' })]),
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'clip-a' }),
          expect.objectContaining({ id: 'subtitle-1' }),
        ]),
      }),
  },
  {
    type: 'timeline.find_clips',
    command: () => ({ type: 'timeline.find_clips', params: { type: 'video' } }),
    verify: (result) => expect(result.data).toHaveLength(2),
  },
  {
    type: 'timeline.split',
    command: () => ({
      type: 'timeline.split',
      params: { clips: ['c1'], atSeconds: 1 },
    }),
    verify: () => expect(useTimelineStore.getState().items).toHaveLength(4),
  },
  {
    type: 'timeline.delete_clips',
    command: () => ({ type: 'timeline.delete_clips', targetId: 'c1' }),
    verify: () => {
      expect(useTimelineStore.getState().items.some((item) => item.id === 'clip-a')).toBe(false)
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-b')?.from).toBe(0)
    },
  },
  {
    type: 'timeline.remove_silence',
    command: () => ({
      type: 'timeline.remove_silence',
      targetId: 'c1',
      params: { mode: 'speech', minSilenceMs: 250 },
    }),
    verify: (result) => {
      expect(result).toMatchObject({
        changed: true,
        data: { removedRangeCount: 1, removedItemCount: 1 },
      })
      expect(silenceMocks.analyzeSilenceForItems).toHaveBeenCalledWith(
        ['clip-a'],
        expect.objectContaining({ mode: 'speech', minSilenceMs: 250 }),
      )
    },
  },
  {
    type: 'timeline.trim_clip',
    command: () => ({
      type: 'timeline.trim_clip',
      targetId: 'c1',
      params: { side: 'start', seconds: 0.5 },
    }),
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')).toMatchObject({
        from: 15,
        durationInFrames: 285,
      }),
  },
  {
    type: 'timeline.move_clips',
    command: () => ({
      type: 'timeline.move_clips',
      targetId: 'clip-a',
      params: { deltaSeconds: 1, trackId: 'track-v1' },
    }),
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')?.from).toBe(30),
  },
  {
    type: 'timeline.delete_items',
    command: () => ({
      type: 'timeline.delete_items',
      targetId: 'clip-a',
      params: { ripple: false },
    }),
    verify: () => {
      expect(useTimelineStore.getState().items.some((item) => item.id === 'clip-a')).toBe(false)
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-b')?.from).toBe(300)
    },
  },
  {
    type: 'timeline.add_text',
    command: () => ({
      type: 'timeline.add_text',
      params: { text: 'Keyword', atSeconds: 20, durationSeconds: 1.5, role: 'title' },
    }),
    verify: () =>
      expect(useTimelineStore.getState().items).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Keyword' }),
      ),
  },
  {
    type: 'timeline.update_subtitle',
    command: () => ({
      type: 'timeline.update_subtitle',
      targetId: 'subtitle-1',
      params: { text: 'Corrected text', startSeconds: 20, endSeconds: 22 },
    }),
    verify: () =>
      expect(
        useTimelineStore.getState().items.find((item) => item.id === 'subtitle-1'),
      ).toMatchObject({
        cues: [expect.objectContaining({ text: 'Corrected text' })],
      }),
  },
  {
    type: 'timeline.set_transform',
    command: () => ({
      type: 'timeline.set_transform',
      targetId: 'clip-a',
      params: { transform: { width: 2304, height: 1296 } },
    }),
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')).toMatchObject({
        transform: { width: 2304, height: 1296 },
      }),
  },
  {
    type: 'timeline.set_keyframes',
    command: () => ({
      type: 'timeline.set_keyframes',
      params: {
        operations: [
          {
            operation: 'add',
            item: 'clip-a',
            property: 'transform.x',
            frame: 30,
            value: 120,
            easing: 'ease-out',
          },
        ],
      },
    }),
    verify: (result) => expect(result.data).toMatchObject({ createdIds: [expect.any(String)] }),
  },
  {
    type: 'timeline.set_volume',
    command: () => ({
      type: 'timeline.set_volume',
      targetId: 'c1',
      params: { volume: 0.5 },
    }),
    verify: () =>
      expect(
        useTimelineStore.getState().items.find((item) => item.id === 'clip-a')?.volume,
      ).toBeCloseTo(-6.0206, 3),
  },
  {
    type: 'timeline.set_audio',
    command: () => ({
      type: 'timeline.set_audio',
      targetId: 'clip-a',
      params: { volumeDb: -3, fadeInSeconds: 0.25, fadeOutSeconds: 0.25 },
    }),
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')).toMatchObject({
        volume: -3,
        audioFadeIn: 0.25,
        audioFadeOut: 0.25,
      }),
  },
  {
    type: 'timeline.undo',
    command: () => {
      createUndoableVolumeChange()
      return { type: 'timeline.undo', params: {} }
    },
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')?.volume).toBe(
        undefined,
      ),
  },
  {
    type: 'timeline.redo',
    command: () => {
      createUndoableVolumeChange()
      useTimelineCommandStore.getState().undo()
      return { type: 'timeline.redo', params: {} }
    },
    verify: () =>
      expect(useTimelineStore.getState().items.find((item) => item.id === 'clip-a')?.volume).toBe(
        -3,
      ),
  },
] as const satisfies readonly LocalExecutionCase[]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cloud P0 command matrix', () => {
  it('freezes the exact 26 command identities in contract order', () => {
    const capabilities = listCloudCommandCapabilities(LEGACY_CLOUD_COMMAND_VERSION)
    expect(CLOUD_COMMAND_MATRIX).toHaveLength(26)
    expect(capabilities).toHaveLength(26)
    expect(capabilities.map((entry) => entry.type)).toEqual(
      CLOUD_COMMAND_MATRIX.map((row) => row.type),
    )
    expect(new Set(CLOUD_COMMAND_MATRIX.map((row) => row.type)).size).toBe(26)

    for (const row of CLOUD_COMMAND_MATRIX) {
      const capability = capabilities.find((entry) => entry.type === row.type)
      expect(capability, row.type).toBeDefined()
      expect(capability?.tool).toBe(row.tool)
      expect(capability?.targetParam).toBe(row.targetParam)
      expect(capability?.paramsSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      })
    }
  })

  it.each(CLOUD_COMMAND_MATRIX)(
    '$type maps, validates, and dispatches through the Registry',
    async (row) => {
      const command = parseCloudBridgeCommand({
        sequence: 0,
        type: row.type,
        params: row.params,
        ...(row.targetId ? { targetId: row.targetId } : {}),
      })
      const step = describeCloudCommand(command)

      expect(step.tool).toBe(row.tool)
      expect(step.args).toEqual(row.expectedArgs)

      const tool = getEditorTool(row.tool)
      expect(tool, row.type).toBeDefined()
      const executeSpy = vi.spyOn(tool!, 'execute').mockResolvedValue({
        ok: true,
        message: `Executed ${row.tool}.`,
        changed: !tool!.readOnly,
      })
      const result = await executeCloudCommand('project-1', command)

      expect(executeSpy).toHaveBeenCalledOnce()
      expect(executeSpy).toHaveBeenCalledWith(row.expectedArgs)
      if (tool!.readOnly) {
        expect(result).toMatchObject({
          isError: false,
          structuredContent: {
            ok: true,
            message: `Executed ${row.tool}.`,
          },
        })
      } else {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            error: { code: 'WRITE_RESULT_MISMATCH' },
            reconciliationStatus: 'VERIFIED_NOT_APPLIED',
          },
        })
      }
    },
  )

  it('preserves explicit target params instead of overwriting them with targetId', () => {
    const arrayTarget = describeCloudCommand(
      parseCloudBridgeCommand({
        sequence: 0,
        type: 'timeline.set_volume',
        targetId: 'c1',
        params: { clips: ['c2'], volume: 0.75 },
      }),
    )
    const scalarTarget = describeCloudCommand(
      parseCloudBridgeCommand({
        sequence: 1,
        type: 'timeline.update_subtitle',
        targetId: 'subtitle-1',
        params: { item: 'subtitle-2', text: 'Keep explicit target' },
      }),
    )

    expect(arrayTarget.args).toEqual({ clips: ['c2'], volume: 0.75 })
    expect(scalarTarget.args).toEqual({ item: 'subtitle-2', text: 'Keep explicit target' })
  })
})

describe('cloud P0 local execution evidence', () => {
  beforeEach(seedLocalTimeline)

  it('executes every command classified as local-store', () => {
    const matrixTypes = CLOUD_COMMAND_MATRIX.filter(
      (row) => row.verification === 'local-store',
    ).map((row) => row.type)
    expect([...LOCAL_EXECUTION_CASES.map((row) => row.type)].sort()).toEqual(
      [...matrixTypes].sort(),
    )
    expect(LOCAL_EXECUTION_CASES).toHaveLength(16)
  })

  it.each(LOCAL_EXECUTION_CASES)(
    '$type reads or mutates the real local editor stores',
    async (row) => {
      const result = await executeLocalCommand(row.command())
      row.verify(result)
    },
  )

  it('keeps service and renderer boundaries out of the in-memory execution claim', () => {
    expect(
      CLOUD_COMMAND_MATRIX.filter((row) => row.verification !== 'local-store').map((row) => [
        row.type,
        row.verification,
      ]),
    ).toEqual([
      ['timeline.read_project', 'project-storage'],
      ['timeline.read_media', 'media-storage'],
      ['timeline.search_transcript', 'transcript-service'],
      ['timeline.import_local_media', 'filesystem'],
      ['timeline.generate_captions', 'cloud-asr'],
      ['timeline.place_media', 'media-storage'],
      ['timeline.save_project', 'project-storage'],
      ['timeline.check_export', 'render-workspace'],
      ['timeline.enqueue_export', 'render-workspace'],
      ['timeline.export_subtitles', 'render-workspace'],
    ])
  })
})
