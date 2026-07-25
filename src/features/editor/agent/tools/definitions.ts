/**
 * The editor tool catalog. Each tool validates with Zod (runtime) and carries a
 * hand-authored JSON Schema (`inputSchema`) for the prompt catalog + MCP. Tools
 * are clip-addressable: a `clips` arg takes refs ("c1", "c3") from the grounded
 * inventory, falling back to the current selection when omitted.
 */

import { z } from 'zod'
import {
  executeTimelineCommand,
  rateStretchItemWithoutHistory,
  useItemsStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-store'
import {
  createTextTemplateItem,
  findCompatibleTrackForItemType,
  findNearestAvailableSpace,
  getDefaultGeneratedLayerDurationInFrames,
  sourceToTimelineFrames,
  timelineToSourceFrames,
} from '@/features/editor/deps/timeline-utils'
import {
  useFillerRemovalDialogStore,
} from '@/features/editor/deps/timeline-ui'
import {
  analyzeSilenceForItems,
  normalizeSilenceRemovalSettings,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { searchTimelineTranscript } from '@/features/editor/deps/timeline-utils'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import type { TextItem, TimelineItem } from '@/types/timeline'
import type { EditorAgentTool, JsonSchema, ToolResult, ToolValidation } from './types'
import { buildClipRefs, resolveClipRefs, resolveItemRef, resolveTargetItems } from './clip-refs'
import { importLocalMediaToTimeline } from './local-media-import'
import { generateTimelineCaptions } from './generate-captions'

// --- factory ----------------------------------------------------------------

function makeValidate<S extends z.ZodType>(schema: S): (args: unknown) => ToolValidation {
  return (args) => {
    const result = schema.safeParse(args ?? {})
    if (result.success) return { ok: true, value: result.data as Record<string, unknown> }
    const issue = result.error.issues[0]
    const path = issue?.path.join('.') || 'args'
    return { ok: false, error: `${path}: ${issue?.message ?? 'invalid'}` }
  }
}

function defineTool<S extends z.ZodType>(def: {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  readOnly?: boolean
  destructive?: boolean
  handoff?: boolean
  requiresProject?: boolean
  schema: S
  summarize: (args: z.infer<S>) => string
  execute: (args: z.infer<S>) => Promise<ToolResult> | ToolResult
}): EditorAgentTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
    handoff: def.handoff ?? false,
    requiresProject: def.requiresProject ?? true,
    validate: makeValidate(def.schema),
    summarize: (args) => def.summarize(args as z.infer<S>),
    execute: (args) => def.execute(args as z.infer<S>),
  }
}

// --- shared schema fragments ------------------------------------------------

const CLIPS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Clip refs like ["c1","c3"] from the timeline list. Omit to use the current selection.',
}

function objSchema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const clipsField = z.array(z.string()).optional()

function getFps(): number {
  return useTimelineStore.getState().fps
}

function isMedia(item: TimelineItem): boolean {
  return item.type === 'video' || item.type === 'audio'
}

function isAnimatedImage(item: TimelineItem): boolean {
  if (item.type !== 'image') return false
  const label = item.label?.toLowerCase() ?? ''
  return label.endsWith('.gif') || label.endsWith('.webp')
}

// --- query tools ------------------------------------------------------------

const findClips = defineTool({
  name: 'find_clips',
  title: 'Find clips',
  description:
    'List clips on the timeline, optionally filtered by type or a label substring. Returns their refs so other tools can target them.',
  inputSchema: objSchema({
    query: {
      type: 'string',
      description: 'Case-insensitive substring to match against clip labels.',
    },
    type: {
      type: 'string',
      enum: ['video', 'audio', 'text', 'image', 'shape'],
      description: 'Restrict to one clip type.',
    },
  }),
  readOnly: true,
  schema: z.object({
    query: z.string().optional(),
    type: z.enum(['video', 'audio', 'text', 'image', 'shape']).optional(),
  }),
  summarize: (args) => `Find clips${args.type ? ` of type ${args.type}` : ''}`,
  execute: (args) => {
    const query = args.query?.toLowerCase()
    const matches = buildClipRefs().filter((clip) => {
      if (args.type && clip.type !== args.type) return false
      if (query && !clip.label.toLowerCase().includes(query)) return false
      return true
    })
    const summary =
      matches.map((clip) => `${clip.ref} ${clip.type} "${clip.label}"`).join('; ') ||
      'no matching clips'
    return { ok: true, message: `Found ${matches.length}: ${summary}`, data: matches }
  },
})

