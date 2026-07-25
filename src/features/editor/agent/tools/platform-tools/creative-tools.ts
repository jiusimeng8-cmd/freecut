import { z } from 'zod'
import {
  canAddKeyframeAtFrame,
  createDefaultAdjustmentItem,
  createDefaultShapeItem,
  createOverlayLayerTrack,
  createTextTemplateItem,
  executeTimelineCommand,
  findCompatibleTrackForItemType,
  findNearestAvailableSpace,
  getDefaultGeneratedLayerDurationInFrames,
  useItemsStore,
  useKeyframesStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import {
  getGpuEffect,
  getGpuEffectDefaultParams,
} from '@/features/editor/deps/effects-contract'
import { colorStringToKeyframeValue } from '@/features/editor/deps/keyframes-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import type { AudioEqSettings } from '@/types/audio'
import type { ItemEffect, VisualEffect } from '@/types/effects'
import type {
  AnimatableProperty,
  EasingConfig,
  EasingType,
  Keyframe,
} from '@/types/keyframe'
import type { MaskVertex } from '@/types/masks'
import type { CropSettings, TransformProperties } from '@/types/transform'
import type {
  AdjustmentItem,
  ShapeItem,
  ShapeType,
  SubtitleSegmentItem,
  TextItem,
  TimelineItem,
} from '@/types/timeline'
import type {
  TransitionPresentation,
  TransitionTiming,
} from '@/types/transition'
import {
  definePlatformTool,
  objectSchema,
  resolveItemHandles,
} from './shared'

const transformSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  anchorX: z.number().optional(),
  anchorY: z.number().optional(),
  rotation: z.number().optional(),
  flipHorizontal: z.boolean().optional(),
  flipVertical: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  cornerRadius: z.number().min(0).optional(),
  aspectRatioLocked: z.boolean().optional(),
})

const cropSchema = z.object({
  left: z.number().optional(),
  right: z.number().optional(),
  top: z.number().optional(),
  bottom: z.number().optional(),
  softness: z.number().optional(),
})

const pointSchema = z.tuple([z.number(), z.number()])
const maskVertexSchema = z.object({
  position: pointSchema,
  inHandle: pointSchema,
  outHandle: pointSchema,
})

const textStyleSchema = z.object({
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  underline: z.boolean().optional(),
  color: z.string().min(1).optional(),
  letterSpacing: z.number().optional(),
  backgroundColor: z.string().optional(),
  backgroundRadius: z.number().min(0).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  lineHeight: z.number().positive().optional(),
  textPadding: z.number().min(0).optional(),
  textShadow: z
    .object({
      offsetX: z.number(),
      offsetY: z.number(),
      blur: z.number().min(0),
      color: z.string(),
    })
    .optional(),
  stroke: z
    .object({
      width: z.number().min(0),
      color: z.string(),
    })
    .optional(),
})

function valuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
}

function hasTimelineItemChanges(item: TimelineItem, updates: Partial<TimelineItem>): boolean {
  return Object.entries(updates).some(
    ([key, value]) => !valuesEqual((item as unknown as Record<string, unknown>)[key], value),
  )
}

function moveEffectInStack(
  effects: ItemEffect[],
  effectId: string,
  target: {
    index?: number
    beforeEffectId?: string
    afterEffectId?: string
  },
): ItemEffect[] {
  const sourceIndex = effects.findIndex((entry) => entry.id === effectId)
  if (sourceIndex < 0) return effects

  const reordered = [...effects]
  const [moved] = reordered.splice(sourceIndex, 1)
  let targetIndex: number

  if (target.index !== undefined) {
    targetIndex = Math.min(target.index, reordered.length)
  } else if (target.beforeEffectId !== undefined) {
    targetIndex = reordered.findIndex((entry) => entry.id === target.beforeEffectId)
    if (targetIndex < 0) return effects
  } else {
    targetIndex = reordered.findIndex((entry) => entry.id === target.afterEffectId)
    if (targetIndex < 0) return effects
    targetIndex += 1
  }

  reordered.splice(targetIndex, 0, moved!)
  return reordered.every((entry, index) => entry === effects[index]) ? effects : reordered
}

interface GeneratedPlacement {
  trackId: string
  tracks: ReturnType<typeof useTimelineStore.getState>['tracks']
  from: number
  durationInFrames: number
  createdTrack: boolean
}

