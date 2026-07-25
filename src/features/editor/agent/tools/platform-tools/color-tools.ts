import { z } from 'zod'
import {
  applyGradePresetToEffectStack,
  autoBalanceFromFrame,
  blackPointFromPick,
  copyGradeFromItem,
  getGpuEffectDefaultParams,
  hasGradePresetEffects,
  hexToRgb01,
  isColorGradeEffectType,
  luma601,
  pasteGradeToItems,
  useUserPresetsStore,
  whiteBalanceFromPick,
  whitePointFromPick,
} from '@/features/editor/deps/effects-contract'
import { useTimelineStore } from '@/features/editor/deps/timeline-contract'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import {
  encodeLutData,
  parseCubeLut,
  resampleCubeLut,
} from '@/infrastructure/gpu-effects/lut/cube-lut'
import { usePreviewBridgeStore } from '@/shared/state/preview-bridge'
import { EFFECT_PRESETS, type ItemEffect, type VisualEffect } from '@/types/effects'
import type { TimelineItem } from '@/types/timeline'
import { definePlatformTool, objectSchema, resolveItemHandles } from './shared'

const MAX_EMBEDDED_LUT_SIZE = 33
const COLOR_WHEELS_TYPE = 'gpu-color-wheels'
const LUT_TYPE = 'gpu-lut'

const presetScopeSchema = z.enum(['effect', 'color_grade'])
const presetOperationSchema = z.enum(['list', 'capture', 'apply', 'delete'])
const samplePointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])

type PresetScope = z.infer<typeof presetScopeSchema>

interface PresetCatalogEntry {
  id: string
  name: string
  effects: VisualEffect[]
  source: 'built_in' | 'user'
  createdAt?: number
}

function resolveVisualItems(
  handles: readonly string[] | undefined,
  allowSelection: boolean,
): TimelineItem[] {
  const items = resolveItemHandles(handles, { allowSelection }).filter(
    (item) => item.type !== 'audio',
  )
  if (items.length === 0) throw new Error('No visual timeline items were found.')
  return items
}

function cloneVisualEffect(effect: VisualEffect): VisualEffect {
  return {
    ...effect,
    params: { ...effect.params },
  }
}

function getScopedPresetEffects(
  effects: readonly VisualEffect[],
  scope: PresetScope,
): VisualEffect[] {
  return scope === 'effect'
    ? [...effects]
    : effects.filter(
        (effect) => effect.type === 'gpu-effect' && isColorGradeEffectType(effect.gpuEffectType),
      )
}

async function getPresetCatalog(scope: PresetScope): Promise<PresetCatalogEntry[]> {
  await useUserPresetsStore.getState().loadPresets()
  const userPresets = useUserPresetsStore.getState().presets
  const builtIns: PresetCatalogEntry[] =
    scope === 'effect'
      ? EFFECT_PRESETS.map((preset) => ({
          ...preset,
          source: 'built_in' as const,
        }))
      : []
  const users: PresetCatalogEntry[] = userPresets
    .filter((preset) => scope === 'effect' || hasGradePresetEffects(preset.effects))
    .map((preset) => ({
      ...preset,
      source: 'user' as const,
    }))
  return [...builtIns, ...users]
}

function summarizePreset(preset: PresetCatalogEntry, scope: PresetScope) {
  const effects = getScopedPresetEffects(preset.effects, scope)
  return {
    id: preset.id,
    name: preset.name,
    source: preset.source,
    createdAt: preset.createdAt,
    effectCount: effects.length,
    gpuEffectTypes: effects.map((effect) => effect.gpuEffectType),
  }
}

function appendPresetEffects(
  current: readonly ItemEffect[] | undefined,
  effects: readonly VisualEffect[],
): ItemEffect[] {
  return [
    ...(current ?? []),
    ...effects.map((effect) => ({
      id: crypto.randomUUID(),
      enabled: true,
      effect: cloneVisualEffect(effect),
    })),
  ]
}