const searchTranscript = defineTool({
  name: 'search_transcript',
  title: 'Search spoken words',
  description:
    'Search what is SAID in the video/audio for a word or phrase. Returns matching clip refs and timecodes. Use this FIRST to locate content the user describes (e.g. "where I talk about pricing") before editing around it.',
  inputSchema: objSchema(
    { query: { type: 'string', description: 'A word or phrase spoken in the media.' } },
    ['query'],
  ),
  readOnly: true,
  schema: z.object({ query: z.string().min(1) }),
  summarize: (args) => `Search transcript for "${args.query}"`,
  execute: async (args) => {
    const matches = await searchTimelineTranscript(args.query)
    // Refresh ref maps so itemIds resolve to the refs the model already saw.
    buildClipRefs()
    if (matches.length === 0) {
      return { ok: true, message: `No spoken match for "${args.query}".`, data: [] }
    }
    const lines = matches.map((match) => {
      const ref = resolveItemRef(match.itemId) ?? '?'
      return `${ref} @${match.timelineSeconds.toFixed(1)}s "${match.snippet}"`
    })
    return { ok: true, message: `Found "${args.query}" in: ${lines.join('; ')}`, data: matches }
  },
})

const selectClips = defineTool({
  name: 'select_clips',
  title: 'Select clips',
  description: 'Select the given clips so later actions and the UI focus on them.',
  inputSchema: objSchema({ clips: CLIPS_PROP }, ['clips']),
  schema: z.object({ clips: z.array(z.string()).min(1) }),
  summarize: (args) => `Select ${args.clips.join(', ')}`,
  execute: (args) => {
    const ids = resolveClipRefs(args.clips)
    if (ids.length === 0) throw new Error('None of those clip refs exist.')
    useSelectionStore.getState().selectItems(ids)
    return { ok: true, message: `Selected ${ids.length} clip${ids.length === 1 ? '' : 's'}.` }
  },
})

const seekTo = defineTool({
  name: 'seek_to',
  title: 'Move playhead',
  description: 'Move the playhead to a time in seconds.',
  inputSchema: objSchema({ seconds: { type: 'number', minimum: 0 } }, ['seconds']),
  schema: z.object({ seconds: z.number().min(0) }),
  summarize: (args) => `Seek to ${args.seconds.toFixed(1)}s`,
  execute: (args) => {
    usePlaybackStore.getState().setCurrentFrame(Math.round(args.seconds * getFps()))
    return { ok: true, message: `Moved playhead to ${args.seconds.toFixed(1)}s.` }
  },
})

// --- creation tools ---------------------------------------------------------

