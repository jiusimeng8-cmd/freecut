import { z } from 'zod'
import {
  getProject,
  getProjectMediaIds,
  useProjectStore,
} from '@/features/editor/deps/projects'
import {
  importMediaLibraryService,
  mediaTranscriptionService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import {
  detectOverlappingItems,
  getCompoundClipDeletionImpact,
  listExportableSequences,
  useCompositionNavigationStore,
  useCompositionsStore,
  useSequencesStore,
  useTimelineCommandStore,
} from '@/features/editor/deps/timeline-contract'
import {
  getGpuCategoriesWithEffects,
  type EffectParam,
} from '@/features/editor/deps/effects-contract'
import type { MediaMetadata } from '@/types/storage'
import type { SubtitleSegmentItem, TextItem, TimelineItem } from '@/types/timeline'
import {
  buildItemRefMap,
  definePlatformTool,
  getToolTimelineSnapshot,
  objectSchema,
  sanitizeTimelineItem,
} from './shared'

function mediaSummary(
  media: MediaMetadata,
  transcriptStatus: string | undefined,
  brokenInfo: { errorType: string } | undefined,
  healthKnown: boolean,
) {
  return {
    id: media.id,
    fileName: media.fileName,
    fileSize: media.fileSize,
    mimeType: media.mimeType,
    duration: media.duration,
    width: media.width,
    height: media.height,
    fps: media.fps,
    codec: media.codec,
    audioCodec: media.audioCodec,
    storageType: media.storageType,
    transcriptStatus,
    broken: healthKnown ? !!brokenInfo : null,
    brokenReason: brokenInfo?.errorType,
  }
}

const readProject = definePlatformTool({
  name: 'read_project',
  title: 'Read project',
  description:
    'Read the persisted FreeCut project metadata and high-level timeline counts without changing the open editor.',
  inputSchema: objectSchema({
    projectId: {
      type: 'string',
      description: 'Project id. Defaults to the currently open project.',
    },
  }),
  readOnly: true,
  schema: z.object({ projectId: z.string().min(1).optional() }),
  summarize: () => 'Read project metadata',
  execute: async ({ projectId }) => {
    const id = projectId ?? useProjectStore.getState().currentProject?.id
    if (!id) throw new Error('No project is currently open.')
    const project = await getProject(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    const timeline = project.timeline
    const mediaIds = await getProjectMediaIds(id)
    const data = {
      id: project.id,
      name: project.name,
      description: project.description,
      metadata: project.metadata,
      schemaVersion: project.schemaVersion,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      duration: project.duration,
      mediaIds,
      timeline: {
        trackCount: timeline?.tracks?.length ?? 0,
        itemCount: timeline?.items?.length ?? 0,
        transitionCount: timeline?.transitions?.length ?? 0,
        markerCount: timeline?.markers?.length ?? 0,
        keyframeItemCount: timeline?.keyframes?.length ?? 0,
        sequenceCount: timeline?.topLevelSequenceIds?.length ?? 0,
        compositionCount: timeline?.compositions?.length ?? 0,
      },
    }
    return {
      ok: true,
      message: `Read project "${project.name}" (${data.timeline.itemCount} timeline items).`,
      data,
    }
  },
})

const readTimeline = definePlatformTool({
  name: 'read_timeline',
  title: 'Read timeline',
  description:
    'Read tracks, items, transitions, markers, keyframes, locks, and timing for the active timeline, Main timeline, or a named sequence.',
  inputSchema: objectSchema({
    scope: { type: 'string', enum: ['active', 'main', 'sequence'] },
    sequenceId: { type: 'string' },
    detail: { type: 'string', enum: ['summary', 'full'] },
  }),
  readOnly: true,
  schema: z.object({
    scope: z.enum(['active', 'main', 'sequence']).optional(),
    sequenceId: z.string().min(1).optional(),
    detail: z.enum(['summary', 'full']).optional(),
  }),
  summarize: ({ scope }) => `Read ${scope ?? 'active'} timeline`,
  execute: ({ scope = 'active', sequenceId, detail = 'summary' }) => {
    const timeline = getToolTimelineSnapshot({ scope, sequenceId })
    const refs = buildItemRefMap(timeline.items)
    const summarizedItems = timeline.items.map((item) => ({
      ref: refs.get(item.id),
      id: item.id,
      type: item.type,
      label: item.label,
      trackId: item.trackId,
      from: item.from,
      durationInFrames: item.durationInFrames,
      endFrame: item.from + item.durationInFrames,
      linkedGroupId: item.linkedGroupId,
      mediaId: item.mediaId,
    }))
    const data = {
      scope: timeline.scope,
      sequenceId: timeline.id,
      name: timeline.name,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      durationFrames: timeline.durationFrames,
      inPoint: timeline.inPoint,
      outPoint: timeline.outPoint,
      tracks: timeline.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        kind: track.kind,
        order: track.order,
        locked: track.locked,
        syncLock: track.syncLock,
        visible: track.visible,
        muted: track.muted,
        solo: track.solo,
        volume: track.volume,
        isGroup: track.isGroup,
        parentTrackId: track.parentTrackId,
        isCollapsed: track.isCollapsed,
        itemIds: summarizedItems
          .filter((item) => item.trackId === track.id)
          .map((item) => item.id),
      })),
      items:
        detail === 'full'
          ? timeline.items.map((item) => ({
              ref: refs.get(item.id),
              ...sanitizeTimelineItem(item),
            }))
          : summarizedItems,
      transitions: timeline.transitions,
      markers: timeline.markers,
      keyframes: detail === 'full' ? timeline.keyframes : undefined,
    }
    return {
      ok: true,
      message: `Read ${timeline.name}: ${timeline.tracks.length} tracks, ${timeline.items.length} items.`,
      data,
    }
  },
})

