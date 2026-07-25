import { z } from 'zod'
import {
  getSourceDimensions,
  resolveTransform,
} from '@/features/editor/deps/composition-runtime-contract'
import {
  buildBakeMotionPlan,
  getAnimatablePropertiesForItem,
  loadCustomPresets,
  saveCustomPresets,
  useAutoKeyframeStore,
  type EasingPreset,
} from '@/features/editor/deps/keyframes-contract'
import {
  resolveMediaUrl,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import {
  buildLottieAttribution,
  LOTTIE_PAGE_SIZE,
  useLottieBrowserStore,
  type LottieBrowseCategory,
  type LottieFilesAnimation,
} from '@/features/editor/deps/lottie-browser-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import {
  applyAnimationPreset,
  bakeMotionToKeyframes,
  captureAnimationFromItem,
  useKeyframesStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { extractLottieColorLayers } from '@/infrastructure/lottie/lottie-color'
import {
  fetchLottieAnimation,
  fetchLottieManifest,
  readLottieMarkers,
} from '@/infrastructure/lottie/lottie-metadata'
import { extractLottieValueSlots } from '@/infrastructure/lottie/lottie-slots'
import { extractLottieTextLayers } from '@/infrastructure/lottie/lottie-text'
import {
  readAnimationPresets,
  saveAnimationPresets,
  type AnimationPreset,
} from '@/infrastructure/storage'
import type { AnimatableProperty } from '@/types/keyframe'
import type { LottieItem, TimelineItem } from '@/types/timeline'
import { definePlatformTool, objectSchema, resolveItemHandles } from './shared'

const animationPresetSchema = z
  .object({
    operation: z.enum(['list', 'capture', 'apply', 'delete']),
    item: z.string().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    presetId: z.string().min(1).optional(),
    anchorFrame: z.number().int().min(0).optional(),
    mode: z.enum(['add', 'replace']).optional(),
  })
  .superRefine((value, context) => {
    if ((value.operation === 'capture' || value.operation === 'apply') && !value.item) {
      context.addIssue({
        code: 'custom',
        path: ['item'],
        message: `item is required for ${value.operation}`,
      })
    }
    if (value.operation === 'capture' && !value.name) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'name is required for capture',
      })
    }
    if ((value.operation === 'apply' || value.operation === 'delete') && !value.presetId) {
      context.addIssue({
        code: 'custom',
        path: ['presetId'],
        message: `presetId is required for ${value.operation}`,
      })
    }
  })

const bezierSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
})

const springSchema = z.object({
  tension: z.number(),
  friction: z.number(),
  mass: z.number(),
})

const easingPresetSchema = z
  .object({
    operation: z.enum(['list', 'save', 'delete']),
    name: z.string().trim().min(1).optional(),
    type: z.enum(['Easing', 'Spring']).optional(),
    bezier: bezierSchema.optional(),
    spring: springSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.operation === 'save' || value.operation === 'delete') && !value.name) {
      context.addIssue({
        code: 'custom',
        path: ['name'],
        message: `name is required for ${value.operation}`,
      })
    }
    if (value.operation !== 'save') return
    if (!value.type) {
      context.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'type is required for save',
      })
    } else if (value.type === 'Easing' && !value.bezier) {
      context.addIssue({
        code: 'custom',
        path: ['bezier'],
        message: 'bezier is required for an Easing preset',
      })
    } else if (value.type === 'Spring' && !value.spring) {
      context.addIssue({
        code: 'custom',
        path: ['spring'],
        message: 'spring is required for a Spring preset',
      })
    }
  })

function getOpenProject() {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('No project is open.')
  return project
}

function getSingleItem(handle: string, itemTypes?: TimelineItem['type'][]): TimelineItem {
  const [item] = resolveItemHandles([handle], {
    allowSelection: false,
    ...(itemTypes ? { itemTypes } : {}),
  })
  if (!item) throw new Error(`Timeline item not found: ${handle}`)
  return item
}

function sameEasingPreset(left: EasingPreset, right: EasingPreset): boolean {
  if (left.name !== right.name || left.type !== right.type) return false
  if (left.type === 'Easing' && right.type === 'Easing') {
    return (
      left.bezier?.x1 === right.bezier?.x1 &&
      left.bezier?.y1 === right.bezier?.y1 &&
      left.bezier?.x2 === right.bezier?.x2 &&
      left.bezier?.y2 === right.bezier?.y2
    )
  }
  if (left.type === 'Spring' && right.type === 'Spring') {
    return (
      left.spring?.tension === right.spring?.tension &&
      left.spring?.friction === right.spring?.friction &&
      left.spring?.mass === right.spring?.mass
    )
  }
  return false
}

