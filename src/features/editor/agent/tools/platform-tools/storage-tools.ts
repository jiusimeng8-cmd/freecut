import { z } from 'zod'
import {
  getSharedProxyKey,
  importMediaLibraryService,
  importThumbnailGenerator,
  proxyService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import {
  clearPreviewAudioCache,
  deletePreviewAudioConform,
} from '@/features/editor/deps/composition-runtime'
import {
  importFilmstripCache,
  importGifFrameCache,
  importWaveformCache,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import {
  deleteDecodedPreviewAudio,
  deleteGifFrames,
  deleteWaveform,
  getAllMediaMetadata,
  getDBStats,
  saveThumbnail,
  sweepWorkspaceOrphans,
  updateMedia,
  workspaceFolderName,
} from '@/infrastructure/storage'
import { requireWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import type { MediaMetadata } from '@/types/storage'
import { definePlatformTool, objectSchema } from './shared'

async function resolveProjectMedia(projectId?: string): Promise<{
  projectId: string
  media: MediaMetadata[]
}> {
  const id = projectId ?? useProjectStore.getState().currentProject?.id
  if (!id) throw new Error('No project is open or specified.')
  const { mediaLibraryService } = await importMediaLibraryService()
  const media = await mediaLibraryService.getMediaForProject(id)
  return { projectId: id, media }
}

function selectMedia(media: MediaMetadata[], mediaIds?: string[]): MediaMetadata[] {
  if (!mediaIds?.length) return media
  const requested = new Set(mediaIds)
  const selected = media.filter((entry) => requested.has(entry.id))
  if (selected.length === 0) throw new Error('None of the requested media items exist.')
  return selected
}

function artifactPathSegments(path: string): string[] {
  const segments = path
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const isTopLevelExport = segments[0] === 'exports' && segments.length >= 2
  const isProjectExport =
    segments[0] === 'projects' &&
    !!segments[1] &&
    segments[2] === 'exports' &&
    segments.length >= 4
  if (
    segments.some((segment) => segment === '.' || segment === '..') ||
    (!isTopLevelExport && !isProjectExport)
  ) {
    throw new Error('Artifact path must be under exports/ or projects/{id}/exports/.')
  }
  return segments
}

const getWorkspaceArtifact = definePlatformTool({
  name: 'get_workspace_artifact',
  requiresProject: false,
  title: 'Get workspace artifact',
  description:
    'Resolve an exported project bundle, snapshot, settings preset, media render, or subtitle under the workspace exports directories.',
  inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
  readOnly: true,
  schema: z.object({ path: z.string().trim().min(1) }),
  summarize: ({ path }) => `Read workspace artifact ${path}`,
  execute: async ({ path }) => {
    const segments = artifactPathSegments(path)
    const relPath = segments.join('/')
    try {
      let directory = requireWorkspaceRoot()
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment)
      }
      const file = await (await directory.getFileHandle(segments.at(-1)!)).getFile()
      return {
        ok: true,
        message: `Workspace artifact ${relPath} exists (${file.size} bytes).`,
        data: {
          exists: true,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          mimeType: file.type || 'application/octet-stream',
          workspaceName: workspaceFolderName(),
          relPath,
          downloadUrl: import.meta.env.DEV
            ? new URL(
                `/__freecut_dev_workspace/file?path=${encodeURIComponent(relPath)}`,
                window.location.origin,
              ).toString()
            : null,
        },
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return {
          ok: true,
          message: `Workspace artifact ${relPath} is missing.`,
          data: {
            exists: false,
            workspaceName: workspaceFolderName(),
            relPath,
            downloadUrl: null,
          },
        }
      }
      throw error
    }
  },
})

const deleteWorkspaceArtifact = definePlatformTool({
  name: 'delete_workspace_artifact',
  requiresProject: false,
  title: 'Delete workspace artifact',
  description:
    'Delete one exported project bundle, snapshot, settings preset, media render, or subtitle from an allowed workspace exports directory.',
  inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
  destructive: true,
  schema: z.object({ path: z.string().trim().min(1) }),
  summarize: ({ path }) => `Delete workspace artifact ${path}`,
  execute: async ({ path }) => {
    const segments = artifactPathSegments(path)
    const relPath = segments.join('/')
    try {
      let directory = requireWorkspaceRoot()
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment)
      }
      await directory.removeEntry(segments.at(-1)!)
      return {
        ok: true,
        message: `Deleted workspace artifact ${relPath}.`,
        data: { relPath },
        changed: true,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return {
          ok: true,
          message: `Workspace artifact ${relPath} was already missing.`,
          data: { relPath },
          changed: false,
        }
      }
      throw error
    }
  },
})

