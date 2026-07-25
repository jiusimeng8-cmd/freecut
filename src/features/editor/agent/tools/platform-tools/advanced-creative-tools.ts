import { z } from 'zod'
import {
  applyMotionModifierToItems,
  applyMotionPresetKeyframes,
  applyTextMotionEffect,
  executeTimelineCommand,
  removeMotionModifierFromItems,
  removeTextMotionEffect,
  useItemsStore,
  useKeyframesStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import {
  DEFAULT_MOTION_GENERATOR_SETTINGS,
  MOTION_PRESETS,
  applyMotionGeneratorSettings,
  createMotionModifier,
  getMotionPresetAnchorFrame,
  resolveAnimatedTransform,
} from '@/features/editor/deps/keyframes-contract'
import {
  getSourceDimensions,
  resolveTransform,
} from '@/features/editor/deps/composition-runtime-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import {
  TEXT_MOTION_IN_PRESET_IDS,
  TEXT_MOTION_LOOP_PRESET_IDS,
  TEXT_MOTION_OUT_PRESET_IDS,
  createTextMotionEffect,
} from '@/shared/typography/text-motion'
import type { BlendMode } from '@/types/blend-modes'
import type { AnimatableProperty } from '@/types/keyframe'
import type { MaskVertex } from '@/types/masks'
import type { MotionModifier, MotionModifierType } from '@/types/motion'
import type {
  TextMotionEffect,
  TextMotionEasing,
  TextMotionOrder,
  TextMotionSlot,
  TextMotionUnit,
} from '@/types/text-motion'
import type {
  LottieItem,
  ShapeItem,
  TimelineItem,
  TimelineItemCornerPin,
} from '@/types/timeline'
import {
  definePlatformTool,
  objectSchema,
  resolveItemHandles,
} from './shared'

const BLEND_MODES = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const satisfies readonly BlendMode[]

const MOTION_MODIFIER_TYPES = [
  'float-drift',
  'breath-pulse',
  'micro-shake',
  'sway',
  'spin',
] as const satisfies readonly MotionModifierType[]

const TEXT_MOTION_PRESET_IDS = [
  ...TEXT_MOTION_IN_PRESET_IDS,
  ...TEXT_MOTION_OUT_PRESET_IDS,
  ...TEXT_MOTION_LOOP_PRESET_IDS,
] as const

const MOTION_PRESET_PROPERTIES: AnimatableProperty[] = Array.from(
  new Set(MOTION_PRESETS.flatMap((preset) => preset.properties)),
)

const pointSchema = z.tuple([z.number(), z.number()])
const cornerPinSchema = z.object({
  topLeft: pointSchema,
  topRight: pointSchema,
  bottomRight: pointSchema,
  bottomLeft: pointSchema,
  referenceWidth: z.number().positive().optional(),
  referenceHeight: z.number().positive().optional(),
})

const maskVertexSchema = z.object({
  position: pointSchema,
  inHandle: pointSchema,
  outHandle: pointSchema,
})

function resolveVisualItems(handles: string[]): TimelineItem[] {
  const items = resolveItemHandles(handles, { allowSelection: false }).filter(
    (item) => item.type !== 'audio',
  )
  if (items.length === 0) throw new Error('No visual timeline items were found.')
  return items
}

const listAnimationCapabilities = definePlatformTool({
  name: 'list_animation_capabilities',
  title: 'List animation capabilities',
  description:
    'List built-in keyframe motion presets, procedural modifiers, text motion presets, slots, and supported blend modes.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'List animation capabilities',
  execute: () => ({
    ok: true,
    message: 'Read animation capability catalogs.',
    data: {
      motionPresets: MOTION_PRESETS.map((preset) => ({
        id: preset.id,
        category: preset.category,
        properties: preset.properties,
      })),
      motionModifiers: MOTION_MODIFIER_TYPES,
      textMotion: {
        in: TEXT_MOTION_IN_PRESET_IDS,
        out: TEXT_MOTION_OUT_PRESET_IDS,
        loop: TEXT_MOTION_LOOP_PRESET_IDS,
        slots: ['in', 'out', 'loop'],
        units: ['character', 'word', 'line', 'whole-clip'],
        orders: ['forward', 'backward', 'center', 'random'],
        easings: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot'],
      },
      blendModes: BLEND_MODES,
    },
  }),
})