function resolveGeneratedPlacement(params: {
  itemType: TimelineItem['type']
  trackId?: string
  atSeconds?: number
  durationSeconds?: number
}): GeneratedPlacement {
  const timeline = useTimelineStore.getState()
  const selection = useSelectionStore.getState()
  const durationInFrames =
    params.durationSeconds === undefined
      ? getDefaultGeneratedLayerDurationInFrames(timeline.fps)
      : Math.max(1, Math.round(params.durationSeconds * timeline.fps))
  const proposed =
    params.atSeconds === undefined
      ? usePlaybackStore.getState().currentFrame
      : Math.round(params.atSeconds * timeline.fps)
  const requestedTrack = params.trackId
    ? timeline.tracks.find((track) => track.id === params.trackId)
    : null
  const compatible =
    requestedTrack ??
    findCompatibleTrackForItemType({
      tracks: timeline.tracks,
      items: timeline.items,
      itemType: params.itemType,
      preferredTrackId: selection.activeTrackId,
    })

  if (compatible) {
    return {
      trackId: compatible.id,
      tracks: timeline.tracks,
      from:
        findNearestAvailableSpace(
          proposed,
          durationInFrames,
          compatible.id,
          timeline.items,
        ) ?? proposed,
      durationInFrames,
      createdTrack: false,
    }
  }

  const overlay = createOverlayLayerTrack({
    tracks: timeline.tracks,
    activeTrackId: selection.activeTrackId,
  })
  if (!overlay) throw new Error(`No compatible track is available for ${params.itemType}.`)
  return {
    trackId: overlay.trackId,
    tracks: overlay.tracks,
    from: proposed,
    durationInFrames,
    createdTrack: true,
  }
}

function commitGeneratedItem(item: TimelineItem, placement: GeneratedPlacement): void {
  const timeline = useTimelineStore.getState()
  if (placement.createdTrack) timeline.addItemOnNewTrack(item, placement.tracks)
  else timeline.addItem(item)
  useSelectionStore.getState().selectItems([item.id])
}

const addText = definePlatformTool({
  name: 'add_text',
  title: 'Add text layer',
  description:
    'Add a fully editable text layer with timing, typography, transform, and optional caption role.',
  inputSchema: objectSchema(
    {
      text: { type: 'string' },
      atSeconds: { type: 'number', minimum: 0 },
      durationSeconds: { type: 'number', minimum: 0.01 },
      trackId: { type: 'string' },
      role: { type: 'string', enum: ['title', 'caption'] },
      style: { type: 'object' },
      transform: { type: 'object' },
    },
    ['text'],
  ),
  schema: z.object({
    text: z.string().min(1).max(5000),
    atSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().positive().optional(),
    trackId: z.string().min(1).optional(),
    role: z.enum(['title', 'caption']).optional(),
    style: textStyleSchema.optional(),
    transform: transformSchema.optional(),
  }),
  summarize: ({ text }) => `Add text "${text.slice(0, 40)}"`,
  execute: ({ text, atSeconds, durationSeconds, trackId, role = 'title', style, transform }) => {
    const placement = resolveGeneratedPlacement({
      itemType: 'text',
      trackId,
      atSeconds,
      durationSeconds,
    })
    const project = useProjectStore.getState().currentProject
    const base = createTextTemplateItem({
      placement: {
        trackId: placement.trackId,
        from: placement.from,
        durationInFrames: placement.durationInFrames,
        canvasWidth: project?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
        canvasHeight: project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
        fps: useTimelineStore.getState().fps,
      },
      text,
      label: role === 'caption' ? 'Caption' : 'Text',
    })
    const item: TextItem = {
      ...base,
      ...style,
      ...(transform ? { transform: { ...base.transform, ...transform } } : {}),
      ...(role === 'caption' ? { textRole: 'caption' as const } : {}),
    }
    commitGeneratedItem(item, placement)
    return {
      ok: true,
      message: `Added text layer "${text.slice(0, 40)}".`,
      data: { itemId: item.id, trackId: item.trackId, from: item.from },
      changed: true,
    }
  },
})

const addShape = definePlatformTool({
  name: 'add_shape',
  title: 'Add shape layer',
  description:
    'Add an editable shape layer with fill, stroke, timing, mask settings, and transform.',
  inputSchema: objectSchema(
    {
      shapeType: {
        type: 'string',
        enum: ['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'],
      },
      atSeconds: { type: 'number', minimum: 0 },
      durationSeconds: { type: 'number', minimum: 0.01 },
      trackId: { type: 'string' },
      fillColor: { type: 'string' },
      strokeColor: { type: 'string' },
      strokeWidth: { type: 'number', minimum: 0 },
      isMask: { type: 'boolean' },
      maskType: { type: 'string', enum: ['clip', 'alpha'] },
      maskFeather: { type: 'number', minimum: 0 },
      maskInvert: { type: 'boolean' },
      pathVertices: { type: 'array', items: { type: 'object' } },
      transform: { type: 'object' },
    },
    ['shapeType'],
  ),
  schema: z.object({
    shapeType: z.enum([
      'rectangle',
      'circle',
      'triangle',
      'ellipse',
      'star',
      'polygon',
      'heart',
      'path',
    ]),
    atSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().positive().optional(),
    trackId: z.string().min(1).optional(),
    fillColor: z.string().optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().min(0).optional(),
    isMask: z.boolean().optional(),
    maskType: z.enum(['clip', 'alpha']).optional(),
    maskFeather: z.number().min(0).optional(),
    maskInvert: z.boolean().optional(),
    pathVertices: z.array(maskVertexSchema).min(2).optional(),
    transform: transformSchema.optional(),
  }),
  summarize: ({ shapeType }) => `Add ${shapeType} shape`,
  execute: ({
    shapeType,
    atSeconds,
    durationSeconds,
    trackId,
    transform,
    pathVertices,
    ...style
  }) => {
    const placement = resolveGeneratedPlacement({
      itemType: 'shape',
      trackId,
      atSeconds,
      durationSeconds,
    })
    const project = useProjectStore.getState().currentProject
    const base = createDefaultShapeItem({
      trackId: placement.trackId,
      from: placement.from,
      durationInFrames: placement.durationInFrames,
      canvasWidth: project?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
      canvasHeight: project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
      shapeType: shapeType as ShapeType,
    })
    const item: ShapeItem = {
      ...base,
      ...style,
      ...(pathVertices ? { pathVertices: pathVertices as MaskVertex[] } : {}),
      ...(transform ? { transform: { ...base.transform, ...transform } } : {}),
    }
    commitGeneratedItem(item, placement)
    return {
      ok: true,
      message: `Added ${shapeType} shape.`,
      data: { itemId: item.id, trackId: item.trackId, from: item.from },
      changed: true,
    }
  },
})

