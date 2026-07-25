import { z } from 'zod'
import {
  applyAutoKeyframeOperations,
  applyBentoLayout,
  buildDroppedCompositionTimelineItems,
  compositionHasOwnedAudio,
  computeBentoLayout,
  computeLayout,
  executeTimelineCommand,
  getDefaultActiveTrackId,
  getTrackKind,
  performInsertEdit,
  performOverwriteEdit,
  planTrackMediaDropPlacements,
  updateItemsTransformMap,
  useBentoPresetsStore,
  useCompositionsStore,
  useCompositionNavigationStore,
  useItemsStore,
  useKeyframesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
  wouldCreateCompositionCycle,
  type BentoLayoutItem,
  type LayoutConfig,
  type LayoutPresetType,
} from '@/features/editor/deps/timeline-contract'
import {
  getAutoKeyframeOperation,
  resolveAnimatedTransform,
  type AutoKeyframeOperation,
} from '@/features/editor/deps/keyframes-contract'
import {
  getSourceDimensions,
  resolveTransform,
} from '@/features/editor/deps/composition-runtime-contract'
import {
  getMediaType,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { createOperationId } from '@/shared/logging/logger'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import { useEditorStore } from '@/shared/state/editor'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { useSourcePlayerStore } from '@/shared/state/source-player'
import type { TransformProperties } from '@/types/transform'
import { definePlatformTool, objectSchema, resolveItemHandles } from './shared'

type AlignmentType =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom'
  | 'distribute-h'
  | 'distribute-v'

type CommandState = ReturnType<typeof useTimelineCommandStore.getState>

interface CommandProbe {
  activeContextKey: CommandState['activeContextKey']
  undoStack: CommandState['undoStack']
  lastEntry: CommandState['undoStack'][number] | undefined
}

function beginCommandProbe(): CommandProbe {
  const state = useTimelineCommandStore.getState()
  return {
    activeContextKey: state.activeContextKey,
    undoStack: state.undoStack,
    lastEntry: state.undoStack.at(-1),
  }
}

function finishCommandProbe(
  probe: CommandProbe,
  expectedTypes: readonly string[],
  operationId: string,
) {
  const state = useTimelineCommandStore.getState()
  const lastEntry = state.undoStack.at(-1)
  const changed =
    state.activeContextKey === probe.activeContextKey &&
    state.undoStack !== probe.undoStack &&
    lastEntry !== probe.lastEntry &&
    expectedTypes.includes(lastEntry?.command.type ?? '')

  return {
    changed,
    operationId: changed ? operationId : undefined,
    commandType: changed ? lastEntry?.command.type : undefined,
  }
}

function getCanvasSettings() {
  const timeline = useTimelineStore.getState()
  const project = useProjectStore.getState().currentProject
  return {
    width: project?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
    height: project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
    fps: timeline.fps,
  }
}

function resolveBentoConfig(args: {
  presetId?: string
  preset?: LayoutPresetType
  cols?: number
  rows?: number
  gap?: number
  padding?: number
}): LayoutConfig {
  const savedPreset = args.presetId
    ? useBentoPresetsStore.getState().customPresets.find((preset) => preset.id === args.presetId)
    : undefined
  if (args.presetId && !savedPreset) {
    throw new Error(`Bento preset not found: ${args.presetId}`)
  }

  return {
    preset: args.preset ?? savedPreset?.preset ?? 'auto',
    cols: args.cols ?? savedPreset?.cols,
    rows: args.rows ?? savedPreset?.rows,
    gap: args.gap ?? savedPreset?.gap ?? 0,
    padding: args.padding ?? savedPreset?.padding ?? 0,
  }
}

function resolveVisualItems(handles: string[], options?: { excludeAdjustment?: boolean }) {
  const requestedCount = new Set(handles).size
  const items = resolveItemHandles(handles, { allowSelection: false })
  if (items.length !== requestedCount) {
    throw new Error('One or more timeline items do not exist.')
  }
  return items.filter(
    (item) => item.type !== 'audio' && (!options?.excludeAdjustment || item.type !== 'adjustment'),
  )
}

const sourceEditSchema = z
  .object({
    operation: z.enum(['insert', 'overwrite']),
    mediaId: z.string().min(1).optional(),
    sourceInSeconds: z.number().min(0).optional(),
    sourceOutSeconds: z.number().min(0).optional(),
    atSeconds: z.number().min(0).optional(),
    patchVideo: z.boolean().optional(),
    patchAudio: z.boolean().optional(),
    videoTrackId: z.string().min(1).optional(),
    audioTrackId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.sourceInSeconds !== undefined &&
      value.sourceOutSeconds !== undefined &&
      value.sourceOutSeconds <= value.sourceInSeconds
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceOutSeconds'],
        message: 'sourceOutSeconds must be greater than sourceInSeconds.',
      })
    }
  })

