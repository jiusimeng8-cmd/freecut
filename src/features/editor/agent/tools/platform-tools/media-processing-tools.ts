import { z } from 'zod'
import {
  chooseEmbeddedSubtitleTrackForMedia,
  frameInterpolationService,
  getEmbeddedSubtitleTrackLabel,
  importMediaLibraryService,
  subtitleSidecarService,
  upscaleService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { getProject, useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineStore } from '@/features/editor/deps/timeline-contract'
import type { MediaMetadata } from '@/types/storage'
import { definePlatformTool, objectSchema } from './shared'

async function ensureProjectMedia(projectId?: string): Promise<{
  projectId: string
  media: MediaMetadata[]
}> {
  const openProjectId = useProjectStore.getState().currentProject?.id
  const id = projectId ?? openProjectId ?? useMediaLibraryStore.getState().currentProjectId
  if (!id) throw new Error('No project is open or specified.')
  if (!(await getProject(id))) throw new Error(`Project not found: ${id}`)
  if (openProjectId && openProjectId !== id) {
    throw new Error(`Project ${openProjectId} is open; cannot process media from ${id}.`)
  }
  const store = useMediaLibraryStore.getState()
  if (store.currentProjectId !== id) {
    store.setCurrentProject(id)
    await useMediaLibraryStore.getState().loadMediaItems()
  }
  return { projectId: id, media: useMediaLibraryStore.getState().mediaItems }
}

function resolveMedia(media: MediaMetadata[], mediaIds: string[]): MediaMetadata[] {
  const requested = new Set(mediaIds)
  const selected = media.filter((entry) => requested.has(entry.id))
  if (selected.length === 0) throw new Error('None of the requested media items exist.')
  return selected
}

function sourceFor(media: MediaMetadata, getMediaFile: (id: string) => Promise<Blob | null>) {
  return media.storageType === 'opfs' && media.opfsPath
    ? { kind: 'opfs' as const, path: media.opfsPath, mimeType: media.mimeType }
    : () => getMediaFile(media.id)
}

const manageMediaInterpolation = definePlatformTool({
  name: 'manage_media_interpolation',
  title: 'Manage frame interpolation',
  description:
    'Read status, generate 2x-8x RIFE frame-interpolated media, or cancel interpolation jobs.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['status', 'generate', 'cancel'] },
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      factor: { type: 'number', enum: [2, 3, 4, 5, 6, 7, 8] },
      projectId: { type: 'string' },
    },
    ['operation', 'mediaIds'],
  ),
  schema: z
    .object({
      operation: z.enum(['status', 'generate', 'cancel']),
      mediaIds: z.array(z.string().min(1)).min(1),
      factor: z
        .union([
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal(6),
          z.literal(7),
          z.literal(8),
        ])
        .optional(),
      projectId: z.string().min(1).optional(),
    })
    .refine(({ operation, factor }) => operation !== 'generate' || factor !== undefined, {
      message: 'factor is required when generating interpolation.',
      path: ['factor'],
    }),
  summarize: ({ operation }) => `${operation} frame interpolation`,
  execute: async ({ operation, mediaIds, factor, projectId }) => {
    const { projectId: id, media: projectMedia } = await ensureProjectMedia(projectId)
    const selected = resolveMedia(projectMedia, mediaIds)
    if (operation === 'generate') {
      const { mediaLibraryService } = await importMediaLibraryService()
      let queued = 0
      for (const entry of selected) {
        if (
          !frameInterpolationService.canInterpolate(entry.mimeType) ||
          frameInterpolationService.isGenerating(entry.id)
        ) {
          continue
        }
        frameInterpolationService.generate({
          mediaId: entry.id,
          projectId: id,
          fileName: entry.fileName,
          factor: factor!,
          source: sourceFor(entry, (mediaId) => mediaLibraryService.getMediaFile(mediaId)),
          sourceFps: entry.fps || 30,
        })
        queued += 1
      }
      return {
        ok: true,
        message: `Queued ${queued} interpolation job${queued === 1 ? '' : 's'}.`,
        data: { projectId: id, factor, queued },
        operationId: queued > 0 ? crypto.randomUUID() : undefined,
        changed: queued > 0,
      }
    }
    if (operation === 'cancel') {
      let cancelled = 0
      for (const entry of selected) {
        if (!frameInterpolationService.isGenerating(entry.id)) continue
        frameInterpolationService.cancel(entry.id)
        cancelled += 1
      }
      return {
        ok: true,
        message: `Cancelled ${cancelled} interpolation job${cancelled === 1 ? '' : 's'}.`,
        data: { projectId: id, cancelled },
        changed: cancelled > 0,
      }
    }
    const store = useMediaLibraryStore.getState()
    const tasks = selected.map((entry) => ({
      mediaId: entry.id,
      eligible: frameInterpolationService.canInterpolate(entry.mimeType),
      generating: frameInterpolationService.isGenerating(entry.id),
      status: store.interpolationStatus.get(entry.id) ?? 'idle',
      progress: store.interpolationProgress.get(entry.id) ?? null,
      stage: store.interpolationStage.get(entry.id) ?? null,
      etaSeconds: store.interpolationEtaSeconds.get(entry.id) ?? null,
    }))
    return {
      ok: true,
      message: `Read ${tasks.length} interpolation status entr${tasks.length === 1 ? 'y' : 'ies'}.`,
      data: { projectId: id, tasks },
    }
  },
})

