import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useCompositionNavigationStore,
  useItemsStore,
  useSequencesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
} from '@/features/editor/deps/timeline-contract'
import {
  makeTimelineTrack,
  resetTimelineCompositionTestState,
} from '@/features/editor/deps/timeline-test-helpers-contract'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { captureCloudCompositeSnapshot, fingerprintCloudValue } from './cloud-bridge-snapshots'
import {
  clearCloudCommandOperationLedger,
  executeCloudCommand,
  parseCloudBridgeCommand,
} from './cloud-command-runner'
import { getEditorTool, type NormalizedToolResult } from './tools'

const projectId = 'project-runner'

function seedRunnerState(): void {
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
  useItemsStore.getState().setTracks([
    makeTimelineTrack({
      id: 'track-v1',
      name: 'V1',
      kind: 'video',
      order: 0,
    }),
  ])
  useItemsStore.getState().setItems([])
  useSelectionStore.setState({
    selectedItemIds: [],
    selectedTrackIds: [],
    activeTrackId: 'track-v1',
    selectedTrackId: 'track-v1',
  })
  useEditorStore.setState({ linkedSelectionEnabled: true })
  usePlaybackStore.setState({
    currentFrame: 0,
    previewFrame: null,
    busAudioEq: undefined,
    masterBusDb: 0,
  })
  useProjectStore.setState({
    projects: [],
    currentProject: {
      id: projectId,
      name: 'Runner',
      description: '',
      createdAt: 1,
      updatedAt: 11,
      duration: 0,
      metadata: { width: 1920, height: 1080, fps: 30 },
    },
    isLoading: false,
    error: null,
  })
  useMediaLibraryStore.setState({
    currentProjectId: projectId,
    mediaItems: [],
    mediaById: {},
    importingIds: [],
    brokenMediaInfo: new Map(),
    proxyStatus: new Map(),
    interpolationStatus: new Map(),
    upscaleStatus: new Map(),
    transcriptStatus: new Map(),
  })
  clearCloudCommandOperationLedger()
}

function addTextCommand(overrides: Record<string, unknown> = {}) {
  return parseCloudBridgeCommand({
    sequence: 0,
    type: 'timeline.add_text',
    commandId: 'command-add-text',
    idempotencyKey: 'operation-add-text',
    params: {
      text: 'Keyword',
      atSeconds: 1,
      durationSeconds: 2,
      trackId: 'track-v1',
    },
    postReadAssertions: [
      { path: 'timeline.textCount', operator: 'equals', expected: 1 },
      { path: 'history.undoCount', operator: 'equals', expected: 1 },
    ],
    ...overrides,
  })
}

function structured(result: Awaited<ReturnType<typeof executeCloudCommand>>) {
  return result.structuredContent as NormalizedToolResult
}

beforeEach(seedRunnerState)

afterEach(() => {
  vi.restoreAllMocks()
  clearCloudCommandOperationLedger()
})