const readStorage = definePlatformTool({
  name: 'read_storage',
  requiresProject: false,
  title: 'Read storage',
  description:
    'Read workspace name, browser storage estimates, project/media counts, and current project cache-task status.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }),
  readOnly: true,
  schema: z.object({ projectId: z.string().min(1).optional() }),
  summarize: () => 'Read FreeCut storage',
  execute: async ({ projectId }) => {
    const [stats, allMedia] = await Promise.all([getDBStats(), getAllMediaMetadata()])
    const id = projectId ?? useProjectStore.getState().currentProject?.id
    let projectMedia: MediaMetadata[] = []
    if (id) {
      const resolved = await resolveProjectMedia(id)
      projectMedia = resolved.media
    }
    const mediaStore = useMediaLibraryStore.getState()
    return {
      ok: true,
      message: `Workspace contains ${stats.projectCount} project${stats.projectCount === 1 ? '' : 's'} and ${allMedia.length} media item${allMedia.length === 1 ? '' : 's'}.`,
      data: {
        workspaceName: workspaceFolderName(),
        projectCount: stats.projectCount,
        mediaCount: allMedia.length,
        storageEstimate: {
          usedBytes: stats.storageUsed,
          quotaBytes: stats.storageQuota,
          note: 'Browser storage estimate; workspace-folder disk usage is not exposed by the File System Access API.',
        },
        project: id
          ? {
              id,
              mediaCount: projectMedia.length,
              proxyTasks: [...mediaStore.proxyStatus.entries()],
              interpolationTasks: [...mediaStore.interpolationStatus.entries()],
              upscaleTasks: [...mediaStore.upscaleStatus.entries()],
              transcriptTasks: [...mediaStore.transcriptStatus.entries()],
            }
          : null,
      },
    }
  },
})

