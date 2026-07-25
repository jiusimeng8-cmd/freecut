import { z } from 'zod'
import {
  importMediaLibraryService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { getProject, useProjectStore } from '@/features/editor/deps/projects'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import type { Project } from '@/types/project'
import { MEDIA_MANAGEMENT_PLATFORM_TOOLS } from './media-management-tools'
import { definePlatformTool, objectSchema } from './shared'

interface BrokenMediaTarget {
  mediaId: string
  fileName: string
  fileSize: number
}

class DevMediaDirectoryHandle {
  readonly kind = 'directory' as const

  constructor(
    readonly sourcePath: string,
    readonly name: string,
    private readonly files: FileSystemFileHandle[],
  ) {}

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (
      other instanceof DevMediaDirectoryHandle &&
      normalizeLocalPath(other.sourcePath) === normalizeLocalPath(this.sourcePath)
    )
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    yield* this.files
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const handle of this.files) {
      yield [handle.name, handle]
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const handle of this.files) {
      yield handle.name
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> {
    return this.entries()
  }
}

const scanMediaHealthTool = MEDIA_MANAGEMENT_PLATFORM_TOOLS.find(
  (tool) => tool.name === 'scan_media_health',
)

if (!scanMediaHealthTool) {
  throw new Error('scan_media_health platform tool is unavailable.')
}

function normalizeLocalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function localDirectoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).at(-1) ?? trimmed
}

async function resolveProject(projectId?: string): Promise<Project> {
  const currentProject = useProjectStore.getState().currentProject
  const resolvedProjectId = projectId ?? currentProject?.id
  if (!resolvedProjectId) throw new Error('No project is open or specified.')

  const project =
    currentProject?.id === resolvedProjectId ? currentProject : await getProject(resolvedProjectId)
  if (!project) throw new Error(`Project not found: ${resolvedProjectId}`)
  return project
}

async function createDevMediaDirectoryHandle(path: string): Promise<FileSystemDirectoryHandle> {
  const handles = await getDevLocalMediaHandles(path, { recursive: true })
  return new DevMediaDirectoryHandle(
    path,
    localDirectoryName(path),
    handles,
  ) as unknown as FileSystemDirectoryHandle
}

async function isSameDirectory(
  current: FileSystemDirectoryHandle | undefined,
  next: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (!current) return false
  try {
    return await current.isSameEntry(next)
  } catch {
    return false
  }
}

async function collectDirectoryFiles(
  directory: FileSystemDirectoryHandle,
  recursive: boolean,
): Promise<FileSystemFileHandle[]> {
  const files: FileSystemFileHandle[] = []
  for await (const entry of directory.values()) {
    if (entry.kind === 'file') {
      files.push(entry as FileSystemFileHandle)
    } else if (recursive) {
      files.push(...(await collectDirectoryFiles(entry as FileSystemDirectoryHandle, recursive)))
    }
  }
  return files
}

function brokenMediaTargets(): BrokenMediaTarget[] {
  const state = useMediaLibraryStore.getState()
  const targets: BrokenMediaTarget[] = []
  for (const mediaId of state.brokenMediaIds) {
    const info = state.brokenMediaInfo.get(mediaId)
    const media = state.mediaById[mediaId]
    if (!info || !media) continue
    targets.push({
      mediaId,
      fileName: info.fileName,
      fileSize: media.fileSize,
    })
  }
  return targets
}

async function matchBrokenMedia(
  broken: BrokenMediaTarget[],
  files: FileSystemFileHandle[],
): Promise<{
  relinks: Array<{ mediaId: string; handle: FileSystemFileHandle }>
  unmatched: string[]
}> {
  const brokenByName = new Map<string, BrokenMediaTarget[]>()
  const filesByName = new Map<string, FileSystemFileHandle[]>()

  for (const item of broken) {
    const key = item.fileName.toLowerCase()
    brokenByName.set(key, [...(brokenByName.get(key) ?? []), item])
  }
  for (const handle of files) {
    const key = handle.name.toLowerCase()
    filesByName.set(key, [...(filesByName.get(key) ?? []), handle])
  }

  const relinks: Array<{ mediaId: string; handle: FileSystemFileHandle }> = []
  const unmatched: string[] = []

  for (const [fileName, brokenGroup] of brokenByName) {
    const candidates = filesByName.get(fileName) ?? []
    if (candidates.length === 0) {
      unmatched.push(...brokenGroup.map((item) => item.mediaId))
      continue
    }

    if (candidates.length === 1 && brokenGroup.length === 1) {
      relinks.push({ mediaId: brokenGroup[0]!.mediaId, handle: candidates[0]! })
      continue
    }

    const candidatesWithSize = await Promise.all(
      candidates.map(async (handle) => ({
        handle,
        size: (await handle.getFile()).size,
      })),
    )
    for (const item of brokenGroup) {
      const sizeMatches = candidatesWithSize.filter((candidate) => candidate.size === item.fileSize)
      if (sizeMatches.length === 1) {
        relinks.push({ mediaId: item.mediaId, handle: sizeMatches[0]!.handle })
      } else {
        unmatched.push(item.mediaId)
      }
    }
  }

  return { relinks, unmatched }
}