const setVisualCompositing = definePlatformTool({
  name: 'set_visual_compositing',
  title: 'Set visual compositing',
  description:
    'Batch-update layer blend mode, video fade timing, perspective corner pin, or clear those properties.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      blendMode: { type: 'string', enum: [...BLEND_MODES] },
      fadeInSeconds: { type: 'number', minimum: 0 },
      fadeOutSeconds: { type: 'number', minimum: 0 },
      cornerPin: { type: 'object' },
      clearBlendMode: { type: 'boolean' },
      clearFades: { type: 'boolean' },
      clearCornerPin: { type: 'boolean' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    blendMode: z.enum(BLEND_MODES).optional(),
    fadeInSeconds: z.number().min(0).optional(),
    fadeOutSeconds: z.number().min(0).optional(),
    cornerPin: cornerPinSchema.optional(),
    clearBlendMode: z.boolean().optional(),
    clearFades: z.boolean().optional(),
    clearCornerPin: z.boolean().optional(),
  }),
  summarize: ({ items }) =>
    `Set compositing for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({
    items: handles,
    blendMode,
    fadeInSeconds,
    fadeOutSeconds,
    cornerPin,
    clearBlendMode = false,
    clearFades = false,
    clearCornerPin = false,
  }) => {
    const items = resolveVisualItems(handles)
    executeTimelineCommand(
      'AGENT_SET_VISUAL_COMPOSITING',
      () => {
        const store = useItemsStore.getState()
        for (const item of items) {
          store._updateItem(item.id, {
            ...(clearBlendMode
              ? { blendMode: undefined }
              : blendMode !== undefined
                ? { blendMode }
                : {}),
            ...(clearFades
              ? { fadeIn: undefined, fadeOut: undefined }
              : {
                  ...(fadeInSeconds !== undefined ? { fadeIn: fadeInSeconds } : {}),
                  ...(fadeOutSeconds !== undefined ? { fadeOut: fadeOutSeconds } : {}),
                }),
            ...(clearCornerPin
              ? { cornerPin: undefined }
              : cornerPin !== undefined
                ? { cornerPin: cornerPin as TimelineItemCornerPin }
                : {}),
          } as Partial<TimelineItem>)
        }
        useTimelineSettingsStore.getState().markDirty()
      },
      { itemIds: items.map((item) => item.id) },
    )
    return {
      ok: true,
      message: `Updated compositing for ${items.length} visual item${items.length === 1 ? '' : 's'}.`,
      data: {
        itemIds: items.map((item) => item.id),
        blendMode,
        fadeInSeconds,
        fadeOutSeconds,
        cornerPin,
        clearBlendMode,
        clearFades,
        clearCornerPin,
      },
      changed: true,
    }
  },
})

const setShapeProperties = definePlatformTool({
  name: 'set_shape_properties',
  title: 'Set shape and mask properties',
  description:
    'Batch-update shape fill, stroke, geometry, custom Bezier path, and mask behavior.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      shapeType: {
        type: 'string',
        enum: ['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'],
      },
      fillColor: { type: 'string' },
      strokeColor: { type: 'string' },
      strokeWidth: { type: 'number', minimum: 0 },
      cornerRadius: { type: 'number', minimum: 0 },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      points: { type: 'number', minimum: 3 },
      innerRadius: { type: 'number', minimum: 0, maximum: 1 },
      pathVertices: { type: 'array', items: { type: 'object' } },
      isMask: { type: 'boolean' },
      maskType: { type: 'string', enum: ['clip', 'alpha'] },
      maskFeather: { type: 'number', minimum: 0 },
      maskInvert: { type: 'boolean' },
      clearStroke: { type: 'boolean' },
      clearPath: { type: 'boolean' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    shapeType: z
      .enum(['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'])
      .optional(),
    fillColor: z.string().min(1).optional(),
    strokeColor: z.string().min(1).optional(),
    strokeWidth: z.number().min(0).optional(),
    cornerRadius: z.number().min(0).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    points: z.number().int().min(3).optional(),
    innerRadius: z.number().min(0).max(1).optional(),
    pathVertices: z.array(maskVertexSchema).min(2).optional(),
    isMask: z.boolean().optional(),
    maskType: z.enum(['clip', 'alpha']).optional(),
    maskFeather: z.number().min(0).optional(),
    maskInvert: z.boolean().optional(),
    clearStroke: z.boolean().optional(),
    clearPath: z.boolean().optional(),
  }),
  summarize: ({ items }) =>
    `Set shape properties for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, clearStroke = false, clearPath = false, ...patch }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['shape'],
    })
    if (items.length === 0) throw new Error('No shape items were found.')
    const updates: Partial<ShapeItem> = {
      ...patch,
      ...(patch.pathVertices ? { pathVertices: patch.pathVertices as MaskVertex[] } : {}),
      ...(clearStroke ? { strokeColor: undefined, strokeWidth: undefined } : {}),
      ...(clearPath ? { pathVertices: undefined } : {}),
    }
    const changedItems = items.filter((item) =>
      Object.entries(updates).some(
        ([key, value]) =>
          JSON.stringify((item as unknown as Record<string, unknown>)[key]) !==
          JSON.stringify(value),
      ),
    )
    const changed = changedItems.length > 0
    if (changed) {
      executeTimelineCommand(
        'AGENT_SET_SHAPE_PROPERTIES',
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
        ? `Updated ${changedItems.length} shape item${changedItems.length === 1 ? '' : 's'}.`
        : 'Shape properties were unchanged.',
      data: {
        itemIds: changedItems.map((item) => item.id),
        ...patch,
        clearStroke,
        clearPath,
      },
      changed,
    }
  },
})