const sourceEdit = definePlatformTool({
  name: 'source_edit',
  title: 'Apply source edit',
  description:
    'Insert or overwrite source media with explicit source range, timeline position, audio/video patches, and destination tracks.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['insert', 'overwrite'] },
      mediaId: { type: 'string' },
      sourceInSeconds: { type: 'number', minimum: 0 },
      sourceOutSeconds: { type: 'number', minimum: 0 },
      atSeconds: { type: 'number', minimum: 0 },
      patchVideo: { type: 'boolean' },
      patchAudio: { type: 'boolean' },
      videoTrackId: { type: 'string' },
      audioTrackId: { type: 'string' },
    },
    ['operation'],
  ),
  schema: sourceEditSchema,
  summarize: ({ operation, mediaId, atSeconds }) =>
    `${operation} source edit${mediaId ? ` ${mediaId}` : ''}${atSeconds === undefined ? '' : ` at ${atSeconds}s`}`,
  execute: async ({
    operation,
    mediaId,
    sourceInSeconds,
    sourceOutSeconds,
    atSeconds,
    patchVideo,
    patchAudio,
    videoTrackId,
    audioTrackId,
  }) => {
    const editorStore = useEditorStore.getState()
    const resolvedMediaId = mediaId ?? editorStore.sourcePreviewMediaId
    if (!resolvedMediaId) {
      throw new Error('mediaId is required when no source is open.')
    }

    const mediaStore = useMediaLibraryStore.getState()
    const media = mediaStore.mediaById[resolvedMediaId]
    if (!media) {
      throw new Error(`Media not found: ${resolvedMediaId}`)
    }
    const mediaType = getMediaType(media.mimeType)
    if (mediaType === 'unknown') {
      throw new Error(`Unsupported source media type: ${media.mimeType}`)
    }

    const tracks = useItemsStore.getState().tracks
    if (videoTrackId) {
      const track = tracks.find((candidate) => candidate.id === videoTrackId)
      if (!track) throw new Error(`Video track not found: ${videoTrackId}`)
      if (getTrackKind(track) !== 'video') {
        throw new Error(`Track is not a video track: ${videoTrackId}`)
      }
    }
    if (audioTrackId) {
      const track = tracks.find((candidate) => candidate.id === audioTrackId)
      if (!track) throw new Error(`Audio track not found: ${audioTrackId}`)
      if (getTrackKind(track) !== 'audio') {
        throw new Error(`Track is not an audio track: ${audioTrackId}`)
      }
    }

    const sourceFps = media.fps || 30
    const projectFps = useTimelineSettingsStore.getState().fps
    const sourceDurationFrames =
      mediaType === 'image'
        ? projectFps * 3
        : Math.max(1, Math.round(media.duration * sourceFps))
    const sourceState = useSourcePlayerStore.getState()
    const configureRange =
      mediaId !== undefined ||
      sourceInSeconds !== undefined ||
      sourceOutSeconds !== undefined
    let sourceInFrame = sourceState.currentMediaId === resolvedMediaId ? sourceState.inPoint : null
    let sourceOutFrame = sourceState.currentMediaId === resolvedMediaId ? sourceState.outPoint : null
    let configuredRange: { inFrame: number; outFrame: number } | null = null

    if (configureRange) {
      const preserveCurrentRange = mediaId === undefined
      sourceInFrame =
        sourceInSeconds === undefined
          ? preserveCurrentRange
            ? (sourceInFrame ?? 0)
            : 0
          : Math.round(sourceInSeconds * sourceFps)
      sourceOutFrame =
        sourceOutSeconds === undefined
          ? preserveCurrentRange
            ? (sourceOutFrame ?? sourceDurationFrames)
            : sourceDurationFrames
          : Math.round(sourceOutSeconds * sourceFps)

      if (sourceInFrame < 0 || sourceInFrame >= sourceDurationFrames) {
        throw new Error('sourceInSeconds is outside the source duration.')
      }
      if (sourceOutFrame <= sourceInFrame || sourceOutFrame > sourceDurationFrames) {
        throw new Error('sourceOutSeconds is outside the source duration or not after sourceInSeconds.')
      }
      configuredRange = {
        inFrame: sourceInFrame,
        outFrame: sourceOutFrame,
      }
    }

    const isVisualSource =
      mediaType === 'video' || mediaType === 'image' || mediaType === 'lottie'
    const hasAudioSource = mediaType === 'audio' || (mediaType === 'video' && !!media.audioCodec)
    const useSourceDefaults = mediaId !== undefined
    const nextPatchVideo =
      patchVideo ?? (useSourceDefaults ? isVisualSource : editorStore.sourcePatchVideoEnabled)
    const nextPatchAudio =
      patchAudio ?? (useSourceDefaults ? hasAudioSource : editorStore.sourcePatchAudioEnabled)

    mediaStore.setSelection({ mediaIds: [resolvedMediaId], compositionIds: [] })
    sourceState.playerMethods?.pause()
    sourceState.setCurrentMediaId(resolvedMediaId)
    sourceState.setPendingPlay(false)
    if (configuredRange) {
      sourceState.clearInOutPoints()
      sourceState.setInPoint(configuredRange.inFrame)
      sourceState.setOutPoint(configuredRange.outFrame)
      sourceState.setCurrentSourceFrame(configuredRange.inFrame)
      sourceState.setPendingSeekFrame(configuredRange.inFrame)
    }
    editorStore.setSourcePreviewMediaId(resolvedMediaId)
    editorStore.setSourcePatchVideoEnabled(nextPatchVideo)
    editorStore.setSourcePatchAudioEnabled(nextPatchAudio)
    if (videoTrackId !== undefined) {
      editorStore.setSourcePatchVideoTrackId(videoTrackId)
    }
    if (audioTrackId !== undefined) {
      editorStore.setSourcePatchAudioTrackId(audioTrackId)
    }
    if (atSeconds !== undefined) {
      usePlaybackStore.getState().setCurrentFrame(Math.round(atSeconds * projectFps))
    }

    const insertFrame = usePlaybackStore.getState().currentFrame
    const beforeItems = useTimelineStore.getState().items
    const beforeIds = new Set(beforeItems.map((item) => item.id))
    const operationId = createOperationId()
    const probe = beginCommandProbe()

    if (operation === 'insert') {
      await performInsertEdit()
    } else {
      await performOverwriteEdit()
    }

    const outcome = finishCommandProbe(
      probe,
      [operation === 'insert' ? 'INSERT_EDIT' : 'OVERWRITE_EDIT'],
      operationId,
    )
    const afterItems = useTimelineStore.getState().items
    const afterIds = new Set(afterItems.map((item) => item.id))
    const addedItemIds = afterItems.filter((item) => !beforeIds.has(item.id)).map((item) => item.id)
    const removedItemIds = beforeItems
      .filter((item) => !afterIds.has(item.id))
      .map((item) => item.id)

    return {
      ok: true,
      message: outcome.changed
        ? `Applied ${operation} source edit.`
        : `No ${operation} source edit was applied.`,
      data: {
        operation,
        mediaId: resolvedMediaId,
        sourceInSeconds:
          (useSourcePlayerStore.getState().inPoint ?? 0) / sourceFps,
        sourceOutSeconds:
          (useSourcePlayerStore.getState().outPoint ?? sourceDurationFrames) / sourceFps,
        atSeconds: insertFrame / projectFps,
        patchVideo: useEditorStore.getState().sourcePatchVideoEnabled,
        patchAudio: useEditorStore.getState().sourcePatchAudioEnabled,
        videoTrackId: useEditorStore.getState().sourcePatchVideoTrackId,
        audioTrackId: useEditorStore.getState().sourcePatchAudioTrackId,
        commandType: outcome.commandType,
        addedItemIds,
        removedItemIds,
      },
      operationId: outcome.operationId,
      changed: outcome.changed,
    }
  },
})