const addTitle = defineTool({
  name: 'add_title',
  title: 'Add title',
  description: 'Add a text/title layer at the playhead (or at a given time).',
  inputSchema: objSchema(
    {
      text: { type: 'string', description: 'Title text.' },
      atSeconds: {
        type: 'number',
        minimum: 0,
        description: 'Start time; defaults to the playhead.',
      },
    },
    ['text'],
  ),
  schema: z.object({ text: z.string().min(1).max(300), atSeconds: z.number().min(0).optional() }),
  summarize: (args) => `Add title: "${args.text.slice(0, 40)}"`,
  execute: (args) => {
    const { tracks, items, fps, addItem } = useTimelineStore.getState()
    const { activeTrackId, selectItems } = useSelectionStore.getState()
    const currentProject = useProjectStore.getState().currentProject

    const targetTrack = findCompatibleTrackForItemType({
      tracks,
      items,
      itemType: 'text',
      preferredTrackId: activeTrackId,
    })
    if (!targetTrack) throw new Error('No available track for a text layer.')

    const durationInFrames = getDefaultGeneratedLayerDurationInFrames(fps)
    const proposed =
      args.atSeconds !== undefined
        ? Math.round(args.atSeconds * fps)
        : usePlaybackStore.getState().currentFrame
    const from =
      findNearestAvailableSpace(proposed, durationInFrames, targetTrack.id, items) ?? proposed

    const textItem: TextItem = createTextTemplateItem({
      placement: {
        trackId: targetTrack.id,
        from,
        durationInFrames,
        canvasWidth: currentProject?.metadata.width ?? DEFAULT_PROJECT_WIDTH,
        canvasHeight: currentProject?.metadata.height ?? DEFAULT_PROJECT_HEIGHT,
        fps,
      },
      text: args.text,
    })

    addItem(textItem)
    if (useTimelineStore.getState().items.some((item) => item.id === textItem.id)) {
      selectItems([textItem.id])
    }
    return { ok: true, message: `Added a title "${args.text.slice(0, 40)}".` }
  },
})

const importLocalMedia = defineTool({
  name: 'import_local_media',
  title: 'Import local media',
  description:
    'Import a local file or directory, optionally including nested folders, then place supported media sequentially on the timeline. Available in the desktop or local development build.',
  inputSchema: objSchema(
    {
      path: {
        type: 'string',
        description: 'Absolute local file or directory path.',
      },
      atSeconds: {
        type: 'number',
        minimum: 0,
        description: 'Start time; defaults to the playhead.',
      },
      recursive: {
        type: 'boolean',
        description: 'Include files in nested folders. Defaults to false.',
      },
    },
    ['path'],
  ),
  schema: z.object({
    path: z.string().min(1),
    atSeconds: z.number().min(0).optional(),
    recursive: z.boolean().optional(),
  }),
  summarize: (args) => `Import local media from "${args.path}"`,
  execute: async (args) => {
    const result = await importLocalMediaToTimeline(
      args.path,
      args.atSeconds,
      args.recursive ?? false,
    )
    return {
      ok: true,
      message: `Imported ${result.importedCount} media file${result.importedCount === 1 ? '' : 's'} and placed ${result.placedCount} timeline item${result.placedCount === 1 ? '' : 's'}.`,
      data: { ...result, recursive: args.recursive ?? false },
      changed: result.importedCount > 0 || result.placedCount > 0,
    }
  },
})

const generateCaptions = defineTool({
  name: 'generate_captions',
  title: 'Generate synchronized captions',
  description:
    'Transcribe speech with the configured cloud ASR and create synchronized subtitle items on a captions track. Omit clips to process every video/audio media source on the timeline. Linked video/audio is transcribed once.',
  inputSchema: objSchema({
    clips: {
      ...CLIPS_PROP,
      description:
        'Timeline clip refs to caption. Omit to process all video/audio media sources on the timeline.',
    },
    replaceExisting: {
      type: 'boolean',
      description: 'Replace existing generated transcript captions. Defaults to true.',
    },
  }),
  schema: z.object({
    clips: clipsField,
    replaceExisting: z.boolean().optional(),
  }),
  summarize: (args) =>
    args.clips?.length
      ? `Generate synchronized captions for ${args.clips.join(', ')}`
      : 'Generate synchronized captions for all timeline media',
  execute: async (args) => {
    const result = await generateTimelineCaptions(args)
    const successCount = result.mediaCount - result.failed.length
    const summary = `Generated captions for ${successCount}/${result.mediaCount} media source${result.mediaCount === 1 ? '' : 's'} as ${result.insertedCaptionCount} subtitle track item${result.insertedCaptionCount === 1 ? '' : 's'}.`
    if (result.failed.length === 0) {
      return {
        ok: true,
        message: summary,
        data: result,
        changed: result.insertedCaptionCount > 0,
      }
    }
    const failureMessages = [...new Set(result.failed.map((entry) => entry.message))]
    return {
      ok: false,
      message: `${summary} Failed: ${failureMessages.join('; ')}`,
      data: result,
      changed: result.insertedCaptionCount > 0,
    }
  },
})