const setLottieProperties = definePlatformTool({
  name: 'set_lottie_properties',
  title: 'Set Lottie properties',
  description:
    'Batch-update Lottie speed, loop/reverse mode, source segment, animation/theme selection, text, colors, and value slots.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      speed: { type: 'number', minimum: 0.1, maximum: 10 },
      loop: { type: 'boolean' },
      reversed: { type: 'boolean' },
      loopMode: { type: 'string', enum: ['loop', 'pingpong'] },
      segmentStart: { type: 'number', minimum: 0 },
      segmentEnd: { type: 'number', minimum: 0 },
      animationId: { type: 'string' },
      themeId: { type: 'string' },
      textOverrides: { type: 'object' },
      colorOverrides: { type: 'object' },
      slotOverrides: { type: 'object' },
      clearOverrides: { type: 'boolean' },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    speed: z.number().min(0.1).max(10).optional(),
    loop: z.boolean().optional(),
    reversed: z.boolean().optional(),
    loopMode: z.enum(['loop', 'pingpong']).optional(),
    segmentStart: z.number().int().min(0).optional(),
    segmentEnd: z.number().int().min(0).optional(),
    animationId: z.string().min(1).optional(),
    themeId: z.string().min(1).optional(),
    textOverrides: z.record(z.string(), z.string()).optional(),
    colorOverrides: z.record(z.string(), z.string()).optional(),
    slotOverrides: z
      .record(z.string(), z.union([z.number(), z.tuple([z.number(), z.number()])]))
      .optional(),
    clearOverrides: z.boolean().optional(),
  }),
  summarize: ({ items }) =>
    `Set Lottie properties for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles, clearOverrides = false, ...patch }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['lottie'],
    }) as LottieItem[]
    if (items.length === 0) throw new Error('No Lottie items were found.')
    for (const item of items) {
      if (
        patch.segmentStart !== undefined &&
        patch.segmentEnd !== undefined &&
        patch.segmentEnd <= patch.segmentStart
      ) {
        throw new Error('segmentEnd must be greater than segmentStart.')
      }
      if (patch.segmentStart !== undefined && patch.segmentStart >= item.totalFrames) {
        throw new Error(`segmentStart exceeds ${item.label}'s source frame count.`)
      }
      if (patch.segmentEnd !== undefined && patch.segmentEnd >= item.totalFrames) {
        throw new Error(`segmentEnd exceeds ${item.label}'s source frame count.`)
      }
    }
    executeTimelineCommand(
      'AGENT_SET_LOTTIE_PROPERTIES',
      () => {
        const store = useItemsStore.getState()
        for (const item of items) {
          store._updateItem(item.id, {
            ...patch,
            ...(clearOverrides
              ? {
                  animationId: undefined,
                  themeId: undefined,
                  textOverrides: undefined,
                  colorOverrides: undefined,
                  slotOverrides: undefined,
                }
              : {}),
          } as Partial<LottieItem>)
        }
        useTimelineSettingsStore.getState().markDirty()
      },
      { itemIds: items.map((item) => item.id) },
    )
    return {
      ok: true,
      message: `Updated ${items.length} Lottie item${items.length === 1 ? '' : 's'}.`,
      data: { itemIds: items.map((item) => item.id), ...patch, clearOverrides },
      changed: true,
    }
  },
})