const readMedia = definePlatformTool({
  name: 'read_media',
  title: 'Read media library',
  description:
    'Read project media metadata, transcript availability, and broken-media state without returning local file handles.',
  inputSchema: objectSchema({
    projectId: { type: 'string' },
    mediaIds: { type: 'array', items: { type: 'string' } },
  }),
  readOnly: true,
  schema: z.object({
    projectId: z.string().min(1).optional(),
    mediaIds: z.array(z.string()).optional(),
  }),
  summarize: () => 'Read project media',
  execute: async ({ projectId, mediaIds }) => {
    const id = projectId ?? useProjectStore.getState().currentProject?.id
    if (!id) throw new Error('No project is currently open.')
    const store = useMediaLibraryStore.getState()
    let media =
      store.currentProjectId === id && store.mediaItems.length > 0 ? store.mediaItems : null
    if (!media) {
      const { mediaLibraryService } = await importMediaLibraryService()
      media = await mediaLibraryService.getMediaForProject(id)
    }
    const requested = mediaIds?.length ? new Set(mediaIds) : null
    const selected = requested ? media.filter((entry) => requested.has(entry.id)) : media
    const healthKnown = store.currentProjectId === id
    const data = selected.map((entry) =>
      mediaSummary(
        entry,
        store.transcriptStatus.get(entry.id) ?? 'unknown',
        healthKnown ? store.brokenMediaInfo.get(entry.id) : undefined,
        healthKnown,
      ),
    )
    return {
      ok: true,
      message: `Read ${data.length} media item${data.length === 1 ? '' : 's'}.`,
      data,
    }
  },
})

const readTranscript = definePlatformTool({
  name: 'read_transcript',
  title: 'Read transcript',
  description: 'Read the stored cloud-ASR transcript for one media item.',
  inputSchema: objectSchema(
    { mediaId: { type: 'string', description: 'Media library id.' } },
    ['mediaId'],
  ),
  readOnly: true,
  schema: z.object({ mediaId: z.string().min(1) }),
  summarize: ({ mediaId }) => `Read transcript ${mediaId}`,
  execute: async ({ mediaId }) => {
    const transcript = await mediaTranscriptionService.getTranscript(mediaId)
    if (!transcript) {
      return {
        ok: false,
        message: `No transcript exists for media ${mediaId}.`,
        error: {
          code: 'TRANSCRIPT_NOT_FOUND',
          message: `No transcript exists for media ${mediaId}.`,
        },
      }
    }
    return {
      ok: true,
      message: `Read transcript with ${transcript.segments.length} segments.`,
      data: transcript,
    }
  },
})

function isCaptionText(item: TimelineItem): item is TextItem {
  return item.type === 'text' && (item.textRole === 'caption' || !!item.captionSource)
}