async function ensureCurrentMediaProject(): Promise<string> {
  const openProjectId = useProjectStore.getState().currentProject?.id
  const mediaProjectId = useMediaLibraryStore.getState().currentProjectId
  const projectId = openProjectId ?? mediaProjectId
  if (!projectId) throw new Error('No project is open.')

  if (mediaProjectId !== projectId) {
    useMediaLibraryStore.getState().setCurrentProject(projectId)
    await useMediaLibraryStore.getState().loadMediaItems()
  }
  return projectId
}

const setProjectMediaFolder = definePlatformTool({
  name: 'set_project_media_folder',
  title: 'Set project media folder',
  description:
    'Set the project folder used for locating linked media, from a development local path or a confirmed browser directory picker.',
  inputSchema: objectSchema({
    projectId: { type: 'string' },
    path: { type: 'string' },
  }),
  handoff: true,
  schema: z.object({
    projectId: z.string().min(1).optional(),
    path: z.string().trim().min(1).optional(),
  }),
  summarize: ({ path }) =>
    path ? `Set project media folder to ${path}` : 'Choose project media folder',
  execute: async ({ projectId, path }) => {
    const project = await resolveProject(projectId)
    let handle: FileSystemDirectoryHandle

    if (path) {
      handle = await createDevMediaDirectoryHandle(path)
    } else {
      if (typeof window.showDirectoryPicker !== 'function') {
        return {
          ok: false,
          message: 'This browser does not support choosing a project media folder.',
          error: {
            code: 'MEDIA_FOLDER_PICKER_UNAVAILABLE',
            message: 'The File System Access directory picker is unavailable.',
          },
          changed: false,
        }
      }
      try {
        handle = await window.showDirectoryPicker({
          id: 'freecut-project-media-folder',
          mode: 'read',
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return {
            ok: true,
            message: 'Project media folder selection was cancelled.',
            data: { projectId: project.id, cancelled: true },
            changed: false,
          }
        }
        return {
          ok: false,
          message: 'The project media folder picker requires direct user confirmation.',
          error: {
            code: 'MEDIA_FOLDER_PICKER_USER_GESTURE_REQUIRED',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
          changed: false,
        }
      }
    }

    const changed = !(await isSameDirectory(project.rootFolderHandle, handle))
    if (changed) {
      await useProjectStore.getState().setProjectRootFolder(project.id, handle)
    }
    return {
      ok: true,
      message: changed
        ? `Set project media folder to "${handle.name}".`
        : `Project media folder is already "${handle.name}".`,
      data: {
        projectId: project.id,
        folderName: handle.name,
        path: path ?? null,
      },
      changed,
    }
  },
})

const relinkMediaFolder = definePlatformTool({
  name: 'relink_media_folder',
  title: 'Relink media from folder',
  description:
    'Scan media health, search a local or configured project folder, and batch relink broken media by file name and file size when needed.',
  inputSchema: objectSchema({
    projectId: { type: 'string' },
    path: { type: 'string' },
    recursive: { type: 'boolean', default: true },
  }),
  schema: z.object({
    projectId: z.string().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    recursive: z.boolean().optional(),
  }),
  summarize: ({ path }) =>
    path ? `Relink media from ${path}` : 'Relink media from project folder',
  execute: async ({ projectId, path, recursive = true }) => {
    const scanResult = await scanMediaHealthTool.execute({ projectId })
    if (!scanResult.ok) return { ...scanResult, changed: false }

    const resolvedProjectId = useMediaLibraryStore.getState().currentProjectId
    if (!resolvedProjectId) throw new Error('Media health scan did not resolve a project.')
    const broken = brokenMediaTargets()
    if (broken.length === 0) {
      return {
        ok: true,
        message: 'No broken media needs relinking.',
        data: {
          projectId: resolvedProjectId,
          success: [],
          failed: [],
          unmatched: [],
        },
        changed: false,
      }
    }

    let files: FileSystemFileHandle[]
    let folderName: string
    if (path) {
      files = await getDevLocalMediaHandles(path, { recursive })
      folderName = localDirectoryName(path)
    } else {
      const project = await resolveProject(resolvedProjectId)
      const directory = project.rootFolderHandle
      if (!directory) {
        return {
          ok: false,
          message: 'Set a project media folder or provide a development local path first.',
          data: { projectId: resolvedProjectId },
          error: {
            code: 'PROJECT_MEDIA_FOLDER_NOT_SET',
            message: 'The project has no media folder handle.',
            retryable: true,
          },
          changed: false,
        }
      }
      const currentPermission = await directory.queryPermission({ mode: 'read' })
      const permission =
        currentPermission === 'granted'
          ? currentPermission
          : await directory.requestPermission({ mode: 'read' })
      if (permission !== 'granted') {
        return {
          ok: false,
          message: `Read permission is required for project media folder "${directory.name}".`,
          data: {
            projectId: resolvedProjectId,
            folderName: directory.name,
            permission,
          },
          error: {
            code: 'MEDIA_FOLDER_PERMISSION_REQUIRED',
            message: 'The browser did not grant read permission for the project media folder.',
            retryable: true,
          },
          changed: false,
        }
      }
      files = await collectDirectoryFiles(directory, recursive)
      folderName = directory.name
    }

    const { relinks, unmatched } = await matchBrokenMedia(broken, files)
    const { success, failed } =
      relinks.length > 0
        ? await useMediaLibraryStore.getState().relinkMediaBatch(relinks)
        : { success: [], failed: [] }
    const ok = failed.length === 0

    return {
      ok,
      message: `Relinked ${success.length} media item${success.length === 1 ? '' : 's'} from "${folderName}"; ${failed.length} failed and ${unmatched.length} unmatched.`,
      data: {
        projectId: resolvedProjectId,
        folderName,
        path: path ?? null,
        recursive,
        scannedFileCount: files.length,
        success,
        failed,
        unmatched,
      },
      changed: success.length > 0,
      ...(ok
        ? {}
        : {
            error: {
              code: 'MEDIA_RELINK_PARTIAL',
              message: 'One or more matched media files could not be relinked.',
              retryable: true,
            },
          }),
    }
  },
})

const requestMediaPermissions = definePlatformTool({
  name: 'request_media_permissions',
  title: 'Request media permissions',
  description:
    'Request browser read permission for selected media handles, or all current broken media whose permission expired.',
  inputSchema: objectSchema({
    mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
  }),
  handoff: true,
  schema: z.object({
    mediaIds: z.array(z.string().min(1)).min(1).optional(),
  }),
  summarize: ({ mediaIds }) =>
    mediaIds
      ? `Request permission for ${mediaIds.length} media item(s)`
      : 'Request media permissions',
  execute: async ({ mediaIds }) => {
    const projectId = await ensureCurrentMediaProject()
    const initialState = useMediaLibraryStore.getState()
    const defaultIds = initialState.brokenMediaIds.filter(
      (mediaId) =>
        initialState.brokenMediaInfo.get(mediaId)?.errorType === 'permission_denied' &&
        !!initialState.mediaById[mediaId],
    )
    const targetIds = [...new Set(mediaIds ?? defaultIds)]
    const notFound = targetIds.filter((mediaId) => !initialState.mediaById[mediaId])
    const existingIds = targetIds.filter((mediaId) => !!initialState.mediaById[mediaId])

    if (targetIds.length === 0) {
      return {
        ok: true,
        message: 'No media permission requests are needed.',
        data: {
          projectId,
          granted: [],
          denied: [],
          failed: [],
          notFound: [],
        },
        changed: false,
      }
    }

    const permissionBrokenIds = new Set(
      existingIds.filter(
        (mediaId) => initialState.brokenMediaInfo.get(mediaId)?.errorType === 'permission_denied',
      ),
    )
    const { mediaLibraryService } = await importMediaLibraryService()
    const granted: string[] = []
    const denied: string[] = []
    const failed: string[] = []
    const failureMessages: Record<string, string> = {}
    const repaired: string[] = []

    for (const mediaId of existingIds) {
      try {
        if (await mediaLibraryService.requestPermission(mediaId)) {
          granted.push(mediaId)
          if (permissionBrokenIds.has(mediaId)) {
            useMediaLibraryStore.getState().markMediaHealthy(mediaId)
            repaired.push(mediaId)
          }
        } else {
          denied.push(mediaId)
        }
      } catch (error) {
        failed.push(mediaId)
        failureMessages[mediaId] = error instanceof Error ? error.message : String(error)
      }
    }

    const ok = denied.length === 0 && failed.length === 0 && notFound.length === 0
    return {
      ok,
      message: `Media permission requests completed: ${granted.length} granted, ${denied.length} denied, ${failed.length} failed, and ${notFound.length} not found.`,
      data: {
        projectId,
        granted,
        denied,
        failed,
        notFound,
        failureMessages,
      },
      changed: repaired.length > 0,
      ...(ok
        ? {}
        : {
            error: {
              code:
                granted.length > 0
                  ? 'MEDIA_PERMISSION_PARTIAL'
                  : failed.length > 0
                    ? 'MEDIA_PERMISSION_REQUEST_FAILED'
                    : denied.length > 0
                      ? 'MEDIA_PERMISSION_DENIED'
                      : 'MEDIA_NOT_FOUND',
              message: 'One or more media permissions were not restored.',
              retryable: denied.length > 0 || failed.length > 0,
            },
          }),
    }
  },
})

export const MEDIA_RELINK_PLATFORM_TOOLS = [
  setProjectMediaFolder,
  relinkMediaFolder,
  requestMediaPermissions,
] as const