const manageProjectStorage = definePlatformTool({
  name: 'manage_project_storage',
  requiresProject: false,
  title: 'Manage project storage',
  description:
    'Clear regenerable caches, regenerate thumbnails, generate/delete proxies, validate or repair media storage, mirror legacy OPFS media, or sweep workspace orphans.',
  inputSchema: objectSchema(
    {
      operation: {
        type: 'string',
        enum: [
          'clear_caches',
          'regenerate_thumbnails',
          'generate_missing_proxies',
          'delete_proxies',
          'validate_sync',
          'repair_sync',
          'mirror_legacy_media',
          'sweep_orphans',
        ],
      },
      projectId: { type: 'string' },
      mediaIds: { type: 'array', items: { type: 'string' } },
      dryRun: { type: 'boolean' },
    },
    ['operation'],
  ),
  destructive: true,
  schema: z.object({
    operation: z.enum([
      'clear_caches',
      'regenerate_thumbnails',
      'generate_missing_proxies',
      'delete_proxies',
      'validate_sync',
      'repair_sync',
      'mirror_legacy_media',
      'sweep_orphans',
    ]),
    projectId: z.string().min(1).optional(),
    mediaIds: z.array(z.string().min(1)).optional(),
    dryRun: z.boolean().optional(),
  }),
  summarize: ({ operation }) => `${operation} project storage`,
  execute: async ({ operation, projectId, mediaIds, dryRun = false }) => {
    if (operation === 'sweep_orphans') {
      const report = await sweepWorkspaceOrphans({ dryRun })
      return {
        ok: true,
        message: `Workspace orphan sweep completed; ${report.totalRemoved} entr${report.totalRemoved === 1 ? 'y' : 'ies'} ${dryRun ? 'would be removed' : 'removed'}.`,
        data: report,
        changed: !dryRun && report.totalRemoved > 0,
      }
    }

    const { projectId: id, media: projectMedia } = await resolveProjectMedia(projectId)
    const media = selectMedia(projectMedia, mediaIds)
    const { mediaLibraryService } = await importMediaLibraryService()

    if (operation === 'validate_sync') {
      const result = await mediaLibraryService.validateSync()
      return {
        ok: true,
        message: `Storage validation found ${result.orphanedMetadata.length} orphaned metadata entr${result.orphanedMetadata.length === 1 ? 'y' : 'ies'}.`,
        data: { projectId: id, ...result },
        changed: false,
      }
    }

    if (operation === 'repair_sync') {
      const result = await mediaLibraryService.repairSync()
      return {
        ok: true,
        message: `Storage repair cleaned ${result.cleaned} entr${result.cleaned === 1 ? 'y' : 'ies'}.`,
        data: { projectId: id, ...result },
        changed: result.cleaned > 0,
      }
    }

    if (operation === 'mirror_legacy_media') {
      const result = await mediaLibraryService.mirrorOpfsMediaToWorkspace(media)
      return {
        ok: true,
        message: `Mirrored ${result.mirrored} legacy media source${result.mirrored === 1 ? '' : 's'} into the workspace.`,
        data: { projectId: id, mediaIds: media.map((entry) => entry.id), ...result },
        changed: result.mirrored > 0,
      }
    }

    if (operation === 'generate_missing_proxies') {
      let queued = 0
      for (const entry of media) {
        if (!proxyService.canGenerateProxy(entry.mimeType)) continue
        const proxyKey = getSharedProxyKey(entry)
        if (proxyService.hasProxy(entry.id, proxyKey)) continue
        const status = useMediaLibraryStore.getState().proxyStatus.get(entry.id)
        if (status === 'ready' || status === 'generating') continue
        proxyService.setProxyKey(entry.id, proxyKey)
        proxyService.generateProxy(
          entry.id,
          entry.storageType === 'opfs' && entry.opfsPath
            ? { kind: 'opfs', path: entry.opfsPath, mimeType: entry.mimeType }
            : () => mediaLibraryService.getMediaFile(entry.id),
          entry.width,
          entry.height,
          proxyKey,
          { priority: 'background' },
        )
        queued += 1
      }
      return {
        ok: true,
        message: `Queued ${queued} missing proxy job${queued === 1 ? '' : 's'}.`,
        data: { projectId: id, queued },
        operationId: queued > 0 ? crypto.randomUUID() : undefined,
        changed: queued > 0,
      }
    }

    if (operation === 'delete_proxies') {
      const failed: string[] = []
      for (const entry of media) {
        try {
          const proxyKey = getSharedProxyKey(entry)
          await proxyService.deleteProxy(entry.id, proxyKey)
          useMediaLibraryStore.getState().clearProxyStatus(entry.id)
          proxyService.clearProxyKey(entry.id)
        } catch {
          failed.push(entry.id)
        }
      }
      return {
        ok: failed.length === 0,
        message: `Deleted proxies for ${media.length - failed.length}/${media.length} media item${media.length === 1 ? '' : 's'}.`,
        data: { projectId: id, failedMediaIds: failed },
        changed: media.length > failed.length,
        ...(failed.length > 0
          ? {
              error: {
                code: 'PROXY_DELETE_PARTIAL',
                message: 'One or more media proxies could not be deleted.',
                retryable: true,
              },
            }
          : {}),
      }
    }

    if (operation === 'regenerate_thumbnails') {
      const { generateThumbnail } = await importThumbnailGenerator()
      const failed: string[] = []
      for (const entry of media) {
        try {
          const blob = await mediaLibraryService.getMediaFile(entry.id)
          if (!blob) throw new Error('Media source is unavailable.')
          const thumbnail = await generateThumbnail(
            new File([blob], entry.fileName, { type: entry.mimeType }),
          )
          const thumbnailId = crypto.randomUUID()
          await saveThumbnail({
            id: thumbnailId,
            mediaId: entry.id,
            blob: thumbnail,
            timestamp: 1,
            width: 320,
            height: 180,
          })
          await updateMedia(entry.id, { thumbnailId })
          mediaLibraryService.clearThumbnailCache(entry.id)
        } catch {
          failed.push(entry.id)
        }
      }
      if (useMediaLibraryStore.getState().currentProjectId === id) {
        await useMediaLibraryStore.getState().loadMediaItems()
      }
      return {
        ok: failed.length === 0,
        message: `Regenerated thumbnails for ${media.length - failed.length}/${media.length} media item${media.length === 1 ? '' : 's'}.`,
        data: { projectId: id, failedMediaIds: failed },
        operationId: crypto.randomUUID(),
        changed: media.length > failed.length,
        ...(failed.length > 0
          ? {
              error: {
                code: 'THUMBNAIL_REGEN_PARTIAL',
                message: 'One or more media thumbnails could not be regenerated.',
                retryable: true,
              },
            }
          : {}),
      }
    }

    clearPreviewAudioCache()
    const [{ gifFrameCache }, { filmstripCache }, { waveformCache }] = await Promise.all([
      importGifFrameCache(),
      importFilmstripCache(),
      importWaveformCache(),
    ])
    const failed: string[] = []
    for (const entry of media) {
      const results = await Promise.allSettled([
        deleteWaveform(entry.id),
        deleteGifFrames(entry.id),
        deleteDecodedPreviewAudio(entry.id),
        deletePreviewAudioConform(entry.id, { clearMetadata: true }),
        gifFrameCache.clearMedia(entry.id),
        filmstripCache.clearMedia(entry.id),
        waveformCache.clearMedia(entry.id),
      ])
      if (results.some((result) => result.status === 'rejected')) failed.push(entry.id)
    }
    return {
      ok: failed.length === 0,
      message: `Cleared regenerable caches for ${media.length - failed.length}/${media.length} media item${media.length === 1 ? '' : 's'}.`,
      data: { projectId: id, failedMediaIds: failed },
      changed: media.length > failed.length,
      ...(failed.length > 0
        ? {
            error: {
              code: 'CACHE_CLEAR_PARTIAL',
              message: 'One or more media caches could not be fully cleared.',
              retryable: true,
            },
          }
        : {}),
    }
  },
})

export const STORAGE_PLATFORM_TOOLS = [
  readStorage,
  getWorkspaceArtifact,
  deleteWorkspaceArtifact,
  manageProjectStorage,
] as const