function summarizeCatalogItem(item: LottieFilesAnimation) {
  return {
    id: item.id,
    name: item.name,
    lottieUrl: item.lottieUrl,
    gifUrl: item.gifUrl,
    bgColor: item.bgColor,
    author: item.author,
    authorPath: item.authorPath,
  }
}

const bakeMotionToKeyframesTool = definePlatformTool({
  name: 'bake_motion_to_keyframes',
  title: 'Bake motion to keyframes',
  description:
    'Bake enabled procedural motion modifiers and audio-pulse modulation into ordinary keyframes in one undoable timeline command.',
  inputSchema: objectSchema(
    {
      items: { type: 'array', items: { type: 'string' } },
    },
    ['items'],
  ),
  schema: z.object({
    items: z.array(z.string().min(1)).min(1),
  }),
  summarize: ({ items }) => `Bake motion for ${items.length} item${items.length === 1 ? '' : 's'}`,
  execute: ({ items: handles }) => {
    const items = resolveItemHandles(handles, { allowSelection: false })
    if (items.length === 0) throw new Error('No timeline items were found.')

    const project = getOpenProject()
    const timeline = useTimelineStore.getState()
    const plan = buildBakeMotionPlan({
      items,
      keyframesByItemId: useKeyframesStore.getState().keyframesByItemId,
      fps: timeline.fps,
      frameWidth: project.metadata.width,
      frameHeight: project.metadata.height,
      resolveBase: (item) =>
        resolveTransform(
          item,
          {
            width: project.metadata.width,
            height: project.metadata.height,
            fps: timeline.fps,
          },
          getSourceDimensions(item),
        ),
    })

    if (plan.length === 0) {
      return {
        ok: true,
        message: 'No enabled procedural motion was available to bake.',
        data: { itemIds: items.map((item) => item.id), bakedItems: 0, keyframes: 0 },
        changed: false,
      }
    }

    const bakedItems = bakeMotionToKeyframes(plan)
    const keyframes = plan.reduce((total, entry) => total + entry.keyframes.length, 0)
    return {
      ok: true,
      message: `Baked procedural motion for ${bakedItems} item${bakedItems === 1 ? '' : 's'}.`,
      data: {
        itemIds: plan.map((entry) => entry.itemId),
        bakedItems,
        keyframes,
      },
      changed: bakedItems > 0,
    }
  },
})