const manageMediaUpscale = definePlatformTool({
  name: 'manage_media_upscale',
  title: 'Manage media upscale',
  description:
    'Read status, generate 2x Anime4K media for live action/animation/3D, or cancel upscale jobs.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['status', 'generate', 'cancel'] },
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      variant: { type: 'string', enum: ['liveAction', 'animation', 'threeD'] },
      projectId: { type: 'string' },
    },
    ['operation', 'mediaIds'],
  ),
  schema: z
    .object({
      operation: z.enum(['status', 'generate', 'cancel']),
      mediaIds: z.array(z.string().min(1)).min(1),
      variant: z.enum(['liveAction', 'animation', 'threeD']).optional(),
      projectId: z.string().min(1).optional(),
    })
    .refine(({ operation, variant }) => operation !== 'generate' || variant !== undefined, {
      message: 'variant is required when generating an upscale.',
      path: ['variant'],
    }),
  summarize: ({ operation }) => `${operation} media upscale`,
  execute: async ({ operation, mediaIds, variant, projectId }) => {
    const { projectId: id, media: projectMedia } = await ensureProjectMedia(projectId)
    const selected = resolveMedia(projectMedia, mediaIds)
    if (operation === 'generate') {
      const { mediaLibraryService } = await importMediaLibraryService()
      let queued = 0
      for (const entry of selected) {
        if (
          !upscaleService.canUpscaleMedia(entry.mimeType, entry.width, entry.height) ||
          upscaleService.isGenerating(entry.id)
        ) {
          continue
        }
        upscaleService.generate({
          mediaId: entry.id,
          projectId: id,
          fileName: entry.fileName,
          variant: variant!,
          source: sourceFor(entry, (mediaId) => mediaLibraryService.getMediaFile(mediaId)),
          sourceFps: entry.fps || 30,
        })
        queued += 1
      }
      return {
        ok: true,
        message: `Queued ${queued} upscale job${queued === 1 ? '' : 's'}.`,
        data: { projectId: id, variant, queued },
        operationId: queued > 0 ? crypto.randomUUID() : undefined,
        changed: queued > 0,
      }
    }
    if (operation === 'cancel') {
      let cancelled = 0
      for (const entry of selected) {
        if (!upscaleService.isGenerating(entry.id)) continue
        upscaleService.cancel(entry.id)
        cancelled += 1
      }
      return {
        ok: true,
        message: `Cancelled ${cancelled} upscale job${cancelled === 1 ? '' : 's'}.`,
        data: { projectId: id, cancelled },
        changed: cancelled > 0,
      }
    }
    const store = useMediaLibraryStore.getState()
    const tasks = selected.map((entry) => ({
      mediaId: entry.id,
      eligible: upscaleService.canUpscaleMedia(entry.mimeType, entry.width, entry.height),
      generating: upscaleService.isGenerating(entry.id),
      status: store.upscaleStatus.get(entry.id) ?? 'idle',
      progress: store.upscaleProgress.get(entry.id) ?? null,
      stage: store.upscaleStage.get(entry.id) ?? null,
      etaSeconds: store.upscaleEtaSeconds.get(entry.id) ?? null,
    }))
    return {
      ok: true,
      message: `Read ${tasks.length} upscale status entr${tasks.length === 1 ? 'y' : 'ies'}.`,
      data: { projectId: id, tasks },
    }
  },
})

async function scanEmbeddedSubtitles(media: MediaMetadata) {
  const { mediaLibraryService } = await importMediaLibraryService()
  const source = await mediaLibraryService.getMediaFile(media.id)
  if (!source) throw new Error(`Media source is unavailable: ${media.id}`)
  return subtitleSidecarService.scanEmbeddedSubtitleTracks(media, source)
}