const addAdjustmentLayer = definePlatformTool({
  name: 'add_adjustment_layer',
  title: 'Add adjustment layer',
  description:
    'Add an adjustment layer with an optional initial stack of registered GPU effects.',
  inputSchema: objectSchema({
    atSeconds: { type: 'number', minimum: 0 },
    durationSeconds: { type: 'number', minimum: 0.01 },
    trackId: { type: 'string' },
    label: { type: 'string' },
    effectOpacity: { type: 'number', minimum: 0, maximum: 1 },
    effects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          gpuEffectType: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['gpuEffectType'],
      },
    },
  }),
  schema: z.object({
    atSeconds: z.number().min(0).optional(),
    durationSeconds: z.number().positive().optional(),
    trackId: z.string().min(1).optional(),
    label: z.string().min(1).max(120).optional(),
    effectOpacity: z.number().min(0).max(1).optional(),
    effects: z
      .array(
        z.object({
          gpuEffectType: z.string().min(1),
          params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
        }),
      )
      .optional(),
  }),
  summarize: () => 'Add adjustment layer',
  execute: ({ atSeconds, durationSeconds, trackId, label, effectOpacity, effects = [] }) => {
    const placement = resolveGeneratedPlacement({
      itemType: 'adjustment',
      trackId,
      atSeconds,
      durationSeconds,
    })
    const visualEffects: VisualEffect[] = effects.map(({ gpuEffectType, params }) => {
      if (!getGpuEffect(gpuEffectType)) throw new Error(`Unknown GPU effect: ${gpuEffectType}`)
      return {
        type: 'gpu-effect',
        gpuEffectType,
        params: { ...getGpuEffectDefaultParams(gpuEffectType), ...params },
      }
    })
    const item: AdjustmentItem = {
      ...createDefaultAdjustmentItem({
        trackId: placement.trackId,
        from: placement.from,
        durationInFrames: placement.durationInFrames,
        label,
        effects: visualEffects,
      }),
      ...(effectOpacity !== undefined ? { effectOpacity } : {}),
    }
    commitGeneratedItem(item, placement)
    return {
      ok: true,
      message: `Added adjustment layer with ${visualEffects.length} effect${visualEffects.length === 1 ? '' : 's'}.`,
      data: { itemId: item.id, effectCount: visualEffects.length },
      changed: true,
    }
  },
})