const manageAnimationPreset = definePlatformTool({
  name: 'manage_animation_preset',
  destructive: true,
  title: 'Manage animation presets',
  description:
    'List, capture, apply, or delete project-scoped workspace animation presets. Applying uses the existing undo-integrated preset action.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['list', 'capture', 'apply', 'delete'] },
      item: { type: 'string' },
      name: { type: 'string' },
      presetId: { type: 'string' },
      anchorFrame: { type: 'number', minimum: 0 },
      mode: { type: 'string', enum: ['add', 'replace'] },
    },
    ['operation'],
  ),
  schema: animationPresetSchema,
  summarize: ({ operation, name, presetId }) =>
    `${operation} animation preset${name ? ` ${name}` : presetId ? ` ${presetId}` : ''}`,
  execute: async ({
    operation,
    item: handle,
    name,
    presetId,
    anchorFrame = 0,
    mode = 'replace',
  }) => {
    const projectId = getOpenProject().id
    const presets = await readAnimationPresets(projectId)

    if (operation === 'list') {
      return {
        ok: true,
        message: `Read ${presets.length} animation preset${presets.length === 1 ? '' : 's'}.`,
        data: { projectId, presets },
        changed: false,
      }
    }

    if (operation === 'capture') {
      const item = getSingleItem(handle!)
      const captured = captureAnimationFromItem(
        item,
        useKeyframesStore.getState().keyframesByItemId[item.id],
      )
      if (!captured) {
        return {
          ok: true,
          message: `Timeline item ${item.id} has no keyframes to capture.`,
          data: { projectId, itemId: item.id, preset: null },
          changed: false,
        }
      }

      const preset: AnimationPreset = {
        id: crypto.randomUUID(),
        name: name!,
        createdAt: Date.now(),
        ...captured,
      }
      const next = [
        ...presets.filter(
          (candidate) => candidate.name.toLowerCase() !== preset.name.toLowerCase(),
        ),
        preset,
      ]
      await saveAnimationPresets(projectId, next)
      return {
        ok: true,
        message: `Captured animation preset "${preset.name}".`,
        data: { projectId, itemId: item.id, preset },
        changed: true,
      }
    }

    const preset = presets.find((candidate) => candidate.id === presetId)
    if (!preset) {
      if (operation === 'apply') {
        return {
          ok: false,
          message: `Animation preset ${presetId} was not found.`,
          data: { projectId, presetId },
          error: {
            code: 'ANIMATION_PRESET_NOT_FOUND',
            message: `Animation preset ${presetId} was not found.`,
          },
          changed: false,
        }
      }
      return {
        ok: true,
        message: `Animation preset ${presetId} was already absent.`,
        data: { projectId, presetId },
        changed: false,
      }
    }

    if (operation === 'delete') {
      await saveAnimationPresets(
        projectId,
        presets.filter((candidate) => candidate.id !== preset.id),
      )
      return {
        ok: true,
        message: `Deleted animation preset "${preset.name}".`,
        data: { projectId, presetId: preset.id, name: preset.name },
        changed: true,
      }
    }

    const item = getSingleItem(handle!)
    const result = applyAnimationPreset(item.id, preset, anchorFrame, {
      replace: mode === 'replace',
    })
    const changed = result.applied > 0 || result.addedEffects > 0
    if (result.incompatible) {
      return {
        ok: false,
        message: `Animation preset "${preset.name}" is incompatible with ${item.label}.`,
        data: { projectId, itemId: item.id, presetId: preset.id, result },
        error: {
          code: 'ANIMATION_PRESET_INCOMPATIBLE',
          message: result.reason ?? 'The preset is incompatible with the target item.',
        },
        changed: false,
      }
    }
    if (!changed) {
      return {
        ok: false,
        message: `Animation preset "${preset.name}" did not apply any keyframes or effects.`,
        data: { projectId, itemId: item.id, presetId: preset.id, result },
        error: {
          code: 'ANIMATION_PRESET_NOT_APPLIED',
          message: 'The preset produced no timeline changes.',
        },
        changed: false,
      }
    }
    return {
      ok: true,
      message: `Applied animation preset "${preset.name}" to ${item.label}.`,
      data: {
        projectId,
        itemId: item.id,
        presetId: preset.id,
        anchorFrame,
        mode,
        result,
      },
      changed: true,
    }
  },
})

const setAutoKeyframe = definePlatformTool({
  name: 'set_auto_keyframe',
  title: 'Set auto-keyframe',
  description: 'Enable or disable auto-keyframing for one animatable property on one item.',
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      property: { type: 'string' },
      enabled: { type: 'boolean' },
    },
    ['item', 'property', 'enabled'],
  ),
  schema: z.object({
    item: z.string().min(1),
    property: z.string().min(1),
    enabled: z.boolean(),
  }),
  summarize: ({ property, enabled }) =>
    `${enabled ? 'Enable' : 'Disable'} auto-keyframe for ${property}`,
  execute: ({ item: handle, property, enabled }) => {
    const item = getSingleItem(handle)
    const animatableProperty = property as AnimatableProperty
    if (!getAnimatablePropertiesForItem(item).includes(animatableProperty)) {
      throw new Error(`${property} is not animatable on ${item.label}.`)
    }

    const store = useAutoKeyframeStore.getState()
    const previous = store.isAutoKeyframeEnabled(item.id, animatableProperty)
    if (previous === enabled) {
      return {
        ok: true,
        message: `Auto-keyframe for ${property} on ${item.label} was already ${enabled ? 'enabled' : 'disabled'}.`,
        data: { itemId: item.id, property, enabled },
        changed: false,
      }
    }

    store.setAutoKeyframeEnabled(item.id, animatableProperty, enabled)
    return {
      ok: true,
      message: `${enabled ? 'Enabled' : 'Disabled'} auto-keyframe for ${property} on ${item.label}.`,
      data: { itemId: item.id, property, enabled },
      changed: true,
    }
  },
})