const readSubtitles = definePlatformTool({
  name: 'read_subtitles',
  title: 'Read subtitles',
  description:
    'Read editable subtitle items and legacy caption text layers from the active, Main, or named sequence timeline.',
  inputSchema: objectSchema({
    scope: { type: 'string', enum: ['active', 'main', 'sequence'] },
    sequenceId: { type: 'string' },
  }),
  readOnly: true,
  schema: z.object({
    scope: z.enum(['active', 'main', 'sequence']).optional(),
    sequenceId: z.string().min(1).optional(),
  }),
  summarize: () => 'Read timeline subtitles',
  execute: ({ scope = 'active', sequenceId }) => {
    const timeline = getToolTimelineSnapshot({ scope, sequenceId })
    const subtitles: Array<Record<string, unknown>> = []
    for (const item of timeline.items) {
      if (item.type === 'subtitle') {
        const subtitle = item as SubtitleSegmentItem
        subtitles.push({
          id: subtitle.id,
          trackId: subtitle.trackId,
          from: subtitle.from,
          durationInFrames: subtitle.durationInFrames,
          linkedGroupId: subtitle.linkedGroupId,
          source: subtitle.source,
          cues: subtitle.cues,
          style: sanitizeTimelineItem(subtitle),
        })
        continue
      }
      if (isCaptionText(item)) {
        subtitles.push({
          id: item.id,
          trackId: item.trackId,
          from: item.from,
          durationInFrames: item.durationInFrames,
          linkedGroupId: item.linkedGroupId,
          source: item.captionSource,
          text: item.text,
          style: sanitizeTimelineItem(item),
        })
        continue
      }
      if (
        (item.type === 'video' || item.type === 'audio') &&
        item.transcriptCaptions
      ) {
        subtitles.push({
          id: item.id,
          trackId: item.trackId,
          from: item.from,
          durationInFrames: item.durationInFrames,
          linkedGroupId: item.linkedGroupId,
          source: {
            type: 'transcript',
            mediaId: item.transcriptCaptions.mediaId,
          },
          enabled: item.transcriptCaptions.enabled,
          cues: item.transcriptCaptions.cues,
          style: item.transcriptCaptions.style,
          timeBasis: 'source-relative',
        })
      }
    }
    return {
      ok: true,
      message: `Read ${subtitles.length} subtitle item${subtitles.length === 1 ? '' : 's'}.`,
      data: { sequenceId: timeline.id, fps: timeline.fps, subtitles },
    }
  },
})

const readHistory = definePlatformTool({
  name: 'read_history',
  title: 'Read undo history',
  description: 'Read undo/redo availability and labels for the current timeline context.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read undo history',
  execute: () => {
    const history = useTimelineCommandStore.getState()
    const data = {
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoCount: history.undoStack.length,
      redoCount: history.redoStack.length,
      undoLabel: history.getUndoLabel(),
      redoLabel: history.getRedoLabel(),
      context: history.activeContextKey,
    }
    return { ok: true, message: 'Read timeline history.', data }
  },
})

const listSequences = definePlatformTool({
  name: 'list_sequences',
  title: 'List sequences',
  description: 'List the Main timeline and every top-level FreeCut sequence.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'List project sequences',
  execute: () => {
    const sequences = listExportableSequences()
    return {
      ok: true,
      message: `Found ${sequences.length} timeline${sequences.length === 1 ? '' : 's'}.`,
      data: sequences,
    }
  },
})

const listCompositions = definePlatformTool({
  name: 'list_compositions',
  title: 'List compositions',
  description:
    'List every nested composition and top-level sequence with dimensions, duration, nesting, and reference counts.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'List project compositions',
  execute: () => {
    const compositions = useCompositionsStore.getState().compositions
    const sequences = useSequencesStore.getState()
    const activeCompositionId = useCompositionNavigationStore.getState().activeCompositionId
    const data = compositions.map((composition) => {
      const impact = getCompoundClipDeletionImpact([composition.id])
      return {
        id: composition.id,
        name: composition.name,
        isTopLevel: sequences.isTopLevelSequence(composition.id),
        isActive: activeCompositionId === composition.id,
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        trackCount: composition.tracks.length,
        itemCount: composition.items.length,
        nestedCompositionIds: [
          ...new Set(
            composition.items
              .filter((item) => item.type === 'composition')
              .map((item) => item.compositionId),
          ),
        ],
        references: impact,
      }
    })
    return {
      ok: true,
      message: `Found ${data.length} composition${data.length === 1 ? '' : 's'}.`,
      data,
    }
  },
})