const setTransform = definePlatformTool({
  name: 'set_transform',
  title: 'Set item transform and crop',
  description:
    'Batch-update position, size, anchor, rotation, flip, opacity, corner radius, and source crop for visual timeline items.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      transform: { type: 'object' },
      crop: { type: 'object' },
      reset: { type: 'boolean' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    transform: transformSchema.optional(),
    crop: cropSchema.optional(),
    reset: z.boolean().optional(),
  }),
  summarize: ({ items }) => `Transform ${items.length} visual item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, transform, crop, reset = false }) => {
    const items = resolveItemHandles(handles, { allowSelection: false }).filter(
      (item) => item.type !== 'audio',
    )
    if (items.length === 0) throw new Error('No visual timeline items were found.')
    executeTimelineCommand(
      'AGENT_SET_TRANSFORM',
      () => {
        const store = useItemsStore.getState()
        for (const item of items) {
          if (reset) {
            store._resetItemTransform(item.id)
            store._updateItem(item.id, { crop: undefined })
            continue
          }
          if (transform) store._updateItemTransform(item.id, transform as TransformProperties)
          if (crop) store._updateItem(item.id, { crop: crop as CropSettings })
        }
        useTimelineSettingsStore.getState().markDirty()
      },
      { itemIds: items.map((item) => item.id), reset },
    )
    return {
      ok: true,
      message: `Updated transform/crop for ${items.length} visual item${items.length === 1 ? '' : 's'}.`,
      data: { itemIds: items.map((item) => item.id), transform, crop, reset },
      changed: true,
    }
  },
})

const updateSubtitle = definePlatformTool({
  name: 'update_subtitle',
  title: 'Update subtitle',
  description:
    'Update one editable subtitle/caption item text, absolute timeline timing, and typography.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      cueId: { type: 'string' },
      text: { type: 'string' },
      startSeconds: { type: 'number', minimum: 0 },
      endSeconds: { type: 'number', minimum: 0 },
      style: { type: 'object' },
    },
    ['item'],
  ),
  schema: z.object({
    item: z.string().min(1),
    cueId: z.string().min(1).optional(),
    text: z.string().optional(),
    startSeconds: z.number().min(0).optional(),
    endSeconds: z.number().min(0).optional(),
    style: textStyleSchema.optional(),
  }),
  summarize: () => 'Update subtitle item',
  execute: ({ item: handle, cueId, text, startSeconds, endSeconds, style }) => {
    const [item] = resolveItemHandles([handle], {
      allowSelection: false,
      itemTypes: ['subtitle', 'text'],
    })
    if (!item) throw new Error(`Subtitle item not found: ${handle}`)
    const timeline = useTimelineStore.getState()
    const currentStartSeconds = item.from / timeline.fps
    const currentEndSeconds = (item.from + item.durationInFrames) / timeline.fps
    let updates: Partial<TimelineItem>
    if (item.type === 'subtitle') {
      const subtitle = item as SubtitleSegmentItem
      const targetCueId = cueId ?? subtitle.cues[0]?.id
      const targetCue = subtitle.cues.find((cue) => cue.id === targetCueId)
      if (!targetCue) throw new Error(`Subtitle cue not found: ${targetCueId ?? 'none'}`)
      if (subtitle.cues.length > 1) {
        const segmentStartSeconds = subtitle.from / timeline.fps
        const segmentEndSeconds =
          (subtitle.from + subtitle.durationInFrames) / timeline.fps
        const nextCueStart =
          startSeconds === undefined
            ? targetCue.startSeconds
            : startSeconds - segmentStartSeconds
        const nextCueEnd =
          endSeconds === undefined
            ? targetCue.endSeconds
            : endSeconds - segmentStartSeconds
        if (nextCueStart < 0 || nextCueEnd > segmentEndSeconds - segmentStartSeconds) {
          throw new Error('Multi-cue timing must remain inside the subtitle segment.')
        }
        if (nextCueEnd <= nextCueStart) {
          throw new Error('endSeconds must be greater than startSeconds.')
        }
        updates = {
          cues: subtitle.cues.map((cue) =>
            cue.id === targetCue.id
              ? {
                  ...cue,
                  ...(text !== undefined ? { text } : {}),
                  startSeconds: nextCueStart,
                  endSeconds: nextCueEnd,
                }
              : cue,
          ),
          ...style,
        } as Partial<SubtitleSegmentItem>
      } else {
        const nextStart = startSeconds ?? currentStartSeconds
        const nextEnd = endSeconds ?? currentEndSeconds
        if (nextEnd <= nextStart) {
          throw new Error('endSeconds must be greater than startSeconds.')
        }
        const nextFrom = Math.round(nextStart * timeline.fps)
        const nextDuration = Math.max(1, Math.round((nextEnd - nextStart) * timeline.fps))
        updates = {
          from: nextFrom,
          durationInFrames: nextDuration,
          cues: [
            {
              ...targetCue,
              ...(text !== undefined ? { text } : {}),
              startSeconds: 0,
              endSeconds: nextDuration / timeline.fps,
            },
          ],
          ...style,
        } as Partial<SubtitleSegmentItem>
      }
    } else {
      const nextStart = startSeconds ?? currentStartSeconds
      const nextEnd = endSeconds ?? currentEndSeconds
      if (nextEnd <= nextStart) throw new Error('endSeconds must be greater than startSeconds.')
      const nextFrom = Math.round(nextStart * timeline.fps)
      const nextDuration = Math.max(1, Math.round((nextEnd - nextStart) * timeline.fps))
      updates = {
        from: nextFrom,
        durationInFrames: nextDuration,
        ...(text !== undefined ? { text } : {}),
        ...style,
      } as Partial<TextItem>
    }
    timeline.updateItem(item.id, updates)
    return {
      ok: true,
      message: `Updated subtitle ${item.id}.`,
      data: useTimelineStore.getState().items.find((candidate) => candidate.id === item.id),
      changed: true,
    }
  },
})

const styleSubtitles = definePlatformTool({
  name: 'style_subtitles',
  title: 'Style subtitles',
  description: 'Apply one typography style patch to multiple editable subtitle/caption items.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      style: { type: 'object' },
    },
    ['items', 'style'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    style: textStyleSchema,
  }),
  summarize: ({ items }) => `Style ${items.length} subtitle item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, style }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['subtitle', 'text'],
    }).filter((item) => item.type === 'subtitle' || (item.type === 'text' && item.textRole === 'caption'))
    if (items.length === 0) throw new Error('No editable subtitle items were found.')
    executeTimelineCommand(
      'AGENT_STYLE_SUBTITLES',
      () => {
        const store = useItemsStore.getState()
        for (const item of items) store._updateItem(item.id, style as Partial<TimelineItem>)
        useTimelineSettingsStore.getState().markDirty()
      },
      { itemIds: items.map((item) => item.id) },
    )
    return {
      ok: true,
      message: `Styled ${items.length} subtitle item${items.length === 1 ? '' : 's'}.`,
      data: { itemIds: items.map((item) => item.id), style },
      changed: true,
    }
  },
})