// --- edit tools -------------------------------------------------------------

const split = defineTool({
  name: 'split',
  title: 'Split clips',
  description:
    'Split clips at a time (default playhead). Targets the given clips, else the selection, else all clips crossing that time.',
  inputSchema: objSchema({
    clips: CLIPS_PROP,
    atSeconds: { type: 'number', minimum: 0, description: 'Split time; defaults to the playhead.' },
  }),
  schema: z.object({ clips: clipsField, atSeconds: z.number().min(0).optional() }),
  summarize: (args) =>
    `Split at ${args.atSeconds !== undefined ? `${args.atSeconds.toFixed(1)}s` : 'the playhead'}`,
  execute: (args) => {
    const { items, splitItem } = useTimelineStore.getState()
    const frame =
      args.atSeconds !== undefined
        ? Math.round(args.atSeconds * getFps())
        : usePlaybackStore.getState().currentFrame

    const targeted = resolveTargetItems(args.clips)
    const pool = targeted.length > 0 ? targeted : items
    const crossing = pool.filter(
      (item) => frame > item.from && frame < item.from + item.durationInFrames,
    )
    if (crossing.length === 0) throw new Error('No clips cross that time to split.')

    const splitItemIds: string[] = []
    for (const item of crossing) {
      if (splitItem(item.id, frame)) splitItemIds.push(item.id)
    }
    if (splitItemIds.length === 0) {
      throw new Error('The requested clips could not be split at that time.')
    }

    return {
      ok: true,
      message: `Split ${splitItemIds.length} clip${splitItemIds.length === 1 ? '' : 's'}.`,
      data: { itemIds: splitItemIds, frame },
      changed: true,
    }
  },
})

const deleteClips = defineTool({
  name: 'delete_clips',
  title: 'Delete clips',
  description: 'Ripple-delete the given clips, closing the gaps so later clips shift back.',
  inputSchema: objSchema({ clips: CLIPS_PROP }, ['clips']),
  destructive: true,
  schema: z.object({ clips: z.array(z.string()).min(1) }),
  summarize: (args) => `Delete ${args.clips.join(', ')}`,
  execute: (args) => {
    const items = resolveTargetItems(args.clips)
    if (items.length === 0) throw new Error('None of those clip refs exist.')
    const itemIds = items.map((item) => item.id)
    useTimelineStore.getState().rippleDeleteItems(itemIds)
    return {
      ok: true,
      message: `Deleted ${items.length} clip${items.length === 1 ? '' : 's'}.`,
      data: { itemIds, ripple: true },
      changed: true,
    }
  },
})