const applyMotionPreset = definePlatformTool({
  name: 'apply_motion_preset',
  title: 'Apply motion preset',
  description:
    'Apply a built-in entrance, exit, or emphasis keyframe preset to visual items with duration, intensity, stagger, and merge/replace control.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      presetId: { type: 'string' },
      mode: { type: 'string', enum: ['merge', 'replace'] },
      durationScale: { type: 'number', minimum: 0.25, maximum: 3 },
      intensityScale: { type: 'number', minimum: 0, maximum: 2 },
      staggerFrames: { type: 'number', minimum: 0 },
    },
    ['items', 'presetId'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    presetId: z.string().min(1),
    mode: z.enum(['merge', 'replace']).optional(),
    durationScale: z.number().min(0.25).max(3).optional(),
    intensityScale: z.number().min(0).max(2).optional(),
    staggerFrames: z.number().min(0).optional(),
  }),
  summarize: ({ presetId, items }) =>
    `Apply ${presetId} to ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({
    items: handles,
    presetId,
    mode = 'replace',
    durationScale,
    intensityScale,
    staggerFrames,
  }) => {
    const preset = MOTION_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) throw new Error(`Unknown motion preset: ${presetId}`)
    const items = resolveVisualItems(handles)
    const timeline = useTimelineStore.getState()
    const project = useProjectStore.getState().currentProject
    const canvas = {
      width: project?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
      height: project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
      fps: timeline.fps,
    }
    const replace = mode === 'replace'
    const clearSet = new Set(MOTION_PRESET_PROPERTIES)
    const keyframesByItemId = useKeyframesStore.getState().keyframesByItemId
    const payloads: Array<{
      itemId: string
      property: AnimatableProperty
      frame: number
      value: number
      easing: Parameters<typeof applyMotionPresetKeyframes>[0][number]['easing']
      easingConfig?: Parameters<typeof applyMotionPresetKeyframes>[0][number]['easingConfig']
    }> = []
    const clears: Array<{
      itemId: string
      property: AnimatableProperty
      fromFrame: number
      toFrame: number
    }> = []

    items.forEach((item, index) => {
      const itemKeyframes = keyframesByItemId[item.id]
      const anchorKeyframes =
        replace && itemKeyframes
          ? {
              ...itemKeyframes,
              properties: itemKeyframes.properties.filter(
                (entry) => !clearSet.has(entry.property),
              ),
            }
          : itemKeyframes
      const base = resolveTransform(item, canvas, getSourceDimensions(item))
      const anchorFrame = getMotionPresetAnchorFrame(
        preset.category,
        item.durationInFrames,
        canvas.fps,
      )
      const anchor = resolveAnimatedTransform(base, anchorKeyframes, anchorFrame)
      const context = {
        anchor,
        durationInFrames: item.durationInFrames,
        fps: canvas.fps,
        frameWidth: canvas.width,
        frameHeight: canvas.height,
      }
      const built = applyMotionGeneratorSettings(
        preset,
        preset.build(context),
        context,
        {
          ...DEFAULT_MOTION_GENERATOR_SETTINGS,
          ...(durationScale !== undefined ? { durationScale } : {}),
          ...(intensityScale !== undefined ? { intensityScale } : {}),
          ...(staggerFrames !== undefined ? { staggerFrames } : {}),
        },
        index,
      )
      for (const keyframe of built) payloads.push({ itemId: item.id, ...keyframe })
      if (replace && built.length > 0) {
        const frames = built.map((keyframe) => keyframe.frame)
        const fromFrame = Math.min(...frames)
        const toFrame = Math.max(...frames)
        for (const property of MOTION_PRESET_PROPERTIES) {
          clears.push({ itemId: item.id, property, fromFrame, toFrame })
        }
      }
    })

    if (payloads.length === 0) throw new Error('The preset produced no keyframes.')
    const createdIds = applyMotionPresetKeyframes(payloads, replace ? clears : [])
    if (createdIds.length === 0) {
      throw new Error('Preset keyframes were blocked by a transition region.')
    }
    return {
      ok: true,
      message: `Applied ${preset.id} to ${items.length} visual item${items.length === 1 ? '' : 's'}.`,
      data: {
        itemIds: items.map((item) => item.id),
        presetId: preset.id,
        mode,
        keyframeIds: createdIds,
      },
      changed: true,
    }
  },
})

const manageMotionModifier = definePlatformTool({
  name: 'manage_motion_modifier',
  title: 'Manage procedural motion',
  description:
    'Apply, update, enable, disable, or remove float, breath, shake, sway, and spin motion modifiers.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      operation: { type: 'string', enum: ['set', 'remove'] },
      type: { type: 'string', enum: [...MOTION_MODIFIER_TYPES] },
      enabled: { type: 'boolean' },
      intensityScale: { type: 'number', minimum: 0, maximum: 2 },
      durationScale: { type: 'number', minimum: 0.25, maximum: 3 },
      staggerFrames: { type: 'number', minimum: 0 },
      frequency: { type: 'number', minimum: 0 },
      phaseFrames: { type: 'number', minimum: 0 },
      seed: { type: 'number' },
    },
    ['items', 'operation', 'type'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    operation: z.enum(['set', 'remove']),
    type: z.enum(MOTION_MODIFIER_TYPES),
    enabled: z.boolean().optional(),
    intensityScale: z.number().min(0).max(2).optional(),
    durationScale: z.number().min(0.25).max(3).optional(),
    staggerFrames: z.number().min(0).optional(),
    frequency: z.number().min(0).optional(),
    phaseFrames: z.number().min(0).optional(),
    seed: z.number().optional(),
  }),
  summarize: ({ operation, type }) => `${operation} ${type} motion`,
  execute: ({
    items: handles,
    operation,
    type,
    enabled,
    intensityScale,
    durationScale,
    staggerFrames,
    frequency,
    phaseFrames,
    seed,
  }) => {
    const items = resolveVisualItems(handles)
    if (operation === 'remove') {
      const updated = removeMotionModifierFromItems(
        items.map((item) => item.id),
        type,
      )
      if (updated === 0) throw new Error(`No ${type} modifier was present.`)
      return {
        ok: true,
        message: `Removed ${type} motion from ${updated} item${updated === 1 ? '' : 's'}.`,
        data: { itemIds: items.map((item) => item.id), type },
        changed: true,
      }
    }

    const assignments = items.map((item, index) => {
      const existing = item.motionModifiers?.find((modifier) => modifier.type === type)
      const generated = createMotionModifier(
        type,
        {
          ...DEFAULT_MOTION_GENERATOR_SETTINGS,
          ...(intensityScale !== undefined ? { intensityScale } : {}),
          ...(durationScale !== undefined ? { durationScale } : {}),
          ...(staggerFrames !== undefined ? { staggerFrames } : {}),
        },
        index,
      )
      const modifier: MotionModifier = {
        ...(existing ?? generated),
        type,
        ...(enabled !== undefined ? { enabled } : {}),
        ...(intensityScale !== undefined ? { amplitude: intensityScale } : {}),
        ...(frequency !== undefined ? { frequency } : {}),
        ...(phaseFrames !== undefined ? { phaseFrames } : {}),
        ...(seed !== undefined ? { seed } : {}),
      }
      return { itemId: item.id, modifier }
    })
    const updated = applyMotionModifierToItems(assignments)
    return {
      ok: true,
      message: `Set ${type} motion on ${updated} item${updated === 1 ? '' : 's'}.`,
      data: { type, modifiers: assignments },
      changed: updated > 0,
    }
  },
})

function presetMatchesSlot(slot: TextMotionSlot, presetId: string): boolean {
  if (slot === 'in') return TEXT_MOTION_IN_PRESET_IDS.includes(presetId as never)
  if (slot === 'out') return TEXT_MOTION_OUT_PRESET_IDS.includes(presetId as never)
  return TEXT_MOTION_LOOP_PRESET_IDS.includes(presetId as never)
}

const manageTextMotion = definePlatformTool({
  name: 'manage_text_motion',
  title: 'Manage text motion',
  description:
    'Set or remove per-character, word, line, or whole-clip text animation in the in, out, or loop slot.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      operation: { type: 'string', enum: ['set', 'remove'] },
      slot: { type: 'string', enum: ['in', 'out', 'loop'] },
      presetId: { type: 'string', enum: [...TEXT_MOTION_PRESET_IDS] },
      durationFrames: { type: 'number', minimum: 1 },
      staggerFrames: { type: 'number', minimum: 0 },
      intensity: { type: 'number', minimum: 0, maximum: 2 },
      order: { type: 'string', enum: ['forward', 'backward', 'center', 'random'] },
      easing: {
        type: 'string',
        enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot'],
      },
      seed: { type: 'number' },
      unit: { type: 'string', enum: ['character', 'word', 'line', 'whole-clip'] },
    },
    ['items', 'operation', 'slot'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
    operation: z.enum(['set', 'remove']),
    slot: z.enum(['in', 'out', 'loop']),
    presetId: z.enum(TEXT_MOTION_PRESET_IDS).optional(),
    durationFrames: z.number().int().min(1).optional(),
    staggerFrames: z.number().int().min(0).optional(),
    intensity: z.number().min(0).max(2).optional(),
    order: z.enum(['forward', 'backward', 'center', 'random']).optional(),
    easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'overshoot']).optional(),
    seed: z.number().int().optional(),
    unit: z.enum(['character', 'word', 'line', 'whole-clip']).optional(),
  }),
  summarize: ({ operation, slot }) => `${operation} ${slot} text motion`,
  execute: ({
    items: handles,
    operation,
    slot,
    presetId,
    durationFrames,
    staggerFrames,
    intensity,
    order,
    easing,
    seed,
    unit,
  }) => {
    const items = resolveItemHandles(handles, {
      allowSelection: false,
      itemTypes: ['text'],
    })
    if (items.length === 0) throw new Error('No text items were found.')
    if (operation === 'remove') {
      const updated = removeTextMotionEffect(
        items.map((item) => item.id),
        slot,
      )
      if (updated === 0) throw new Error(`No ${slot} text motion was present.`)
      return {
        ok: true,
        message: `Removed ${slot} text motion from ${updated} item${updated === 1 ? '' : 's'}.`,
        data: { itemIds: items.map((item) => item.id), slot },
        changed: true,
      }
    }
    if (!presetId) throw new Error('presetId is required to set text motion.')
    if (!presetMatchesSlot(slot, presetId)) {
      throw new Error(`${presetId} is not valid for the ${slot} text-motion slot.`)
    }
    const base = createTextMotionEffect(presetId, seed ?? 0)
    const effect: TextMotionEffect = {
      ...base,
      ...(durationFrames !== undefined ? { durationFrames } : {}),
      ...(staggerFrames !== undefined ? { staggerFrames } : {}),
      ...(intensity !== undefined ? { intensity } : {}),
      ...(order !== undefined ? { order: order as TextMotionOrder } : {}),
      ...(easing !== undefined ? { easing: easing as TextMotionEasing } : {}),
      ...(unit !== undefined ? { unit: unit as TextMotionUnit } : {}),
    }
    const updated = applyTextMotionEffect(
      items.map((item) => item.id),
      slot,
      effect,
    )
    if (updated === 0) throw new Error('Text motion could not be applied.')
    return {
      ok: true,
      message: `Applied ${presetId} ${slot} motion to ${updated} text item${updated === 1 ? '' : 's'}.`,
      data: { itemIds: items.map((item) => item.id), slot, effect },
      changed: true,
    }
  },
})

export const ADVANCED_CREATIVE_PLATFORM_TOOLS = [
  listAnimationCapabilities,
  setVisualCompositing,
  setShapeProperties,
  setLottieProperties,
  applyMotionPreset,
  manageMotionModifier,
  manageTextMotion,
] as const