const applyEffect = definePlatformTool({
  name: 'apply_effect',
  title: 'Manage visual effect',
  description:
    'Add, replace, update, toggle, remove, or move registered GPU effects on visual timeline items.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      operation: {
        type: 'string',
        enum: ['add', 'replace', 'update', 'toggle', 'remove', 'move'],
      },
      gpuEffectType: { type: 'string' },
      effectId: { type: 'string' },
      params: { type: 'object' },
      enabled: { type: 'boolean' },
      index: { type: 'number', minimum: 0 },
      beforeEffectId: { type: 'string' },
      afterEffectId: { type: 'string' },
    },
    ['items', 'operation'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    operation: z.enum(['add', 'replace', 'update', 'toggle', 'remove', 'move']),
    gpuEffectType: z.string().min(1).optional(),
    effectId: z.string().min(1).optional(),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
    enabled: z.boolean().optional(),
    index: z.number().int().min(0).optional(),
    beforeEffectId: z.string().min(1).optional(),
    afterEffectId: z.string().min(1).optional(),
  }),
  summarize: ({ operation }) => `${operation} visual effect`,
  execute: ({
    items: handles,
    operation,
    gpuEffectType,
    effectId,
    params,
    enabled,
    index,
    beforeEffectId,
    afterEffectId,
  }) => {
    const items = resolveItemHandles(handles, { allowSelection: false }).filter(
      (item) => item.type !== 'audio',
    )
    if (items.length === 0) throw new Error('No visual timeline items were found.')
    if ((operation === 'add' || operation === 'replace') && !gpuEffectType) {
      throw new Error('gpuEffectType is required for add/replace.')
    }
    if (gpuEffectType && !getGpuEffect(gpuEffectType)) {
      throw new Error(`Unknown GPU effect: ${gpuEffectType}`)
    }
    if (
      (operation === 'update' ||
        operation === 'toggle' ||
        operation === 'remove' ||
        operation === 'move') &&
      !effectId
    ) {
      throw new Error('effectId is required for update/toggle/remove/move.')
    }
    if (
      operation === 'move' &&
      [index !== undefined, beforeEffectId !== undefined, afterEffectId !== undefined].filter(
        Boolean,
      ).length !== 1
    ) {
      throw new Error(
        'Exactly one of index, beforeEffectId, or afterEffectId is required for move.',
      )
    }

    const createdEffectIds: string[] = []
    const updates = items.flatMap((item) => {
      const current = item.effects ?? []
      let effects: ItemEffect[]
      if (operation === 'add' || operation === 'replace') {
        const id = crypto.randomUUID()
        createdEffectIds.push(id)
        const entry: ItemEffect = {
          id,
          enabled: enabled ?? true,
          effect: {
            type: 'gpu-effect',
            gpuEffectType: gpuEffectType!,
            params: { ...getGpuEffectDefaultParams(gpuEffectType!), ...params },
          },
        }
        effects = operation === 'replace' ? [entry] : [...current, entry]
      } else if (operation === 'remove') {
        effects = current.filter((entry) => entry.id !== effectId)
      } else if (operation === 'move') {
        effects = moveEffectInStack(current, effectId!, {
          index,
          beforeEffectId,
          afterEffectId,
        })
      } else {
        effects = current.map((entry) => {
          if (entry.id !== effectId || entry.effect.type !== 'gpu-effect') return entry
          if (operation === 'toggle') {
            return { ...entry, enabled: enabled ?? !entry.enabled }
          }
          return {
            ...entry,
            ...(enabled !== undefined ? { enabled } : {}),
            effect: {
              ...entry.effect,
              params: { ...entry.effect.params, ...params },
            },
          }
        })
      }
      return valuesEqual(current, effects) ? [] : [{ itemId: item.id, effects }]
    })
    const changed = updates.length > 0
    if (changed) useTimelineStore.getState().setItemEffects(updates)
    return {
      ok: true,
      message: changed
        ? `${operation} effect on ${updates.length} visual item${updates.length === 1 ? '' : 's'}.`
        : 'Effect stack was unchanged.',
      data: {
        itemIds: updates.map((update) => update.itemId),
        effectIds: createdEffectIds.length > 0 ? createdEffectIds : effectId ? [effectId] : [],
        gpuEffectType,
      },
      changed,
    }
  },
})