const setSpeed = defineTool({
  name: 'set_speed',
  title: 'Set speed',
  description:
    'Change playback speed of video, audio, GIF, or animated WebP clips. 1 = normal, 2 = double, 0.5 = half.',
  inputSchema: objSchema(
    {
      clips: CLIPS_PROP,
      speed: { type: 'number', minimum: 0.1, maximum: 10 },
      preserveDuration: {
        type: 'boolean',
        description:
          'Keep each clip duration unchanged. Defaults to true for animated images and false for video/audio, matching the editor UI.',
      },
    },
    ['speed'],
  ),
  schema: z.object({
    clips: clipsField,
    speed: z.number().min(0.1).max(10),
    preserveDuration: z.boolean().optional(),
  }),
  summarize: (args) => `Set speed to ${args.speed}x`,
  execute: (args) => {
    const items = resolveTargetItems(args.clips).filter(
      (item) => isMedia(item) || isAnimatedImage(item),
    )
    if (items.length === 0) {
      throw new Error('Select or name one or more video, audio, or animated image clips.')
    }
    const beforeById = new Map(
      items.map((item) => [
        item.id,
        {
          from: item.from,
          durationInFrames: item.durationInFrames,
          speed: item.speed ?? 1,
          sourceEnd: item.sourceEnd,
        },
      ]),
    )
    const fps = getFps()

    executeTimelineCommand(
      'RATE_STRETCH_ITEM',
      () => {
        for (const target of items) {
          const item = useItemsStore.getState().itemById[target.id]
          if (!item) continue

          const preserveDuration = args.preserveDuration ?? item.type === 'image'
          const currentSpeed = item.speed ?? 1
          const sourceFps = item.sourceFps ?? fps
          const effectiveSourceFrames =
            item.type !== 'image' && item.sourceEnd !== undefined && item.sourceStart !== undefined
              ? item.sourceEnd - item.sourceStart
              : timelineToSourceFrames(item.durationInFrames, currentSpeed, fps, sourceFps)
          const newDuration = preserveDuration
            ? item.durationInFrames
            : Math.max(1, sourceToTimelineFrames(effectiveSourceFrames, args.speed, sourceFps, fps))

          if (
            Math.abs(currentSpeed - args.speed) <= Number.EPSILON &&
            newDuration === item.durationInFrames
          ) {
            continue
          }

          rateStretchItemWithoutHistory(item.id, item.from, newDuration, args.speed)

          const updated = useItemsStore.getState().itemById[item.id]
          if (
            updated &&
            (item.type === 'image' || preserveDuration) &&
            (Math.abs((updated.speed ?? 1) - args.speed) > Number.EPSILON ||
              updated.durationInFrames !== newDuration)
          ) {
            const sourceStart = item.sourceStart ?? 0
            const requestedSourceEnd =
              sourceStart + timelineToSourceFrames(newDuration, args.speed, fps, sourceFps)
            useItemsStore.getState()._updateItem(item.id, {
              durationInFrames: newDuration,
              speed: args.speed,
              sourceEnd: Math.round(
                item.sourceDuration
                  ? Math.min(requestedSourceEnd, item.sourceDuration)
                  : requestedSourceEnd,
              ),
            })
          }
        }
      },
      {
        ids: items.map((item) => item.id),
        newSpeed: args.speed,
        preserveDuration: args.preserveDuration,
      },
    )

    const afterById = useItemsStore.getState().itemById
    const changedIds = items
      .filter((item) => {
        const before = beforeById.get(item.id)
        const after = afterById[item.id]
        return (
          !!before &&
          !!after &&
          (before.from !== after.from ||
            before.durationInFrames !== after.durationInFrames ||
            before.speed !== (after.speed ?? 1) ||
            before.sourceEnd !== after.sourceEnd)
        )
      })
      .map((item) => item.id)

    return {
      ok: true,
      message:
        changedIds.length > 0
          ? `Set ${changedIds.length} clip${changedIds.length === 1 ? '' : 's'} to ${args.speed}x.`
          : `The selected clips were already at ${args.speed}x.`,
      data: { itemIds: changedIds, speed: args.speed },
      changed: changedIds.length > 0,
    }
  },
})

const setVolume = defineTool({
  name: 'set_volume',
  title: 'Set volume',
  description:
    'Set the linear volume of video/audio clips (0 = mute, 1 = unity). The editor stores the converted value in dB.',
  inputSchema: objSchema(
    { clips: CLIPS_PROP, volume: { type: 'number', minimum: 0, maximum: 1 } },
    ['volume'],
  ),
  schema: z.object({ clips: clipsField, volume: z.number().min(0).max(1) }),
  summarize: (args) => `Set volume to ${Math.round(args.volume * 100)}%`,
  execute: (args) => {
    const media = resolveTargetItems(args.clips).filter(isMedia)
    if (media.length === 0) throw new Error('Select or name one or more video/audio clips.')
    const volumeDb = args.volume <= 0 ? -60 : Math.max(-60, 20 * Math.log10(args.volume))
    const changedItems = media.filter(
      (item) => Math.abs((item.volume ?? 0) - volumeDb) > Number.EPSILON,
    )
    if (changedItems.length > 0) {
      executeTimelineCommand(
        'AGENT_SET_VOLUME',
        () => {
          const store = useItemsStore.getState()
          for (const item of changedItems) store._updateItem(item.id, { volume: volumeDb })
          useTimelineSettingsStore.getState().markDirty()
        },
        { itemIds: changedItems.map((item) => item.id), volumeDb },
      )
    }
    return {
      ok: true,
      message:
        changedItems.length > 0
          ? `Set ${changedItems.length} clip${changedItems.length === 1 ? '' : 's'} to ${Math.round(args.volume * 100)}% volume.`
          : `The selected clips were already at ${Math.round(args.volume * 100)}% volume.`,
      data: { itemIds: changedItems.map((item) => item.id), volumeDb },
      changed: changedItems.length > 0,
    }
  },
})

