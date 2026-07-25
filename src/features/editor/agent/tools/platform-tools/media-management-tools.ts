import { z } from 'zod'
import {
  getSharedProxyKey,
  importMediaLibraryService,
  mediaTranscriptionService,
  proxyService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { getProject, useProjectStore } from '@/features/editor/deps/projects'
import {
  getMediaDeletionImpact,
  removeProjectItems,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import { importLocalMediaToLibrary } from '../local-media-import'
import { definePlatformTool, objectSchema } from './shared'

async function ensureMediaProject(projectId?: string): Promise<string> {
  const openProjectId = useProjectStore.getState().currentProject?.id
  const mediaProjectId = useMediaLibraryStore.getState().currentProjectId
  const resolvedProjectId = projectId ?? openProjectId ?? mediaProjectId
  if (!resolvedProjectId) throw new Error('No project is open or specified.')
  if (!(await getProject(resolvedProjectId))) {
    throw new Error(`Project not found: ${resolvedProjectId}`)
  }
  if (openProjectId && projectId && projectId !== openProjectId) {
    throw new Error(`Project ${openProjectId} is open; cannot switch media context to ${projectId}.`)
  }
  const store = useMediaLibraryStore.getState()
  if (store.currentProjectId !== resolvedProjectId) {
    store.setCurrentProject(resolvedProjectId)
    await useMediaLibraryStore.getState().loadMediaItems()
  }
  return resolvedProjectId
}

function summarizeMedia(mediaId: string) {
  const media = useMediaLibraryStore.getState().mediaById[mediaId]
  return media
    ? {
        id: media.id,
        fileName: media.fileName,
        mimeType: media.mimeType,
        fileSize: media.fileSize,
        duration: media.duration,
        width: media.width,
        height: media.height,
        fps: media.fps,
        storageType: media.storageType,
      }
    : { id: mediaId }
}

async function resolveSingleLocalHandle(path: string): Promise<FileSystemFileHandle> {
  const handles = await getDevLocalMediaHandles(path)
  if (handles.length !== 1) {
    throw new Error(
      handles.length === 0
        ? `No local file was found at ${path}.`
        : `The path must resolve to exactly one local file: ${path}`,
    )
  }
  return handles[0]!
}

const importMediaFiles = definePlatformTool({
  name: 'import_media_files',
  title: 'Import media files',
  description:
    'Import files or a local folder into a project media library without placing them on the timeline, optionally including nested folders.',
  inputSchema: objectSchema(
    {
      path: { type: 'string' },
      projectId: { type: 'string' },
      storageMode: { type: 'string', enum: ['copy', 'link'] },
      recursive: { type: 'boolean' },
    },
    ['path'],
  ),
  schema: z.object({
    path: z.string().trim().min(1),
    projectId: z.string().min(1).optional(),
    storageMode: z.enum(['copy', 'link']).optional(),
    recursive: z.boolean().optional(),
  }),
  summarize: ({ path }) => `Import media files from ${path}`,
  execute: async ({ path, projectId, storageMode = 'copy', recursive = false }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    const imported = await importLocalMediaToLibrary(path, storageMode, recursive)
    return {
      ok: true,
      message: `Imported ${imported.length} media item${imported.length === 1 ? '' : 's'} into the project library.`,
      data: {
        projectId: resolvedProjectId,
        storageMode,
        recursive,
        media: imported.map((media) => summarizeMedia(media.id)),
      },
      changed: imported.length > 0,
    }
  },
})

const deleteMedia = definePlatformTool({
  name: 'delete_media',
  title: 'Delete media',
  description:
    'Remove media from the open project, first deleting every root and nested timeline reference and saving the timeline.',
  inputSchema: objectSchema(
    {
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    ['mediaIds'],
  ),
  destructive: true,
  schema: z.object({ mediaIds: z.array(z.string().min(1)).min(1) }),
  summarize: ({ mediaIds }) => `Delete ${mediaIds.length} media item(s)`,
  execute: async ({ mediaIds }) => {
    const projectId = useProjectStore.getState().currentProject?.id
    if (!projectId) throw new Error('Open the target project before deleting media.')
    await ensureMediaProject(projectId)
    const existingIds = mediaIds.filter((id) => !!useMediaLibraryStore.getState().mediaById[id])
    if (existingIds.length === 0) throw new Error('None of those media items exist.')

    const impact = getMediaDeletionImpact(existingIds)
    if (impact.itemIds.length > 0 && removeProjectItems(impact.itemIds)) {
      await useTimelineStore.getState().saveTimeline(projectId)
    }
    await useMediaLibraryStore.getState().deleteMediaBatch(existingIds)
    return {
      ok: true,
      message: `Deleted ${existingIds.length} media item${existingIds.length === 1 ? '' : 's'} and ${impact.totalReferenceCount} timeline reference${impact.totalReferenceCount === 1 ? '' : 's'}.`,
      data: {
        projectId,
        mediaIds: existingIds,
        removedTimelineItemIds: impact.itemIds,
        rootReferenceCount: impact.rootReferenceCount,
        nestedReferenceCount: impact.nestedReferenceCount,
      },
      changed: true,
    }
  },
})

const scanMediaHealth = definePlatformTool({
  name: 'scan_media_health',
  title: 'Scan media health',
  description: 'Check a project media library for missing source files and orphaned timeline clips.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }),
  readOnly: true,
  schema: z.object({ projectId: z.string().min(1).optional() }),
  summarize: () => 'Scan media health',
  execute: async ({ projectId }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    await useMediaLibraryStore.getState().scanMediaHealth()
    const state = useMediaLibraryStore.getState()
    return {
      ok: true,
      message: `Media health scan found ${state.brokenMediaIds.length} broken source${state.brokenMediaIds.length === 1 ? '' : 's'} and ${state.orphanedClips.length} orphaned clip${state.orphanedClips.length === 1 ? '' : 's'}.`,
      data: {
        projectId: resolvedProjectId,
        brokenMediaIds: state.brokenMediaIds,
        brokenMedia: [...state.brokenMediaInfo.values()],
        orphanedClips: state.orphanedClips,
      },
    }
  },
})

const relinkMedia = definePlatformTool({
  name: 'relink_media',
  title: 'Relink media',
  description: 'Replace the missing source file handle for one media item with an absolute local file.',
  inputSchema: objectSchema(
    {
      mediaId: { type: 'string' },
      path: { type: 'string' },
      projectId: { type: 'string' },
    },
    ['mediaId', 'path'],
  ),
  schema: z.object({
    mediaId: z.string().min(1),
    path: z.string().trim().min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ mediaId }) => `Relink media ${mediaId}`,
  execute: async ({ mediaId, path, projectId }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    const handle = await resolveSingleLocalHandle(path)
    const changed = await useMediaLibraryStore.getState().relinkMedia(mediaId, handle)
    return {
      ok: true,
      message: changed ? `Relinked media ${mediaId}.` : `Media ${mediaId} was not relinked.`,
      data: { projectId: resolvedProjectId, media: summarizeMedia(mediaId), path },
      changed,
    }
  },
})

const relinkOrphanedClip = definePlatformTool({
  name: 'relink_orphaned_clip',
  title: 'Relink orphaned clip',
  description: 'Reconnect one orphaned timeline clip and its linked items to a media-library item.',
  inputSchema: objectSchema(
    {
      itemId: { type: 'string' },
      mediaId: { type: 'string' },
    },
    ['itemId', 'mediaId'],
  ),
  schema: z.object({
    itemId: z.string().min(1),
    mediaId: z.string().min(1),
  }),
  summarize: ({ itemId, mediaId }) => `Relink clip ${itemId} to media ${mediaId}`,
  execute: async ({ itemId, mediaId }) => {
    const projectId = useProjectStore.getState().currentProject?.id
    if (!projectId) throw new Error('Open the target project before relinking timeline clips.')
    await ensureMediaProject(projectId)
    const changed = await useMediaLibraryStore.getState().relinkOrphanedClip(itemId, mediaId)
    if (changed) await useTimelineStore.getState().saveTimeline(projectId)
    return {
      ok: true,
      message: changed ? `Relinked orphaned clip ${itemId}.` : `Clip ${itemId} was not relinked.`,
      data: { projectId, itemId, mediaId },
      changed,
    }
  },
})

const manageMediaProxy = definePlatformTool({
  name: 'manage_media_proxy',
  title: 'Manage media proxy',
  description: 'Read status, generate, cancel, or delete preview proxies for video media.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['status', 'generate', 'cancel', 'delete'] },
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      projectId: { type: 'string' },
    },
    ['operation', 'mediaIds'],
  ),
  schema: z.object({
    operation: z.enum(['status', 'generate', 'cancel', 'delete']),
    mediaIds: z.array(z.string().min(1)).min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ operation, mediaIds }) => `${operation} ${mediaIds.length} media proxy item(s)`,
  execute: async ({ operation, mediaIds, projectId }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    const store = useMediaLibraryStore.getState()
    const media = mediaIds.map((id) => store.mediaById[id]).filter((item) => !!item)
    if (media.length === 0) throw new Error('None of those media items exist.')

    if (operation === 'generate') {
      for (const item of media) {
        if (!proxyService.canGenerateProxy(item.mimeType)) continue
        const proxyKey = getSharedProxyKey(item)
        proxyService.setProxyKey(item.id, proxyKey)
        proxyService.generateProxy(
          item.id,
          item.storageType === 'opfs' && item.opfsPath
            ? { kind: 'opfs', path: item.opfsPath, mimeType: item.mimeType }
            : async () => {
                const { mediaLibraryService } = await importMediaLibraryService()
                return mediaLibraryService.getMediaFile(item.id)
              },
          item.width,
          item.height,
          proxyKey,
        )
      }
    } else if (operation === 'cancel') {
      for (const item of media) {
        proxyService.cancelProxy(item.id, getSharedProxyKey(item))
      }
    } else if (operation === 'delete') {
      const representatives = new Map(media.map((item) => [getSharedProxyKey(item), item]))
      for (const [proxyKey, item] of representatives) {
        await proxyService.deleteProxy(item.id, proxyKey)
        for (const candidate of useMediaLibraryStore.getState().mediaItems) {
          if (getSharedProxyKey(candidate) === proxyKey) {
            useMediaLibraryStore.getState().clearProxyStatus(candidate.id)
            proxyService.clearProxyKey(candidate.id)
          }
        }
      }
    }

    const latest = useMediaLibraryStore.getState()
    return {
      ok: true,
      message: `${operation} completed for ${media.length} media proxy item${media.length === 1 ? '' : 's'}.`,
      data: {
        projectId: resolvedProjectId,
        proxies: media.map((item) => ({
          mediaId: item.id,
          status: latest.proxyStatus.get(item.id) ?? 'idle',
          progress: latest.proxyProgress.get(item.id) ?? null,
          ready: proxyService.hasProxy(item.id, getSharedProxyKey(item)),
        })),
      },
      operationId: operation === 'generate' ? crypto.randomUUID() : undefined,
      changed: operation !== 'status',
    }
  },
})

const transcribeMedia = definePlatformTool({
  name: 'transcribe_media',
  title: 'Transcribe media',
  description: 'Run configured cloud ASR on media-library items without requiring timeline placement.',
  inputSchema: objectSchema(
    {
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      projectId: { type: 'string' },
    },
    ['mediaIds'],
  ),
  schema: z.object({
    mediaIds: z.array(z.string().min(1)).min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ mediaIds }) => `Transcribe ${mediaIds.length} media item(s)`,
  execute: async ({ mediaIds, projectId }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    const results = []
    for (const mediaId of mediaIds) {
      const transcript = await mediaTranscriptionService.transcribeMedia(mediaId)
      useMediaLibraryStore.getState().setTranscriptStatus(mediaId, 'ready')
      results.push({
        mediaId,
        text: transcript.text,
        segmentCount: transcript.segments.length,
        updatedAt: transcript.updatedAt,
      })
    }
    return {
      ok: true,
      message: `Transcribed ${results.length} media item${results.length === 1 ? '' : 's'}.`,
      data: { projectId: resolvedProjectId, transcripts: results },
      operationId: crypto.randomUUID(),
      changed: results.length > 0,
    }
  },
})

const deleteTranscript = definePlatformTool({
  name: 'delete_transcript',
  title: 'Delete transcript',
  description: 'Delete stored ASR transcripts for one or more media-library items.',
  inputSchema: objectSchema(
    {
      mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
      projectId: { type: 'string' },
    },
    ['mediaIds'],
  ),
  destructive: true,
  schema: z.object({
    mediaIds: z.array(z.string().min(1)).min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ mediaIds }) => `Delete ${mediaIds.length} transcript(s)`,
  execute: async ({ mediaIds, projectId }) => {
    const resolvedProjectId = await ensureMediaProject(projectId)
    for (const mediaId of mediaIds) {
      await mediaTranscriptionService.deleteTranscript(mediaId)
      useMediaLibraryStore.getState().setTranscriptStatus(mediaId, 'idle')
    }
    return {
      ok: true,
      message: `Deleted ${mediaIds.length} transcript${mediaIds.length === 1 ? '' : 's'}.`,
      data: { projectId: resolvedProjectId, mediaIds },
      changed: true,
    }
  },
})

export const MEDIA_MANAGEMENT_PLATFORM_TOOLS = [
  importMediaFiles,
  deleteMedia,
  scanMediaHealth,
  relinkMedia,
  relinkOrphanedClip,
  manageMediaProxy,
  transcribeMedia,
  deleteTranscript,
] as const