const keyframeOperationSchema = z.object({
  operation: z.enum(['add', 'update', 'remove', 'clear_property', 'clear_item']),
  item: z.string().min(1),
  property: z.string().min(1).optional(),
  keyframeId: z.string().min(1).optional(),
  frame: z.number().int().min(0).optional(),
  value: z.union([z.number(), z.string().regex(/^#[0-9A-Fa-f]{6}$/)]).optional(),
  easing: z
    .enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold', 'cubic-bezier', 'spring'])
    .optional(),
  easingConfig: z.record(z.string(), z.unknown()).optional(),
})

const setKeyframes = definePlatformTool({
  name: 'set_keyframes',
  title: 'Manage keyframes',
  description:
    'Add, update, remove, or clear transform, crop, audio, text, and GPU-effect keyframes in one undoable command.',
  inputSchema: objectSchema(
    {
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['add', 'update', 'remove', 'clear_property', 'clear_item'],
            },
            item: { type: 'string' },
            property: { type: 'string' },
            keyframeId: { type: 'string' },
            frame: { type: 'number', minimum: 0 },
            value: {
              oneOf: [{ type: 'number' }, { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }],
            },
            easing: { type: 'string' },
            easingConfig: { type: 'object' },
          },
          required: ['operation', 'item'],
        },
      },
    },
    ['operations'],
  ),
  schema: z.object({ operations: z.array(keyframeOperationSchema).min(1) }),
  summarize: ({ operations }) =>
    `Apply ${operations.length} keyframe operation${operations.length === 1 ? '' : 's'}`,
  execute: ({ operations }) => {
    const resolved = operations.map((operation) => {
      const [item] = resolveItemHandles([operation.item], { allowSelection: false })
      if (!item) throw new Error(`Timeline item not found: ${operation.item}`)
      let value: number | undefined
      if (typeof operation.value === 'string') {
        const converted = colorStringToKeyframeValue(operation.value)
        if (converted === null) throw new Error(`Invalid keyframe color: ${operation.value}`)
        value = converted
      } else {
        value = operation.value
      }
      return { ...operation, value, itemId: item.id }
    })
    const createdIds: string[] = []
    const beforeKeyframes = useKeyframesStore.getState().keyframes
    let changed = false
    executeTimelineCommand(
      'AGENT_SET_KEYFRAMES',
      () => {
        const store = useKeyframesStore.getState()
        for (const operation of resolved) {
          const property = operation.property as AnimatableProperty | undefined
          if (operation.operation === 'clear_item') {
            store._removeKeyframesForItem(operation.itemId)
            continue
          }
          if (!property) throw new Error('property is required for this keyframe operation.')
          if (operation.operation === 'clear_property') {
            store._removeKeyframesForProperty(operation.itemId, property)
            continue
          }
          if (!operation.keyframeId && operation.operation !== 'add') {
            throw new Error('keyframeId is required for update/remove.')
          }
          if (operation.operation === 'remove') {
            store._removeKeyframe(operation.itemId, property, operation.keyframeId!)
            continue
          }
          if (operation.operation === 'update') {
            const updates: Partial<Omit<Keyframe, 'id'>> = {
              ...(operation.frame !== undefined ? { frame: operation.frame } : {}),
              ...(operation.value !== undefined ? { value: operation.value } : {}),
              ...(operation.easing !== undefined
                ? { easing: operation.easing as EasingType }
                : {}),
              ...(operation.easingConfig !== undefined
                ? { easingConfig: operation.easingConfig as unknown as EasingConfig }
                : {}),
            }
            if (
              updates.frame !== undefined &&
              !canAddKeyframeAtFrame(operation.itemId, updates.frame)
            ) {
              throw new Error('A keyframe cannot be placed inside a transition region.')
            }
            store._updateKeyframe(
              operation.itemId,
              property,
              operation.keyframeId!,
              updates,
            )
            continue
          }
          if (operation.frame === undefined || operation.value === undefined) {
            throw new Error('frame and value are required to add a keyframe.')
          }
          if (!canAddKeyframeAtFrame(operation.itemId, operation.frame)) {
            throw new Error('A keyframe cannot be placed inside a transition region.')
          }
          createdIds.push(
            store._addKeyframe(
              operation.itemId,
              property,
              operation.frame,
              operation.value,
              operation.easing as EasingType | undefined,
              operation.easingConfig as unknown as EasingConfig | undefined,
            ),
          )
        }
        changed = !valuesEqual(beforeKeyframes, useKeyframesStore.getState().keyframes)
        if (changed) useTimelineSettingsStore.getState().markDirty()
      },
      { count: operations.length },
    )
    return {
      ok: true,
      message: changed
        ? `Applied ${operations.length} keyframe operation${operations.length === 1 ? '' : 's'}.`
        : 'Keyframes were unchanged.',
      data: { createdIds },
      changed,
    }
  },
})