const trimClip = defineTool({
  name: 'trim_clip',
  title: 'Trim clip',
  description: 'Trim seconds off the start or end of a single clip.',
  inputSchema: objSchema(
    {
      clip: { type: 'string', description: 'A single clip ref, e.g. "c2".' },
      side: { type: 'string', enum: ['start', 'end'] },
      seconds: { type: 'number', minimum: 0 },
    },
    ['clip', 'side', 'seconds'],
  ),
  schema: z.object({
    clip: z.string(),
    side: z.enum(['start', 'end']),
    seconds: z.number().min(0),
  }),
  summarize: (args) => `Trim ${args.seconds.toFixed(1)}s off the ${args.side} of ${args.clip}`,
  execute: (args) => {
    const [item] = resolveTargetItems([args.clip])
    if (!item) throw new Error(`Clip ${args.clip} does not exist.`)
    const frames = Math.round(args.seconds * getFps())
    if (frames <= 0) throw new Error('Trim amount must be greater than zero.')
    const { trimItemStart, trimItemEnd } = useTimelineStore.getState()
    if (args.side === 'start') trimItemStart(item.id, frames)
    else trimItemEnd(item.id, frames)
    return {
      ok: true,
      message: `Trimmed ${args.seconds.toFixed(1)}s off the ${args.side} of ${args.clip}.`,
      data: { itemId: item.id, side: args.side, frames },
      changed: true,
    }
  },
})

const TRANSITION_TYPES = ['fade', 'dissolve', 'wipe', 'slide', 'flip', 'iris', 'pixelate'] as const

const addTransition = defineTool({
  name: 'add_transition',
  title: 'Add transition',
  description: 'Add a transition between exactly two adjacent clips on the same track.',
  inputSchema: objSchema({
    clips: {
      ...CLIPS_PROP,
      description: 'Exactly two adjacent clip refs. Omit to use the current selection.',
    },
    type: { type: 'string', enum: [...TRANSITION_TYPES] },
    durationSeconds: { type: 'number', minimum: 0.1, maximum: 5 },
  }),
  schema: z.object({
    clips: clipsField,
    type: z.enum(TRANSITION_TYPES).optional(),
    durationSeconds: z.number().min(0.1).max(5).optional(),
  }),
  summarize: (args) => `Add ${args.type ?? 'default'} transition`,
  execute: (args) => {
    const targets = resolveTargetItems(args.clips)
    if (targets.length !== 2) throw new Error('Name exactly two adjacent clips for a transition.')
    const [a, b] = targets as [TimelineItem, TimelineItem]
    if (a.trackId !== b.trackId) throw new Error('Both clips must be on the same track.')
    const [left, right] = a.from <= b.from ? [a, b] : [b, a]

    const { addTransition: add, fps } = useTimelineStore.getState()
    const durationInFrames = args.durationSeconds
      ? Math.max(1, Math.round(args.durationSeconds * fps))
      : undefined
    const ok = add(left.id, right.id, 'crossfade', durationInFrames, args.type)
    if (!ok) throw new Error('Could not add a transition between those clips.')
    return {
      ok: true,
      message: `Added a ${args.type ?? 'default'} transition.`,
      data: { leftClipId: left.id, rightClipId: right.id, presentation: args.type ?? 'fade' },
      changed: true,
    }
  },
})

// --- review hand-offs -------------------------------------------------------

function cleanupTargetIds(clips: string[] | undefined): string[] {
  const targeted = resolveTargetItems(clips).filter(isMedia)
  if (targeted.length > 0) return targeted.map((item) => item.id)
  return useTimelineStore
    .getState()
    .items.filter(isMedia)
    .map((item) => item.id)
}