const manageEasingPreset = definePlatformTool({
  name: 'manage_easing_preset',
  destructive: true,
  title: 'Manage easing presets',
  description: 'List, save, or delete globally persisted custom easing and spring presets.',
  requiresProject: false,
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['list', 'save', 'delete'] },
      name: { type: 'string' },
      type: { type: 'string', enum: ['Easing', 'Spring'] },
      bezier: {
        type: 'object',
        properties: {
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
        additionalProperties: false,
      },
      spring: {
        type: 'object',
        properties: {
          tension: { type: 'number' },
          friction: { type: 'number' },
          mass: { type: 'number' },
        },
        required: ['tension', 'friction', 'mass'],
        additionalProperties: false,
      },
    },
    ['operation'],
  ),
  schema: easingPresetSchema,
  summarize: ({ operation, name }) => `${operation} easing preset${name ? ` ${name}` : ''}`,
  execute: ({ operation, name, type, bezier, spring }) => {
    const presets = loadCustomPresets()
    if (operation === 'list') {
      return {
        ok: true,
        message: `Read ${presets.length} custom easing preset${presets.length === 1 ? '' : 's'}.`,
        data: { presets },
        changed: false,
      }
    }

    if (operation === 'delete') {
      const next = presets.filter((preset) => preset.name !== name)
      if (next.length === presets.length) {
        return {
          ok: true,
          message: `Easing preset "${name}" was already absent.`,
          data: { name },
          changed: false,
        }
      }
      saveCustomPresets(next)
      if (JSON.stringify(loadCustomPresets()) !== JSON.stringify(next)) {
        return {
          ok: false,
          message: `Failed to delete easing preset "${name}".`,
          error: {
            code: 'EASING_PRESET_SAVE_FAILED',
            message: 'The custom easing preset store did not persist the deletion.',
          },
          changed: false,
        }
      }
      return {
        ok: true,
        message: `Deleted easing preset "${name}".`,
        data: { name },
        changed: true,
      }
    }

    const preset: EasingPreset =
      type === 'Spring'
        ? { name: name!, type, spring: spring! }
        : { name: name!, type: 'Easing', bezier: bezier! }
    const existing = presets.find((candidate) => candidate.name === preset.name)
    if (existing && sameEasingPreset(existing, preset)) {
      return {
        ok: true,
        message: `Easing preset "${preset.name}" already has those values.`,
        data: { preset },
        changed: false,
      }
    }

    const next = [...presets.filter((candidate) => candidate.name !== preset.name), preset]
    saveCustomPresets(next)
    if (JSON.stringify(loadCustomPresets()) !== JSON.stringify(next)) {
      return {
        ok: false,
        message: `Failed to save easing preset "${preset.name}".`,
        error: {
          code: 'EASING_PRESET_SAVE_FAILED',
          message: 'The custom easing preset store did not persist the preset.',
        },
        changed: false,
      }
    }
    return {
      ok: true,
      message: `Saved easing preset "${preset.name}".`,
      data: { preset },
      changed: true,
    }
  },
})

const inspectLottie = definePlatformTool({
  name: 'inspect_lottie',
  title: 'Inspect Lottie',
  description:
    'Inspect one Lottie item and return editable text layers, color layers, value slots, markers, bundled animations, and themes.',
  inputSchema: objectSchema({ item: { type: 'string' } }, ['item']),
  readOnly: true,
  schema: z.object({ item: z.string().min(1) }),
  summarize: ({ item }) => `Inspect Lottie item ${item}`,
  execute: async ({ item: handle }) => {
    const item = getSingleItem(handle, ['lottie']) as LottieItem
    let source = item.src
    if (item.mediaId) {
      const resolved = await resolveMediaUrl(item.mediaId).catch(() => null)
      if (resolved) source = resolved
    }
    if (!source) throw new Error(`Lottie source is unavailable for ${item.label}.`)

    const [animation, manifest] = await Promise.all([
      fetchLottieAnimation(source, false, item.animationId),
      fetchLottieManifest(source),
    ])
    if (!animation) {
      return {
        ok: false,
        message: `Could not read the Lottie source for ${item.label}.`,
        error: {
          code: 'LOTTIE_INSPECTION_FAILED',
          message: 'The Lottie source could not be fetched or parsed.',
          retryable: true,
        },
        changed: false,
      }
    }

    const data = {
      itemId: item.id,
      animationId: item.animationId ?? null,
      textLayers: extractLottieTextLayers(animation),
      colorLayers: extractLottieColorLayers(animation),
      valueSlots: extractLottieValueSlots(animation),
      markers: readLottieMarkers(animation),
      animations: manifest?.animations ?? [],
      themes: manifest?.themes ?? [],
    }
    return {
      ok: true,
      message: `Inspected Lottie item ${item.label}.`,
      data,
      changed: false,
    }
  },
})