const setTransition = definePlatformTool({
  name: 'set_transition',
  title: 'Manage transition',
  description:
    'Add, update, or remove a cut-centered transition with presentation, duration, direction, timing, alignment, and properties.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['add', 'update', 'remove'] },
      transitionId: { type: 'string' },
      leftItem: { type: 'string' },
      rightItem: { type: 'string' },
      presentation: { type: 'string' },
      durationSeconds: { type: 'number', minimum: 0.01 },
      direction: { type: 'string' },
      timing: {
        type: 'string',
        enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier'],
      },
      alignment: { type: 'number', minimum: 0, maximum: 1 },
      properties: { type: 'object' },
    },
    ['operation'],
  ),
  schema: z.object({
    operation: z.enum(['add', 'update', 'remove']),
    transitionId: z.string().min(1).optional(),
    leftItem: z.string().min(1).optional(),
    rightItem: z.string().min(1).optional(),
    presentation: z.string().min(1).optional(),
    durationSeconds: z.number().positive().optional(),
    direction: z.string().min(1).optional(),
    timing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier']).optional(),
    alignment: z.number().min(0).max(1).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  }),
  summarize: ({ operation }) => `${operation} transition`,
  execute: ({
    operation,
    transitionId,
    leftItem,
    rightItem,
    durationSeconds,
    presentation,
    direction,
    timing,
    alignment,
    properties,
  }) => {
    const timeline = useTimelineStore.getState()
    if (operation === 'remove') {
      if (!transitionId) throw new Error('transitionId is required to remove a transition.')
      timeline.removeTransition(transitionId)
      return {
        ok: true,
        message: `Removed transition ${transitionId}.`,
        data: { transitionId },
        changed: true,
      }
    }
    if (operation === 'update') {
      if (!transitionId) throw new Error('transitionId is required to update a transition.')
      timeline.updateTransition(transitionId, {
        ...(durationSeconds !== undefined
          ? { durationInFrames: Math.max(1, Math.round(durationSeconds * timeline.fps)) }
          : {}),
        ...(presentation !== undefined
          ? { presentation: presentation as TransitionPresentation }
          : {}),
        ...(direction !== undefined ? { direction: direction as never } : {}),
        ...(timing !== undefined ? { timing: timing as TransitionTiming } : {}),
        ...(alignment !== undefined ? { alignment } : {}),
        ...(properties !== undefined ? { properties } : {}),
      })
      return {
        ok: true,
        message: `Updated transition ${transitionId}.`,
        data: { transitionId },
        changed: true,
      }
    }
    if (!leftItem || !rightItem) {
      throw new Error('leftItem and rightItem are required to add a transition.')
    }
    const resolved = resolveItemHandles([leftItem, rightItem], { allowSelection: false })
    if (resolved.length !== 2) throw new Error('Both transition items must exist.')
    const [a, b] = resolved
    const [left, right] = a!.from <= b!.from ? [a!, b!] : [b!, a!]
    const ok = timeline.addTransition(
      left.id,
      right.id,
      'crossfade',
      durationSeconds === undefined
        ? undefined
        : Math.max(1, Math.round(durationSeconds * timeline.fps)),
      presentation as TransitionPresentation | undefined,
      direction as never,
      alignment,
    )
    if (!ok) throw new Error('Could not add a transition between those items.')
    const added = useTimelineStore
      .getState()
      .transitions.find(
        (transition) =>
          transition.leftClipId === left.id && transition.rightClipId === right.id,
      )
    if (added && (timing !== undefined || properties !== undefined)) {
      timeline.updateTransition(added.id, {
        ...(timing !== undefined ? { timing } : {}),
        ...(properties !== undefined ? { properties } : {}),
      })
    }
    return {
      ok: true,
      message: `Added ${presentation ?? 'fade'} transition.`,
      data: added,
      changed: true,
    }
  },
})