const applyBentoLayoutTool = definePlatformTool({
  name: 'apply_bento_layout',
  title: 'Apply Bento layout',
  description:
    'Arrange two or more visual timeline items with a built-in or saved Bento preset in one undoable layout operation.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      presetId: { type: 'string' },
      preset: {
        type: 'string',
        enum: ['auto', 'row', 'column', 'pip', 'focus-sidebar', 'grid'],
      },
      cols: { type: 'number', minimum: 1 },
      rows: { type: 'number', minimum: 1 },
      gap: { type: 'number', minimum: 0, maximum: 200 },
      padding: { type: 'number', minimum: 0, maximum: 200 },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(2),
    presetId: z.string().min(1).optional(),
    preset: z.enum(['auto', 'row', 'column', 'pip', 'focus-sidebar', 'grid']).optional(),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
    gap: z.number().min(0).max(200).optional(),
    padding: z.number().min(0).max(200).optional(),
  }),
  summarize: ({ items }) =>
    `Apply Bento layout to ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, ...configArgs }) => {
    const items = resolveVisualItems(handles)
    if (items.length < 2) {
      throw new Error('Bento layout requires at least two visual timeline items.')
    }

    const canvas = getCanvasSettings()
    const config = resolveBentoConfig(configArgs)
    const layoutItems: BentoLayoutItem[] = items.map((item) => {
      const source = getSourceDimensions(item)
      return {
        id: item.id,
        sourceWidth: source?.width ?? canvas.width,
        sourceHeight: source?.height ?? canvas.height,
      }
    })
    const computed =
      config.preset === 'auto'
        ? computeBentoLayout(layoutItems, canvas.width, canvas.height, {
            gap: config.gap,
            padding: config.padding,
          })
        : computeLayout(layoutItems, canvas.width, canvas.height, config)

    const operationId = createOperationId()
    const probe = beginCommandProbe()
    applyBentoLayout(
      items.map((item) => item.id),
      canvas.width,
      canvas.height,
      config,
    )
    const outcome = finishCommandProbe(probe, ['APPLY_BENTO_LAYOUT'], operationId)
    const updatedById = new Map(useTimelineStore.getState().items.map((item) => [item.id, item]))

    return {
      ok: true,
      message: outcome.changed
        ? `Applied ${config.preset} Bento layout to ${items.length} items.`
        : 'The Bento layout did not change the selected items.',
      data: {
        itemIds: items.map((item) => item.id),
        presetId: configArgs.presetId,
        config,
        computedItemCount: computed.size,
        transforms: Object.fromEntries(
          items.map((item) => [item.id, updatedById.get(item.id)?.transform]),
        ),
      },
      operationId: outcome.operationId,
      changed: outcome.changed,
    }
  },
})

const manageBentoPresetSchema = z
  .object({
    operation: z.enum(['list', 'save', 'delete']),
    presetId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    preset: z.enum(['auto', 'row', 'column', 'pip', 'focus-sidebar', 'grid']).optional(),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
    gap: z.number().min(0).max(200).optional(),
    padding: z.number().min(0).max(200).optional(),
  })
  .superRefine((value, context) => {
    if (value.operation === 'save' && !value.name) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'name is required when operation is "save".',
      })
    }
    if (value.operation === 'delete' && !value.presetId) {
      context.addIssue({
        code: 'custom',
        path: ['presetId'],
        message: 'presetId is required when operation is "delete".',
      })
    }
  })

const manageBentoPreset = definePlatformTool({
  name: 'manage_bento_preset',
  title: 'Manage Bento presets',
  description:
    'List, save, or delete custom Bento layout presets from the existing persisted preset store.',
  requiresProject: false,
  destructive: true,
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['list', 'save', 'delete'] },
      presetId: { type: 'string' },
      name: { type: 'string' },
      preset: {
        type: 'string',
        enum: ['auto', 'row', 'column', 'pip', 'focus-sidebar', 'grid'],
      },
      cols: { type: 'number', minimum: 1 },
      rows: { type: 'number', minimum: 1 },
      gap: { type: 'number', minimum: 0, maximum: 200 },
      padding: { type: 'number', minimum: 0, maximum: 200 },
    },
    ['operation'],
  ),
  schema: manageBentoPresetSchema,
  summarize: ({ operation }) => `${operation} Bento preset`,
  execute: ({ operation, presetId, name, preset = 'auto', cols, rows, gap = 0, padding = 0 }) => {
    const store = useBentoPresetsStore.getState()

    if (operation === 'list') {
      return {
        ok: true,
        message: `Listed ${store.customPresets.length} custom Bento preset${store.customPresets.length === 1 ? '' : 's'}.`,
        data: { presets: store.customPresets },
        changed: false,
      }
    }

    if (operation === 'delete') {
      const existing = store.customPresets.find((candidate) => candidate.id === presetId)
      if (!existing) {
        return {
          ok: true,
          message: `Bento preset not found: ${presetId}`,
          data: { presetId },
          changed: false,
        }
      }
      store.removePreset(existing.id)
      return {
        ok: true,
        message: `Deleted Bento preset "${existing.name}".`,
        data: { preset: existing },
        operationId: createOperationId(),
        changed: true,
      }
    }

    const beforeIds = new Set(store.customPresets.map((candidate) => candidate.id))
    store.addPreset({
      name: name!,
      preset,
      cols: cols ?? (preset === 'grid' ? 2 : 1),
      rows: rows ?? (preset === 'grid' ? 2 : 1),
      gap,
      padding,
    })
    const created = useBentoPresetsStore
      .getState()
      .customPresets.find((candidate) => !beforeIds.has(candidate.id))

    return {
      ok: true,
      message: `Saved Bento preset "${name}".`,
      data: { preset: created },
      operationId: created ? createOperationId() : undefined,
      changed: !!created,
    }
  },
})

const alignItems = definePlatformTool({
  name: 'align_items',
  title: 'Align timeline items',
  description:
    'Align visual items to canvas edges or centers, or distribute three or more items with equal edge-to-edge gaps.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      alignment: {
        type: 'string',
        enum: [
          'left',
          'center-h',
          'right',
          'top',
          'center-v',
          'bottom',
          'distribute-h',
          'distribute-v',
        ],
      },
    },
    ['items', 'alignment'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    alignment: z.enum([
      'left',
      'center-h',
      'right',
      'top',
      'center-v',
      'bottom',
      'distribute-h',
      'distribute-v',
    ]),
  }),
  summarize: ({ items, alignment }) =>
    `${alignment} align ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, alignment }) => {
    const items = resolveVisualItems(handles, { excludeAdjustment: true })
    if (items.length === 0) {
      throw new Error('No alignable visual timeline items were found.')
    }
    if ((alignment === 'distribute-h' || alignment === 'distribute-v') && items.length < 3) {
      throw new Error('Distribution requires at least three visual timeline items.')
    }

    const tolerance = 0.5
    const canvas = getCanvasSettings()
    const currentFrame = usePlaybackStore.getState().currentFrame
    const keyframesByItemId = useKeyframesStore.getState().keyframesByItemId
    const entries = items.map((item) => {
      const base = resolveTransform(item, canvas, getSourceDimensions(item))
      const resolved = resolveAnimatedTransform(
        base,
        keyframesByItemId[item.id],
        currentFrame - item.from,
      )
      return {
        id: item.id,
        x: resolved.x,
        y: resolved.y,
        width: resolved.width,
        height: resolved.height,
      }
    })
    const updates = new Map<string, Partial<TransformProperties>>()

    if (alignment === 'distribute-h' || alignment === 'distribute-v') {
      const axis = alignment === 'distribute-h' ? 'x' : 'y'
      const size = axis === 'x' ? 'width' : 'height'
      const sorted = [...entries].sort((left, right) => left[axis] - right[axis])
      const first = sorted[0]!
      const last = sorted[sorted.length - 1]!
      const spanStart = first[axis] - first[size] / 2
      const spanEnd = last[axis] + last[size] / 2
      const totalItemSize = sorted.reduce((sum, entry) => sum + entry[size], 0)
      const gap = (spanEnd - spanStart - totalItemSize) / (sorted.length - 1)

      let cursor = spanStart + first[size]
      for (let index = 1; index < sorted.length - 1; index += 1) {
        const entry = sorted[index]!
        const target = cursor + gap + entry[size] / 2
        cursor = target + entry[size] / 2
        if (Math.abs(target - entry[axis]) <= tolerance) continue
        updates.set(entry.id, axis === 'x' ? { x: target } : { y: target })
      }
    } else {
      for (const entry of entries) {
        let nextX: number | undefined
        let nextY: number | undefined

        switch (alignment as AlignmentType) {
          case 'left':
            nextX = -canvas.width / 2 + entry.width / 2
            break
          case 'center-h':
            nextX = 0
            break
          case 'right':
            nextX = canvas.width / 2 - entry.width / 2
            break
          case 'top':
            nextY = -canvas.height / 2 + entry.height / 2
            break
          case 'center-v':
            nextY = 0
            break
          case 'bottom':
            nextY = canvas.height / 2 - entry.height / 2
            break
          case 'distribute-h':
          case 'distribute-v':
            break
        }

        const properties: Partial<TransformProperties> = {}
        if (nextX !== undefined && Math.abs(nextX - entry.x) > tolerance) {
          properties.x = nextX
        }
        if (nextY !== undefined && Math.abs(nextY - entry.y) > tolerance) {
          properties.y = nextY
        }
        if (Object.keys(properties).length > 0) {
          updates.set(entry.id, properties)
        }
      }
    }

    if (updates.size === 0) {
      return {
        ok: true,
        message: 'The selected items are already aligned.',
        data: { itemIds: items.map((item) => item.id), alignment },
        changed: false,
      }
    }

    const autoOperations: AutoKeyframeOperation[] = []
    const baseUpdates = new Map<string, Partial<TransformProperties>>()
    const itemById = new Map(items.map((item) => [item.id, item]))

    for (const [itemId, properties] of updates) {
      const item = itemById.get(itemId)!
      const fallback: Partial<TransformProperties> = {}
      for (const axis of ['x', 'y'] as const) {
        const value = properties[axis]
        if (value === undefined) continue
        const operation = getAutoKeyframeOperation(
          item,
          keyframesByItemId[itemId],
          axis,
          value,
          currentFrame,
        )
        if (operation) {
          autoOperations.push(operation)
        } else {
          fallback[axis] = value
        }
      }
      if (Object.keys(fallback).length > 0) {
        baseUpdates.set(itemId, fallback)
      }
    }

    const operationId = createOperationId()
    const probe = beginCommandProbe()
    if (autoOperations.length > 0) {
      applyAutoKeyframeOperations(autoOperations)
    }
    if (baseUpdates.size > 0) {
      updateItemsTransformMap(baseUpdates, { operation: 'move' })
    }
    const outcome = finishCommandProbe(
      probe,
      ['APPLY_AUTO_KEYFRAME_OPERATIONS', 'UPDATE_TRANSFORMS'],
      operationId,
    )

    return {
      ok: true,
      message: outcome.changed
        ? `Aligned ${updates.size} item${updates.size === 1 ? '' : 's'} with ${alignment}.`
        : 'The alignment operation did not change the selected items.',
      data: {
        itemIds: [...updates.keys()],
        alignment,
        autoKeyframeOperationCount: autoOperations.length,
        baseTransformUpdateCount: baseUpdates.size,
        commandType: outcome.commandType,
      },
      operationId: outcome.operationId,
      changed: outcome.changed,
    }
  },
})