const removeSilence = defineTool({
  name: 'remove_silence',
  title: 'Remove silences',
  description:
    'Analyze the given clips (or all) for signal- or transcript-based silence and remove the detected ranges in one undoable timeline command.',
  inputSchema: objSchema({
    clips: CLIPS_PROP,
    mode: { type: 'string', enum: ['signal', 'speech'] },
    autoThresholds: { type: 'boolean' },
    thresholdDb: { type: 'number', minimum: -100, maximum: 0 },
    audioThresholdDb: { type: 'number', minimum: -100, maximum: 0 },
    minSilenceMs: { type: 'number', minimum: 0 },
    minAudioMs: { type: 'number', minimum: 0 },
    paddingStartMs: { type: 'number', minimum: 0 },
    paddingEndMs: { type: 'number', minimum: 0 },
    smoothingMs: { type: 'number', minimum: 0 },
    windowMs: { type: 'number', minimum: 1 },
  }),
  destructive: true,
  schema: z.object({
    clips: clipsField,
    mode: z.enum(['signal', 'speech']).optional(),
    autoThresholds: z.boolean().optional(),
    thresholdDb: z.number().min(-100).max(0).optional(),
    audioThresholdDb: z.number().min(-100).max(0).optional(),
    minSilenceMs: z.number().min(0).optional(),
    minAudioMs: z.number().min(0).optional(),
    paddingStartMs: z.number().min(0).optional(),
    paddingEndMs: z.number().min(0).optional(),
    smoothingMs: z.number().min(0).optional(),
    windowMs: z.number().min(1).optional(),
  }),
  summarize: () => 'Analyze and remove silences',
  execute: async ({ clips, ...settingsPatch }) => {
    const itemIds = cleanupTargetIds(clips)
    if (itemIds.length === 0) throw new Error('There are no video or audio clips to analyze.')
    const settings = normalizeSilenceRemovalSettings(settingsPatch)
    const analysis = await analyzeSilenceForItems(itemIds, settings)
    const result = useTimelineStore
      .getState()
      .removeSilenceFromItems(itemIds, analysis.rangesByMediaId)
    const changed = result.removedItemCount > 0
    return {
      ok: true,
      message: changed
        ? `Removed ${result.removedRangeCount} silent range${result.removedRangeCount === 1 ? '' : 's'} from ${result.analyzedItemCount} clip${result.analyzedItemCount === 1 ? '' : 's'}.`
        : 'No removable silence was found in the requested clips.',
      data: {
        ...result,
        analyzedMediaIds: analysis.analyzedMediaIds,
        failedMediaIds: analysis.failedMediaIds,
        settings,
      },
      changed,
      warnings: analysis.failedMediaIds.map((mediaId) => ({
        code: 'SILENCE_ANALYSIS_FAILED',
        message: `Silence analysis failed for media ${mediaId}.`,
      })),
    }
  },
})

const removeFillers = defineTool({
  name: 'remove_fillers',
  title: 'Remove filler words',
  description:
    'Open the filler-word review (um, uh, like…) for the given clips (or all). The user previews and confirms.',
  inputSchema: objSchema({ clips: CLIPS_PROP }),
  handoff: true,
  schema: z.object({ clips: clipsField }),
  summarize: () => 'Review and remove filler words',
  execute: (args) => {
    const itemIds = cleanupTargetIds(args.clips)
    if (itemIds.length === 0) throw new Error('There are no video or audio clips to analyze.')
    useFillerRemovalDialogStore.getState().open({ itemIds })
    return { ok: true, message: 'Opened the filler-word review.' }
  },
})

export const EDITOR_TOOLS: readonly EditorAgentTool[] = [
  findClips,
  searchTranscript,
  selectClips,
  seekTo,
  addTitle,
  importLocalMedia,
  generateCaptions,
  split,
  deleteClips,
  setSpeed,
  setVolume,
  trimClip,
  addTransition,
  removeSilence,
  removeFillers,
]