const setAudio = definePlatformTool({
  name: 'set_audio',
  title: 'Set clip audio',
  description:
    'Batch-update clip gain in dB, fades, fade curves, pitch, embedded-audio mute, and clip EQ.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      volumeDb: { type: 'number', minimum: -60, maximum: 12 },
      fadeInSeconds: { type: 'number', minimum: 0 },
      fadeOutSeconds: { type: 'number', minimum: 0 },
      fadeInCurve: { type: 'number', minimum: -1, maximum: 1 },
      fadeOutCurve: { type: 'number', minimum: -1, maximum: 1 },
      fadeInCurveX: { type: 'number', minimum: 0, maximum: 1 },
      fadeOutCurveX: { type: 'number', minimum: 0, maximum: 1 },
      pitchSemitones: { type: 'number', minimum: -12, maximum: 12 },
      pitchCents: { type: 'number', minimum: -100, maximum: 100 },
      embeddedAudioMuted: { type: 'boolean' },
      eq: { type: 'object' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string()).min(1),
    volumeDb: z.number().min(-60).max(12).optional(),
    fadeInSeconds: z.number().min(0).optional(),
    fadeOutSeconds: z.number().min(0).optional(),
    fadeInCurve: z.number().min(-1).max(1).optional(),
    fadeOutCurve: z.number().min(-1).max(1).optional(),
    fadeInCurveX: z.number().min(0).max(1).optional(),
    fadeOutCurveX: z.number().min(0).max(1).optional(),
    pitchSemitones: z.number().min(-12).max(12).optional(),
    pitchCents: z.number().min(-100).max(100).optional(),
    embeddedAudioMuted: z.boolean().optional(),
    eq: z.record(z.string(), z.unknown()).optional(),
  }),
  summarize: ({ items }) => `Set audio for ${items.length} clip${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, eq, ...settings }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['video', 'audio'],
    })
    if (items.length === 0) throw new Error('No video/audio items were found.')
    const eqUpdates = eq
      ? Object.fromEntries(
          Object.entries(eq).map(([key, value]) => [`audioEq${key[0]?.toUpperCase()}${key.slice(1)}`, value]),
        )
      : {}
    const updates: Partial<TimelineItem> = {
      ...(settings.volumeDb !== undefined ? { volume: settings.volumeDb } : {}),
      ...(settings.fadeInSeconds !== undefined ? { audioFadeIn: settings.fadeInSeconds } : {}),
      ...(settings.fadeOutSeconds !== undefined ? { audioFadeOut: settings.fadeOutSeconds } : {}),
      ...(settings.fadeInCurve !== undefined ? { audioFadeInCurve: settings.fadeInCurve } : {}),
      ...(settings.fadeOutCurve !== undefined ? { audioFadeOutCurve: settings.fadeOutCurve } : {}),
      ...(settings.fadeInCurveX !== undefined ? { audioFadeInCurveX: settings.fadeInCurveX } : {}),
      ...(settings.fadeOutCurveX !== undefined
        ? { audioFadeOutCurveX: settings.fadeOutCurveX }
        : {}),
      ...(settings.pitchSemitones !== undefined
        ? { audioPitchSemitones: settings.pitchSemitones }
        : {}),
      ...(settings.pitchCents !== undefined ? { audioPitchCents: settings.pitchCents } : {}),
      ...(settings.embeddedAudioMuted !== undefined
        ? { embeddedAudioMuted: settings.embeddedAudioMuted }
        : {}),
      ...eqUpdates,
    }
    const changedItems = items.filter((item) => hasTimelineItemChanges(item, updates))
    const changed = changedItems.length > 0
    if (changed) {
      executeTimelineCommand(
        'AGENT_SET_AUDIO',
        () => {
          const store = useItemsStore.getState()
          for (const item of changedItems) store._updateItem(item.id, updates)
          useTimelineSettingsStore.getState().markDirty()
        },
        { itemIds: changedItems.map((item) => item.id) },
      )
    }
    return {
      ok: true,
      message: changed
        ? `Updated audio for ${changedItems.length} clip${changedItems.length === 1 ? '' : 's'}.`
        : 'Audio settings were unchanged.',
      data: { itemIds: changedItems.map((item) => item.id), updates },
      changed,
    }
  },
})

const setMasterAudio = definePlatformTool({
  name: 'set_master_audio',
  title: 'Set master audio',
  description: 'Set project master-bus gain and bus EQ in one undoable timeline command.',
  inputSchema: objectSchema({
    volumeDb: { type: 'number', minimum: -60, maximum: 12 },
    eq: { type: 'object' },
  }),
  schema: z.object({
    volumeDb: z.number().min(-60).max(12).optional(),
    eq: z.record(z.string(), z.unknown()).optional(),
  }),
  summarize: () => 'Set master audio',
  execute: ({ volumeDb, eq }) => {
    executeTimelineCommand(
      'AGENT_SET_MASTER_AUDIO',
      () => {
        const playback = usePlaybackStore.getState()
        if (volumeDb !== undefined) playback.setMasterBusDb(volumeDb)
        if (eq !== undefined) playback.setBusAudioEq(eq as AudioEqSettings)
        useTimelineSettingsStore.getState().markDirty()
      },
      { volumeDb, hasEq: eq !== undefined },
    )
    return {
      ok: true,
      message: 'Updated master audio.',
      data: {
        masterBusDb: usePlaybackStore.getState().masterBusDb,
        busAudioEq: usePlaybackStore.getState().busAudioEq,
      },
      changed: true,
    }
  },
})

export const CREATIVE_PLATFORM_TOOLS = [
  addText,
  addShape,
  addAdjustmentLayer,
  setTransform,
  updateSubtitle,
  styleSubtitles,
  applyEffect,
  setKeyframes,
  setTransition,
  setAudio,
  setMasterAudio,
] as const