const readEmbeddedSubtitles = definePlatformTool({
  name: 'read_embedded_subtitles',
  title: 'Read embedded subtitles',
  description:
    'Scan or reuse cached text subtitle tracks embedded in one WebM/MKV media source and return track metadata.',
  inputSchema: objectSchema(
    {
      mediaId: { type: 'string' },
      projectId: { type: 'string' },
    },
    ['mediaId'],
  ),
  readOnly: true,
  schema: z.object({
    mediaId: z.string().min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ mediaId }) => `Read embedded subtitles for ${mediaId}`,
  execute: async ({ mediaId, projectId }) => {
    const { projectId: id, media } = await ensureProjectMedia(projectId)
    const entry = media.find((candidate) => candidate.id === mediaId)
    if (!entry) throw new Error(`Media not found: ${mediaId}`)
    const result = await scanEmbeddedSubtitles(entry)
    const tracks = result.tracks.map((track) => ({
      trackNumber: track.trackNumber,
      label: getEmbeddedSubtitleTrackLabel(track),
      language: track.language,
      name: track.name,
      codecId: track.codecId,
      default: track.default,
      forced: track.forced,
      cueCount: track.cues.length,
      startSeconds: track.cues[0]?.startSeconds ?? null,
      endSeconds: track.cues.at(-1)?.endSeconds ?? null,
    }))
    return {
      ok: true,
      message: `Found ${tracks.length} embedded subtitle track${tracks.length === 1 ? '' : 's'}.`,
      data: {
        projectId: id,
        mediaId,
        fromCache: result.fromCache,
        scannedAt: result.scannedAt,
        tracks,
      },
      operationId: crypto.randomUUID(),
    }
  },
})

const insertEmbeddedSubtitles = definePlatformTool({
  name: 'insert_embedded_subtitles',
  title: 'Insert embedded subtitles',
  description:
    'Insert one embedded subtitle track as editable subtitle segments linked to every matching timeline clip.',
  destructive: true,
  inputSchema: objectSchema(
    {
      mediaId: { type: 'string' },
      trackNumber: { type: 'number', minimum: 1 },
      language: { type: 'string' },
      trackName: { type: 'string' },
    },
    ['mediaId'],
  ),
  schema: z.object({
    mediaId: z.string().min(1),
    trackNumber: z.number().int().min(1).optional(),
    language: z.string().min(1).optional(),
    trackName: z.string().min(1).optional(),
  }),
  summarize: ({ mediaId }) => `Insert embedded subtitles for ${mediaId}`,
  execute: async ({ mediaId, trackNumber, language, trackName }) => {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('Open the target project before inserting subtitles.')
    const { media } = await ensureProjectMedia(project.id)
    const entry = media.find((candidate) => candidate.id === mediaId)
    if (!entry) throw new Error(`Media not found: ${mediaId}`)
    const result = await scanEmbeddedSubtitles(entry)
    const track =
      (trackNumber !== undefined
        ? result.tracks.find((candidate) => candidate.trackNumber === trackNumber)
        : undefined) ??
      (language ? result.tracks.find((candidate) => candidate.language === language) : undefined) ??
      (trackName ? result.tracks.find((candidate) => candidate.name === trackName) : undefined) ??
      chooseEmbeddedSubtitleTrackForMedia(result.tracks)
    if (!track) throw new Error('No matching embedded subtitle track was found.')
    const beforeItemIds = new Set(useTimelineStore.getState().items.map((item) => item.id))
    const inserted = subtitleSidecarService.insertEmbeddedSubtitleTrack(entry, track)
    const afterItemIds = new Set(useTimelineStore.getState().items.map((item) => item.id))
    const removedItemCount = [...beforeItemIds].filter((itemId) => !afterItemIds.has(itemId)).length
    const changed =
      beforeItemIds.size !== afterItemIds.size ||
      [...beforeItemIds].some((itemId) => !afterItemIds.has(itemId))
    if (changed) {
      await useTimelineStore.getState().saveTimeline(project.id)
    }
    return {
      ok: true,
      message:
        inserted.insertedItemCount > 0
          ? `Inserted ${inserted.insertedItemCount} editable subtitle segment${inserted.insertedItemCount === 1 ? '' : 's'} from "${inserted.trackLabel}".`
          : removedItemCount > 0
            ? `Removed ${removedItemCount} obsolete subtitle item${removedItemCount === 1 ? '' : 's'}; the selected track had no usable cues for the target clips.`
            : `The selected track had no usable cues for the target clips.`,
      data: {
        projectId: project.id,
        mediaId,
        trackNumber: track.trackNumber,
        cueCount: inserted.cueCount,
        insertedItemCount: inserted.insertedItemCount,
        removedItemCount,
      },
      changed,
    }
  },
})

export const MEDIA_PROCESSING_PLATFORM_TOOLS = [
  manageMediaInterpolation,
  manageMediaUpscale,
  readEmbeddedSubtitles,
  insertEmbeddedSubtitles,
] as const