function effectParamSummary(param: EffectParam) {
  return {
    type: param.type,
    label: param.label,
    default: param.default,
    min: param.min,
    max: param.max,
    step: param.step,
    options: param.options,
    animatable: param.animatable,
  }
}

const listEffects = definePlatformTool({
  name: 'list_effects',
  title: 'List visual effects',
  description:
    'List every registered GPU effect and its editable parameter schema before applying an effect.',
  inputSchema: objectSchema({
    category: {
      type: 'string',
      enum: ['color', 'blur', 'distort', 'stylize', 'keying'],
    },
    query: { type: 'string' },
  }),
  readOnly: true,
  schema: z.object({
    category: z.enum(['color', 'blur', 'distort', 'stylize', 'keying']).optional(),
    query: z.string().optional(),
  }),
  summarize: () => 'List GPU effects',
  execute: ({ category, query }) => {
    const needle = query?.trim().toLowerCase()
    const effects = getGpuCategoriesWithEffects()
      .flatMap((group) => group.effects)
      .filter((effect) => !category || effect.category === category)
      .filter(
        (effect) =>
          !needle ||
          effect.id.toLowerCase().includes(needle) ||
          effect.name.toLowerCase().includes(needle),
      )
      .map((effect) => ({
        id: effect.id,
        name: effect.name,
        category: effect.category,
        params: Object.fromEntries(
          Object.entries(effect.params).map(([key, param]) => [
            key,
            effectParamSummary(param),
          ]),
        ),
      }))
    return {
      ok: true,
      message: `Found ${effects.length} visual effect${effects.length === 1 ? '' : 's'}.`,
      data: effects,
    }
  },
})

const inspectTimelineIntegrity = definePlatformTool({
  name: 'inspect_timeline_integrity',
  title: 'Inspect timeline integrity',
  description:
    'Check the active, Main, or named sequence for gaps, unintended overlaps, locked tracks, and missing media references.',
  inputSchema: objectSchema({
    scope: { type: 'string', enum: ['active', 'main', 'sequence'] },
    sequenceId: { type: 'string' },
  }),
  readOnly: true,
  schema: z.object({
    scope: z.enum(['active', 'main', 'sequence']).optional(),
    sequenceId: z.string().min(1).optional(),
  }),
  summarize: () => 'Inspect timeline integrity',
  execute: ({ scope = 'active', sequenceId }) => {
    const timeline = getToolTimelineSnapshot({ scope, sequenceId })
    const gaps = timeline.tracks.flatMap((track) => {
      const items = timeline.items
        .filter((item) => item.trackId === track.id)
        .sort((left, right) => left.from - right.from)
      let cursor = 0
      const trackGaps: Array<{ trackId: string; from: number; to: number; frames: number }> = []
      for (const item of items) {
        if (item.from > cursor) {
          trackGaps.push({
            trackId: track.id,
            from: cursor,
            to: item.from,
            frames: item.from - cursor,
          })
        }
        cursor = Math.max(cursor, item.from + item.durationInFrames)
      }
      return trackGaps
    })
    const mediaIds = new Set(useMediaLibraryStore.getState().mediaItems.map((media) => media.id))
    const missingMedia = timeline.items
      .filter((item) => item.mediaId && !mediaIds.has(item.mediaId))
      .map((item) => ({ itemId: item.id, mediaId: item.mediaId, label: item.label }))
    const overlaps = detectOverlappingItems(timeline.items, timeline.transitions)
    const lockedTracks = timeline.tracks
      .filter((track) => track.locked)
      .map((track) => ({ id: track.id, name: track.name }))
    const clean = gaps.length === 0 && overlaps.length === 0 && missingMedia.length === 0
    return {
      ok: true,
      message: clean
        ? 'Timeline integrity check is clean.'
        : `Timeline check found ${gaps.length} gaps, ${overlaps.length} overlaps, and ${missingMedia.length} missing-media references.`,
      data: {
        clean,
        sequenceId: timeline.id,
        fps: timeline.fps,
        gaps,
        overlaps,
        lockedTracks,
        missingMedia,
      },
    }
  },
})

export const READ_PLATFORM_TOOLS = [
  readProject,
  readTimeline,
  readMedia,
  readTranscript,
  readSubtitles,
  readHistory,
  listSequences,
  listCompositions,
  listEffects,
  inspectTimelineIntegrity,
] as const