const manageEffectPreset = definePlatformTool({
  name: 'manage_effect_preset',
  destructive: true,
  title: 'Manage effect preset',
  description:
    'List, capture, apply, or delete built-in and user effect presets, including color-grade-only presets.',
  inputSchema: objectSchema(
    {
      scope: { type: 'string', enum: ['effect', 'color_grade'] },
      operation: {
        type: 'string',
        enum: ['list', 'capture', 'apply', 'delete'],
      },
      items: { type: 'array', items: { type: 'string' } },
      presetId: { type: 'string' },
      name: { type: 'string' },
    },
    ['scope', 'operation'],
  ),
  schema: z
    .object({
      scope: presetScopeSchema,
      operation: presetOperationSchema,
      items: z.array(z.string().min(1)).min(1).optional(),
      presetId: z.string().min(1).optional(),
      name: z.string().trim().min(1).max(120).optional(),
    })
    .superRefine((value, context) => {
      if (value.operation === 'capture' && !value.name) {
        context.addIssue({
          code: 'custom',
          message: 'name is required when operation is "capture".',
          path: ['name'],
        })
      }
      if ((value.operation === 'apply' || value.operation === 'delete') && !value.presetId) {
        context.addIssue({
          code: 'custom',
          message: `presetId is required when operation is "${value.operation}".`,
          path: ['presetId'],
        })
      }
    }),
  summarize: ({ scope, operation }) => `${operation} ${scope} preset`,
  execute: async ({ scope, operation, items: handles, presetId, name }) => {
    const catalog = await getPresetCatalog(scope)

    if (operation === 'list') {
      return {
        ok: true,
        message: `Listed ${catalog.length} ${scope === 'effect' ? 'effect' : 'color grade'} preset${catalog.length === 1 ? '' : 's'}.`,
        data: {
          scope,
          presets: catalog.map((preset) => summarizePreset(preset, scope)),
        },
        changed: false,
      }
    }

    if (operation === 'capture') {
      const [source] = resolveVisualItems(handles, true)
      const effects = getScopedPresetEffects(
        (source?.effects ?? []).filter((entry) => entry.enabled).map((entry) => entry.effect),
        scope,
      )
      if (!source || effects.length === 0) {
        return {
          ok: true,
          message: `No enabled ${scope === 'effect' ? 'effects' : 'color grade effects'} were available to capture.`,
          data: { scope, sourceItemId: source?.id ?? null },
          changed: false,
        }
      }
      const preset = await useUserPresetsStore.getState().addPreset(name!, effects)
      return {
        ok: true,
        message: preset
          ? `Captured preset "${preset.name}" from ${source.id}.`
          : 'The preset was not captured.',
        data: preset
          ? {
              scope,
              sourceItemId: source.id,
              preset: summarizePreset({ ...preset, source: 'user' }, scope),
            }
          : { scope, sourceItemId: source.id },
        changed: preset !== null,
      }
    }

    if (operation === 'delete') {
      const builtIn = EFFECT_PRESETS.find((preset) => preset.id === presetId)
      if (builtIn) {
        throw new Error(`Built-in preset ${presetId} cannot be deleted.`)
      }
      const preset = catalog.find(
        (candidate) => candidate.source === 'user' && candidate.id === presetId,
      )
      if (!preset) {
        return {
          ok: true,
          message: `User preset ${presetId} was not found in ${scope}.`,
          data: { scope, presetId },
          changed: false,
        }
      }
      await useUserPresetsStore.getState().removePreset(preset.id)
      return {
        ok: true,
        message: `Deleted preset "${preset.name}".`,
        data: { scope, presetId: preset.id },
        changed: true,
      }
    }

    const preset = catalog.find((candidate) => candidate.id === presetId)
    if (!preset) throw new Error(`Preset not found: ${presetId}`)
    const targets = resolveVisualItems(handles, true)
    const updates = targets.map((item) => ({
      itemId: item.id,
      effects:
        scope === 'color_grade'
          ? applyGradePresetToEffectStack(item.effects, preset.effects)
          : appendPresetEffects(item.effects, preset.effects),
    }))
    useTimelineStore.getState().setItemEffects(updates)
    return {
      ok: true,
      message: `Applied preset "${preset.name}" to ${targets.length} visual item${targets.length === 1 ? '' : 's'}.`,
      data: {
        scope,
        preset: summarizePreset(preset, scope),
        itemIds: targets.map((item) => item.id),
      },
      changed: updates.length > 0,
    }
  },
})