const searchLottieCatalog = definePlatformTool({
  name: 'search_lottie_catalog',
  title: 'Search Lottie catalog',
  description:
    'Search or browse the public LottieFiles catalog and populate the shared Lottie browser store.',
  requiresProject: false,
  inputSchema: objectSchema({
    query: { type: 'string' },
    category: { type: 'string', enum: ['featured', 'popular', 'recent'] },
    page: { type: 'number', minimum: 0 },
  }),
  readOnly: true,
  schema: z.object({
    query: z.string().optional(),
    category: z.enum(['featured', 'popular', 'recent']).optional(),
    page: z.number().int().min(0).optional(),
  }),
  summarize: ({ query, category }) =>
    query?.trim()
      ? `Search LottieFiles for ${query.trim()}`
      : `Browse ${category ?? 'featured'} LottieFiles`,
  execute: async ({ query = '', category = 'featured', page = 0 }) => {
    const store = useLottieBrowserStore.getState()
    store.setCategory(category as LottieBrowseCategory)
    store.setQuery(query.trim())
    await useLottieBrowserStore.getState().goToPage(page)

    const result = useLottieBrowserStore.getState()
    if (result.status === 'error') {
      return {
        ok: false,
        message: 'LottieFiles catalog search failed.',
        data: { query: result.query, category: result.category, page },
        error: {
          code: 'LOTTIE_CATALOG_SEARCH_FAILED',
          message: result.error ?? 'The LottieFiles catalog could not be loaded.',
          retryable: true,
        },
        changed: false,
      }
    }

    return {
      ok: true,
      message: `Found ${result.totalCount} LottieFiles catalog item${result.totalCount === 1 ? '' : 's'}.`,
      data: {
        query: result.query,
        category: result.category,
        page: result.page,
        pageSize: LOTTIE_PAGE_SIZE,
        totalCount: result.totalCount,
        hasNextPage: (result.page + 1) * LOTTIE_PAGE_SIZE < result.totalCount,
        items: result.items.map(summarizeCatalogItem),
      },
      changed: false,
    }
  },
})

const importLottieCatalogItem = definePlatformTool({
  name: 'import_lottie_catalog_item',
  title: 'Import Lottie catalog item',
  description:
    'Import one item from the current LottieFiles catalog results through the shared browser/media stores while preserving provider attribution.',
  inputSchema: objectSchema({ itemId: { type: 'string' } }, ['itemId']),
  schema: z.object({ itemId: z.string().min(1) }),
  summarize: ({ itemId }) => `Import LottieFiles item ${itemId}`,
  execute: async ({ itemId }) => {
    const project = getOpenProject()
    const browser = useLottieBrowserStore.getState()
    const animation = browser.items.find((item) => item.id === itemId)
    if (!animation) {
      throw new Error(`LottieFiles item ${itemId} is not in the current catalog page.`)
    }

    const mediaStore = useMediaLibraryStore.getState()
    if (mediaStore.currentProjectId !== project.id) {
      mediaStore.setCurrentProject(project.id)
      await useMediaLibraryStore.getState().loadMediaItems()
    }
    const beforeIds = new Set(useMediaLibraryStore.getState().mediaItems.map((item) => item.id))

    const imported = await useMediaLibraryStore.getState().importRemoteLottie({
      url: animation.lottieUrl,
      fileName: animation.name,
      attribution: buildLottieAttribution(animation),
    })
    if (!imported) {
      return {
        ok: false,
        message: `Failed to import LottieFiles item "${animation.name}".`,
        data: { item: summarizeCatalogItem(animation) },
        error: {
          code: 'LOTTIE_CATALOG_IMPORT_FAILED',
          message:
            useMediaLibraryStore.getState().error ?? 'The LottieFiles item could not be imported.',
          retryable: true,
        },
        changed: false,
      }
    }
    useLottieBrowserStore.setState((state) => {
      const failedIds = new Set(state.failedIds)
      failedIds.delete(animation.id)
      return {
        importedIds: new Set(state.importedIds).add(animation.id),
        failedIds,
      }
    })

    const mediaItems = useMediaLibraryStore.getState().mediaItems
    const importedMedia =
      mediaItems.find((media) => media.id === imported.id) ??
      mediaItems.find((media) => !beforeIds.has(media.id))
    const changed = mediaItems.some((media) => !beforeIds.has(media.id))
    return {
      ok: true,
      message: changed
        ? `Imported LottieFiles item "${animation.name}".`
        : `LottieFiles item "${animation.name}" was already in the media library.`,
      data: {
        item: summarizeCatalogItem(animation),
        mediaId: importedMedia?.id ?? null,
        fileName: importedMedia?.fileName ?? null,
        attribution: importedMedia?.attribution ?? buildLottieAttribution(animation),
        duplicate: !changed,
      },
      changed,
    }
  },
})

export const ANIMATION_LOTTIE_PLATFORM_TOOLS = [
  bakeMotionToKeyframesTool,
  manageAnimationPreset,
  setAutoKeyframe,
  manageEasingPreset,
  inspectLottie,
  searchLottieCatalog,
  importLottieCatalogItem,
] as const