const placeComposition = definePlatformTool({
  name: 'place_composition',
  title: 'Place composition on timeline',
  description:
    'Place an existing composition at the playhead or an exact time, with linked owned audio and composition-cycle protection.',
  inputSchema: objectSchema(
    {
      compositionId: { type: 'string' },
      atSeconds: { type: 'number', minimum: 0 },
      trackId: { type: 'string' },
    },
    ['compositionId'],
  ),
  schema: z.object({
    compositionId: z.string().min(1),
    atSeconds: z.number().min(0).optional(),
    trackId: z.string().min(1).optional(),
  }),
  summarize: ({ compositionId }) => `Place composition ${compositionId}`,
  execute: ({ compositionId, atSeconds, trackId }) => {
    const compositionState = useCompositionsStore.getState()
    const composition = compositionState.compositionById[compositionId]
    if (!composition) {
      throw new Error(`Composition not found: ${compositionId}`)
    }

    const parentCompositionId = useCompositionNavigationStore.getState().activeCompositionId
    if (
      wouldCreateCompositionCycle({
        parentCompositionId,
        insertedCompositionId: compositionId,
        compositionById: compositionState.compositionById,
      })
    ) {
      throw new Error('Placing that composition would create a composition cycle.')
    }

    const timeline = useTimelineStore.getState()
    const targetTrackId =
      trackId ??
      useSelectionStore.getState().activeTrackId ??
      getDefaultActiveTrackId(timeline.tracks)
    if (!targetTrackId) {
      throw new Error('No target timeline track is available.')
    }
    const targetTrack = timeline.tracks.find((track) => track.id === targetTrackId)
    if (!targetTrack || targetTrack.isGroup) {
      throw new Error(`Timeline track not found: ${targetTrackId}`)
    }
    if (targetTrack.locked) {
      throw new Error(`Timeline track is locked: ${targetTrackId}`)
    }

    const dropFrame =
      atSeconds === undefined
        ? usePlaybackStore.getState().currentFrame
        : Math.round(atSeconds * timeline.fps)
    const plan = planTrackMediaDropPlacements({
      entries: [
        {
          payload: { compositionId },
          label: composition.name,
          mediaType: 'video',
          durationInFrames: composition.durationInFrames,
          hasLinkedAudio: compositionHasOwnedAudio({
            composition,
            compositionById: compositionState.compositionById,
          }),
        },
      ],
      dropFrame,
      tracks: timeline.tracks,
      existingItems: timeline.items,
      dropTargetTrackId: targetTrackId,
    })
    const planned = plan.plannedItems[0]
    if (!planned) {
      throw new Error('No available timeline placement was found for the composition.')
    }

    const droppedItems = buildDroppedCompositionTimelineItems({
      compositionId,
      composition,
      label: composition.name,
      placements: planned.placements,
    })
    if (droppedItems.length === 0) {
      throw new Error('The composition did not produce timeline wrapper items.')
    }

    const operationId = createOperationId()
    const probe = beginCommandProbe()
    executeTimelineCommand(
      'AGENT_PLACE_COMPOSITION',
      () => {
        const store = useItemsStore.getState()
        if (plan.tracks !== timeline.tracks) {
          store.setTracks(plan.tracks)
        }
        store._addItems(droppedItems)
        useTimelineSettingsStore.getState().markDirty()
      },
      {
        operationId,
        compositionId,
        itemIds: droppedItems.map((item) => item.id),
      },
    )
    const outcome = finishCommandProbe(probe, ['AGENT_PLACE_COMPOSITION'], operationId)

    return {
      ok: true,
      message: outcome.changed
        ? `Placed composition "${composition.name}".`
        : `Composition "${composition.name}" was not placed.`,
      data: {
        compositionId,
        parentCompositionId,
        itemIds: droppedItems.map((item) => item.id),
        placements: planned.placements,
      },
      operationId: outcome.operationId,
      changed: outcome.changed,
    }
  },
})

export const SOURCE_LAYOUT_PLATFORM_TOOLS = [
  sourceEdit,
  applyBentoLayoutTool,
  manageBentoPreset,
  alignItems,
  placeComposition,
] as const