const manageColorGradeClipboard = definePlatformTool({
  name: 'manage_color_grade_clipboard',
  title: 'Manage color grade clipboard',
  description:
    'Copy the first available clip color grade or paste the current grade clipboard to visual timeline items.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['copy', 'paste'] },
      items: { type: 'array', items: { type: 'string' } },
    },
    ['operation'],
  ),
  schema: z.object({
    operation: z.enum(['copy', 'paste']),
    items: z.array(z.string().min(1)).min(1).optional(),
  }),
  summarize: ({ operation }) => `${operation} color grade`,
  execute: ({ operation, items: handles }) => {
    const items = resolveVisualItems(handles, true)
    if (operation === 'copy') {
      const source = items.find((item) => copyGradeFromItem(item.id))
      return {
        ok: true,
        message: source
          ? `Copied the color grade from ${source.id}.`
          : 'No color grade was available to copy.',
        data: { sourceItemId: source?.id ?? null },
        changed: false,
      }
    }

    const changed = pasteGradeToItems(items.map((item) => item.id))
    return {
      ok: true,
      message: changed
        ? `Pasted the color grade to ${items.length} visual item${items.length === 1 ? '' : 's'}.`
        : 'The color grade clipboard was empty.',
      data: { itemIds: changed ? items.map((item) => item.id) : [] },
      changed,
    }
  },
})

async function readCubeSource(
  path: string | undefined,
  cubeText: string | undefined,
): Promise<{ text: string; fallbackName: string }> {
  if (cubeText !== undefined) {
    return { text: cubeText, fallbackName: 'Imported LUT' }
  }

  const handles = (await getDevLocalMediaHandles(path!)).filter((handle) =>
    handle.name.toLowerCase().endsWith('.cube'),
  )
  if (handles.length !== 1) {
    throw new Error(
      handles.length === 0
        ? `No .cube LUT was found at ${path}.`
        : `The path contains multiple .cube LUT files: ${path}`,
    )
  }
  const file = await handles[0]!.getFile()
  return {
    text: await file.text(),
    fallbackName: file.name.replace(/\.cube$/i, ''),
  }
}

function paramsContain(
  params: Record<string, number | boolean | string>,
  updates: Record<string, number | boolean | string>,
): boolean {
  return Object.entries(updates).every(([key, value]) => params[key] === value)
}