describe('cloud command reconciliation runner', () => {
  it('maps v3 color targets and records authoritative color impact flags', async () => {
    const tool = getEditorTool('apply_effect')!
    vi.spyOn(tool, 'execute').mockResolvedValue({
      ok: true,
      message: 'Color target already satisfied.',
      changed: false,
    })
    const command = parseCloudBridgeCommand({
      sequence: 0,
      type: 'editor.apply_effect',
      commandId: 'command-color',
      idempotencyKey: 'operation-color',
      targetId: 'clip-color',
      params: {
        operation: 'remove',
        effectId: 'effect-color',
      },
    })

    const result = structured(await executeCloudCommand(projectId, command))

    expect(result).toMatchObject({
      ok: true,
      changed: false,
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      impactFlags: ['media', 'effect'],
      operationManifest: {
        contractId: 'freecut.editor.commands.v3',
        commandType: 'editor.apply_effect',
        tool: 'apply_effect',
        impactFlags: ['media', 'effect'],
      },
    })
    expect(tool.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        items: ['clip-color'],
        operation: 'remove',
        effectId: 'effect-color',
      }),
    )
  })

  it('verifies a real write and replays the same idempotency key without a second undo entry', async () => {
    const tool = getEditorTool('add_text')!
    const executeSpy = vi.spyOn(tool, 'execute')
    const first = structured(await executeCloudCommand(projectId, addTextCommand()))

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      finalStatus: 'succeeded',
      reconciliationStatus: 'VERIFIED_APPLIED',
      reconciliation: {
        status: 'applied',
        retryAttempted: false,
        newTaskCreated: false,
        newCommandCreated: false,
      },
      impactFlags: ['semantic', 'timing', 'motion'],
      operationManifest: {
        contractId: 'freecut.editor.commands.v3',
        commandId: 'command-add-text',
        idempotencyKey: 'operation-add-text',
        tool: 'add_text',
        requiresPostReadback: true,
      },
      postReadback: {
        status: 'verified',
        fingerprint: expect.any(String),
      },
    })
    expect(first.phaseReceipts?.map(({ phase }) => phase)).toEqual([
      'transport',
      'toolAck',
      'commit',
      'postReadback',
      'reconciliation',
    ])
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
    expect(useItemsStore.getState().items.filter((item) => item.type === 'text')).toHaveLength(1)

    const replayCommand = addTextCommand({ attempt: 2 })
    const replay = structured(await executeCloudCommand(projectId, replayCommand))
    expect(replay.ok).toBe(true)
    expect(replay.reconciliationStatus).toBe('VERIFIED_APPLIED')
    expect(replay.requestId).not.toBe(first.requestId)
    expect(replay.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'IDEMPOTENT_REPLAY' })]),
    )
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
    expect(useItemsStore.getState().items.filter((item) => item.type === 'text')).toHaveLength(1)
  })

  it('rejects one idempotency key reused with different normalized arguments', async () => {
    await executeCloudCommand(projectId, addTextCommand())
    const conflict = addTextCommand({
      params: {
        text: 'Different text',
        atSeconds: 1,
        durationSeconds: 2,
        trackId: 'track-v1',
      },
    })
    const result = structured(await executeCloudCommand(projectId, conflict))

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      finalStatus: 'failed',
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
    })
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
    expect(useItemsStore.getState().items.filter((item) => item.type === 'text')).toHaveLength(1)
  })

  it('turns changed=true without timeline/hash/history change into a verified failure', async () => {
    const tool = getEditorTool('add_text')!
    vi.spyOn(tool, 'execute').mockResolvedValue({
      ok: true,
      message: 'Claimed a write without mutating.',
      changed: true,
    })

    const result = structured(await executeCloudCommand(projectId, addTextCommand()))

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      finalStatus: 'uncertain',
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      reconciliation: { status: 'not-applied' },
      error: { code: 'WRITE_RESULT_MISMATCH', retryable: false },
    })
    expect(result.beforeFingerprint).toBe(result.afterFingerprint)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
  })

  it('accepts an assertion-proven no-op without inventing a persisted change', async () => {
    const tool = getEditorTool('add_text')!
    vi.spyOn(tool, 'execute').mockResolvedValue({
      ok: true,
      message: 'Target state was already satisfied.',
      changed: false,
    })
    const command = addTextCommand({
      commandId: 'command-noop',
      idempotencyKey: 'operation-noop',
      postReadAssertions: [
        { path: 'timeline.textCount', operator: 'equals', expected: 0 },
        { path: 'history.undoCount', operator: 'equals', expected: 0 },
      ],
    })
    const result = structured(await executeCloudCommand(projectId, command))

    expect(result).toMatchObject({
      ok: true,
      changed: false,
      finalStatus: 'succeeded',
      reconciliationStatus: 'VERIFIED_APPLIED',
      reconciliation: { status: 'applied' },
      error: null,
    })
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
  })

  it('marks a changed Renderer with failed assertions as partial and never reports success', async () => {
    const command = addTextCommand({
      commandId: 'command-partial',
      idempotencyKey: 'operation-partial',
      postReadAssertions: [{ path: 'timeline.textCount', operator: 'equals', expected: 2 }],
    })
    const result = structured(await executeCloudCommand(projectId, command))

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      finalStatus: 'uncertain',
      reconciliationStatus: 'PARTIAL_APPLIED',
      reconciliation: {
        status: 'partial',
        partialChange: expect.any(String),
      },
      error: { code: 'POST_READ_ASSERTION_FAILED' },
      postReadback: { status: 'failed' },
    })
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(1)
  })

  it('reconciles a persisted uncertain record by readback without invoking the write tool', async () => {
    const args = {
      text: 'Keyword',
      atSeconds: 1,
      durationSeconds: 2,
      trackId: 'track-v1',
    }
    const before = captureCloudCompositeSnapshot(projectId)
    localStorage.setItem(
      'freecut:renderer-operation-ledger:v1',
      JSON.stringify([
        {
          key: `${projectId}:operation-uncertain`,
          argsFingerprint: fingerprintCloudValue({
            type: 'timeline.add_text',
            args,
          }),
          operationId: 'command-uncertain',
          projectId,
          beforeFingerprint: before.hash,
          status: 'UNCERTAIN_WRITE',
          updatedAt: Date.now(),
        },
      ]),
    )
    const tool = getEditorTool('add_text')!
    const executeSpy = vi.spyOn(tool, 'execute')
    const command = addTextCommand({
      commandId: 'command-uncertain',
      idempotencyKey: 'operation-uncertain',
      params: args,
    })
    const result = structured(await executeCloudCommand(projectId, command))

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      reconciliation: {
        status: 'not-applied',
        retryAttempted: false,
        newTaskCreated: false,
        newCommandCreated: false,
      },
      error: { code: 'VERIFIED_NOT_APPLIED', retryable: true },
    })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(0)
  })
})