const importCubeLut = definePlatformTool({
  name: 'import_cube_lut',
  title: 'Import cube LUT',
  description:
    'Import .cube text or a local .cube path, resample it to the embedded LUT limit, and add or update LUT effects.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      effectId: { type: 'string' },
      path: { type: 'string' },
      cubeText: { type: 'string' },
    },
    ['items'],
  ),
  schema: z
    .object({
      items: z.array(z.string().min(1)).min(1),
      effectId: z.string().min(1).optional(),
      path: z.string().trim().min(1).optional(),
      cubeText: z.string().min(1).optional(),
    })
    .superRefine((value, context) => {
      if (Number(value.path !== undefined) + Number(value.cubeText !== undefined) !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'Provide exactly one of path or cubeText.',
          path: ['path'],
        })
      }
    }),
  summarize: ({ items }) =>
    `Import cube LUT for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: async ({ items: handles, effectId, path, cubeText }) => {
    const items = resolveVisualItems(handles, false)
    const source = await readCubeSource(path, cubeText)
    const parsed = resampleCubeLut(parseCubeLut(source.text), MAX_EMBEDDED_LUT_SIZE)
    const params = {
      lutName: parsed.title?.trim() || source.fallbackName,
      lutSize: String(parsed.size),
      lutData: encodeLutData(parsed.data),
    }
    const updates: Array<{ itemId: string; effects: ItemEffect[] }> = []
    const changedEffectIds: string[] = []
    let matchedEffect = false

    for (const item of items) {
      if (effectId) {
        const entry = (item.effects ?? []).find((candidate) => candidate.id === effectId)
        if (!entry) continue
        matchedEffect = true
        if (entry.effect.type !== 'gpu-effect' || entry.effect.gpuEffectType !== LUT_TYPE) {
          throw new Error(`Effect ${effectId} is not a ${LUT_TYPE} effect.`)
        }
        if (paramsContain(entry.effect.params, params)) continue
        updates.push({
          itemId: item.id,
          effects: (item.effects ?? []).map((candidate) =>
            candidate.id === entry.id
              ? {
                  ...candidate,
                  effect: {
                    ...candidate.effect,
                    params: { ...candidate.effect.params, ...params },
                  },
                }
              : candidate,
          ),
        })
        changedEffectIds.push(entry.id)
        continue
      }

      const id = crypto.randomUUID()
      updates.push({
        itemId: item.id,
        effects: [
          ...(item.effects ?? []),
          {
            id,
            enabled: true,
            effect: {
              type: 'gpu-effect',
              gpuEffectType: LUT_TYPE,
              params: {
                ...getGpuEffectDefaultParams(LUT_TYPE),
                ...params,
              },
            },
          },
        ],
      })
      changedEffectIds.push(id)
    }

    if (effectId && !matchedEffect) {
      throw new Error(`LUT effect not found: ${effectId}`)
    }
    if (updates.length > 0) {
      useTimelineStore.getState().setItemEffects(updates)
    }
    return {
      ok: true,
      message:
        updates.length > 0
          ? `Imported LUT "${params.lutName}" into ${updates.length} visual item${updates.length === 1 ? '' : 's'}.`
          : `LUT "${params.lutName}" was already up to date.`,
      data: {
        itemIds: updates.map((update) => update.itemId),
        effectIds: changedEffectIds,
        lutName: params.lutName,
        lutSize: parsed.size,
      },
      changed: updates.length > 0,
    }
  },
})

async function sampleRenderedPoint(
  point: readonly [number, number],
): Promise<{ r: number; g: number; b: number }> {
  const capture = usePreviewBridgeStore.getState().captureFrameImageData
  if (!capture) throw new Error('Preview frame capture is unavailable.')
  const imageData = await capture()
  if (!imageData) throw new Error('The current preview frame could not be sampled.')
  const x = Math.round(point[0] * (imageData.width - 1))
  const y = Math.round(point[1] * (imageData.height - 1))
  const offset = (y * imageData.width + x) * 4
  return {
    r: (imageData.data[offset] ?? 0) / 255,
    g: (imageData.data[offset + 1] ?? 0) / 255,
    b: (imageData.data[offset + 2] ?? 0) / 255,
  }
}

function readNumberParam(
  params: Record<string, number | boolean | string>,
  defaults: Record<string, number | boolean | string>,
  key: string,
): number {
  const value = params[key]
  if (typeof value === 'number') return value
  const fallback = defaults[key]
  return typeof fallback === 'number' ? fallback : 0
}

const balanceColor = definePlatformTool({
  name: 'balance_color',
  title: 'Balance color',
  description:
    'Auto-balance the rendered frame or apply white-balance, black-point, and white-point picks through the color wheels effect.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
      operation: {
        type: 'string',
        enum: ['auto_balance', 'white_balance', 'black_point', 'white_point'],
      },
      sampleColor: { type: 'string' },
      samplePoint: {
        type: 'array',
        items: { type: 'number', minimum: 0, maximum: 1 },
        minItems: 2,
        maxItems: 2,
      },
    },
    ['items', 'operation'],
  ),
  schema: z
    .object({
      items: z.array(z.string().min(1)).min(1),
      operation: z.enum(['auto_balance', 'white_balance', 'black_point', 'white_point']),
      sampleColor: z.string().trim().min(1).optional(),
      samplePoint: samplePointSchema.optional(),
    })
    .superRefine((value, context) => {
      const sampleCount =
        Number(value.sampleColor !== undefined) + Number(value.samplePoint !== undefined)
      if (value.operation === 'auto_balance' && sampleCount !== 0) {
        context.addIssue({
          code: 'custom',
          message: 'auto_balance does not accept sampleColor or samplePoint.',
          path: ['operation'],
        })
      }
      if (value.operation !== 'auto_balance' && sampleCount !== 1) {
        context.addIssue({
          code: 'custom',
          message: 'Provide exactly one of sampleColor or samplePoint for this operation.',
          path: ['sampleColor'],
        })
      }
    }),
  summarize: ({ operation, items }) =>
    `${operation} ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: async ({ items: handles, operation, sampleColor, samplePoint }) => {
    const items = resolveVisualItems(handles, false)
    const defaults = getGpuEffectDefaultParams(COLOR_WHEELS_TYPE)
    const capture = usePreviewBridgeStore.getState().captureFrameImageData
    const frame =
      operation === 'auto_balance'
        ? await (async () => {
            if (!capture) throw new Error('Preview frame capture is unavailable.')
            const imageData = await capture({ width: 96, height: 54 })
            if (!imageData) {
              throw new Error('The current preview frame could not be captured.')
            }
            return imageData
          })()
        : null
    const picked =
      operation === 'auto_balance'
        ? null
        : sampleColor
          ? hexToRgb01(sampleColor)
          : await sampleRenderedPoint(samplePoint!)
    if (operation !== 'auto_balance' && !picked) {
      throw new Error(`Invalid sampleColor: ${sampleColor}`)
    }

    const updates: Array<{ itemId: string; effects: ItemEffect[] }> = []
    const changedEffectIds: string[] = []

    for (const item of items) {
      const entry = (item.effects ?? []).find(
        (candidate) =>
          candidate.effect.type === 'gpu-effect' &&
          candidate.effect.gpuEffectType === COLOR_WHEELS_TYPE,
      )
      const currentParams = entry?.effect.type === 'gpu-effect' ? entry.effect.params : defaults
      const current = {
        lift: readNumberParam(currentParams, defaults, 'lift'),
        gain: readNumberParam(currentParams, defaults, 'gain'),
        temperature: readNumberParam(currentParams, defaults, 'temperature'),
        tint: readNumberParam(currentParams, defaults, 'tint'),
      }
      let paramUpdates: Record<string, number | boolean | string>
      if (operation === 'auto_balance') {
        paramUpdates = autoBalanceFromFrame(frame!, current)
      } else if (operation === 'white_balance') {
        paramUpdates = whiteBalanceFromPick(picked!, current.temperature, current.tint)
      } else if (operation === 'black_point') {
        paramUpdates = {
          lift: blackPointFromPick(luma601(picked!), current.lift),
        }
      } else {
        paramUpdates = {
          gain: whitePointFromPick(luma601(picked!), current.gain),
        }
      }

      if (entry) {
        if (paramsContain(entry.effect.params, paramUpdates)) continue
        updates.push({
          itemId: item.id,
          effects: (item.effects ?? []).map((candidate) =>
            candidate.id === entry.id
              ? {
                  ...candidate,
                  effect: {
                    ...candidate.effect,
                    params: {
                      ...candidate.effect.params,
                      ...paramUpdates,
                    },
                  },
                }
              : candidate,
          ),
        })
        changedEffectIds.push(entry.id)
        continue
      }

      const id = crypto.randomUUID()
      updates.push({
        itemId: item.id,
        effects: [
          ...(item.effects ?? []),
          {
            id,
            enabled: true,
            effect: {
              type: 'gpu-effect',
              gpuEffectType: COLOR_WHEELS_TYPE,
              params: { ...defaults, ...paramUpdates },
            },
          },
        ],
      })
      changedEffectIds.push(id)
    }

    if (updates.length > 0) {
      useTimelineStore.getState().setItemEffects(updates)
    }
    return {
      ok: true,
      message:
        updates.length > 0
          ? `Applied ${operation} to ${updates.length} visual item${updates.length === 1 ? '' : 's'}.`
          : `The selected items were already ${operation.replace('_', ' ')}d.`,
      data: {
        operation,
        itemIds: updates.map((update) => update.itemId),
        effectIds: changedEffectIds,
        sampledColor: picked,
      },
      changed: updates.length > 0,
    }
  },
})

export const COLOR_PLATFORM_TOOLS = [
  manageEffectPreset,
  manageColorGradeClipboard,
  importCubeLut,
  balanceColor,
] as const
