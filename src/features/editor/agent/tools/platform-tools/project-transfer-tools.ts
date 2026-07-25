import { z } from 'zod'
import {
  importBundleExportService,
  importBundleImportService,
  importJsonExportService,
  importJsonImportService,
} from '@/features/editor/deps/project-bundle'
import { getProject, useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineStore } from '@/features/editor/deps/timeline-contract'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import { requireWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { definePlatformTool, objectSchema } from './shared'

function safeFileName(value: string | undefined, fallback: string, extension: string): string {
  const printable = [...(value?.trim() || fallback)]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
  const base = printable.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '')
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`
}

function relativeDirectorySegments(path: string): string[] {
  const segments = path
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Workspace destination must be a relative directory path.')
  }
  return segments
}

async function getWorkspaceDirectory(path: string): Promise<FileSystemDirectoryHandle> {
  let directory = requireWorkspaceRoot()
  for (const segment of relativeDirectorySegments(path)) {
    directory = await directory.getDirectoryHandle(segment, { create: true })
  }
  return directory
}

async function writeWorkspaceFile(
  directoryPath: string,
  fileName: string,
  data: Blob | string,
): Promise<string> {
  const directory = await getWorkspaceDirectory(directoryPath)
  const fileHandle = await directory.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(data)
  await writable.close()
  return `${directoryPath.replace(/\\/g, '/')}/${fileName}`
}

async function resolveSingleLocalFile(path: string, suffixes: readonly string[]): Promise<File> {
  const handles = await getDevLocalMediaHandles(path)
  const matches = handles.filter((handle) =>
    suffixes.some((suffix) => handle.name.toLowerCase().endsWith(suffix)),
  )
  if (matches.length === 0) {
    throw new Error(`No supported project file was found at ${path}.`)
  }
  if (matches.length > 1) {
    throw new Error(`The path contains multiple supported project files: ${path}`)
  }
  return matches[0]!.getFile()
}

const exportProjectSnapshot = definePlatformTool({
  name: 'export_project_snapshot',
  requiresProject: false,
  title: 'Export project snapshot',
  description:
    'Export a complete FreeCut project structure as JSON, either in the tool result or into the workspace.',
  inputSchema: objectSchema(
    {
      projectId: { type: 'string' },
      destination: { type: 'string', enum: ['workspace', 'result'] },
      fileName: { type: 'string' },
      includeMediaReferences: { type: 'boolean' },
      includeChecksum: { type: 'boolean' },
      stripVolatileFields: { type: 'boolean' },
    },
    ['projectId'],
  ),
  schema: z.object({
    projectId: z.string().min(1),
    destination: z.enum(['workspace', 'result']).optional(),
    fileName: z.string().trim().min(1).max(240).optional(),
    includeMediaReferences: z.boolean().optional(),
    includeChecksum: z.boolean().optional(),
    stripVolatileFields: z.boolean().optional(),
  }),
  summarize: ({ projectId }) => `Export project snapshot ${projectId}`,
  execute: async ({
    projectId,
    destination = 'workspace',
    fileName,
    includeMediaReferences = true,
    includeChecksum = true,
    stripVolatileFields = false,
  }) => {
    const { exportProjectJson } = await importJsonExportService()
    const snapshot = await exportProjectJson(projectId, {
      includeMediaReferences,
      includeChecksum,
      stripVolatileFields,
    })
    if (destination === 'result') {
      return {
        ok: true,
        message: `Exported project snapshot "${snapshot.project.name}" in the tool result.`,
        data: { snapshot },
        changed: false,
      }
    }

    const outputName = safeFileName(fileName, snapshot.project.name, '.freecut.json')
    const relativePath = await writeWorkspaceFile(
      'exports/project-snapshots',
      outputName,
      JSON.stringify(snapshot, null, 2),
    )
    return {
      ok: true,
      message: `Exported project snapshot to ${relativePath}.`,
      data: { projectId, fileName: outputName, relativePath },
      changed: true,
    }
  },
})

const importProjectSnapshot = definePlatformTool({
  name: 'import_project_snapshot',
  requiresProject: false,
  title: 'Import project snapshot',
  description:
    'Import a FreeCut project JSON snapshot from an absolute local path or a JSON string.',
  inputSchema: objectSchema({
    path: { type: 'string' },
    json: { type: 'string' },
    newProjectName: { type: 'string' },
    matchMediaByHash: { type: 'boolean' },
    matchMediaByName: { type: 'boolean' },
  }),
  schema: z
    .object({
      path: z.string().trim().min(1).optional(),
      json: z.string().min(1).optional(),
      newProjectName: z.string().trim().min(1).max(100).optional(),
      matchMediaByHash: z.boolean().optional(),
      matchMediaByName: z.boolean().optional(),
    })
    .refine(({ path, json }) => Number(!!path) + Number(!!json) === 1, {
      message: 'Provide exactly one of path or json.',
    }),
  summarize: ({ path }) => `Import project snapshot${path ? ` from ${path}` : ''}`,
  execute: async ({
    path,
    json,
    newProjectName,
    matchMediaByHash = true,
    matchMediaByName = true,
  }) => {
    const source =
      json ??
      (await resolveSingleLocalFile(path!, ['.freecut.json', '.json'])).text()
    const jsonText = typeof source === 'string' ? source : await source
    const { importProjectFromJsonString } = await importJsonImportService()
    const result = await importProjectFromJsonString(jsonText, {
      generateNewIds: true,
      newProjectName,
      matchMediaByHash,
      matchMediaByName,
    })
    await useProjectStore.getState().loadProjects()
    return {
      ok: true,
      message: `Imported project snapshot as "${result.project.name}".`,
      data: {
        projectId: result.project.id,
        projectName: result.project.name,
        matchedMedia: result.matchedMedia,
        unmatchedMedia: result.unmatchedMedia,
        warnings: result.warnings,
      },
      changed: true,
    }
  },
})

const exportProjectBundle = definePlatformTool({
  name: 'export_project_bundle',
  requiresProject: false,
  title: 'Export project bundle',
  description:
    'Save the latest project state and export a complete .freecut.zip bundle with all associated media into the workspace.',
  inputSchema: objectSchema(
    {
      projectId: { type: 'string' },
      fileName: { type: 'string' },
    },
    ['projectId'],
  ),
  schema: z.object({
    projectId: z.string().min(1),
    fileName: z.string().trim().min(1).max(240).optional(),
  }),
  summarize: ({ projectId }) => `Export project bundle ${projectId}`,
  execute: async ({ projectId, fileName }) => {
    const project = await getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (useProjectStore.getState().currentProject?.id === projectId) {
      await useTimelineStore.getState().saveTimeline(projectId)
    }

    const outputName = safeFileName(fileName, project.name, '.freecut.zip')
    const directory = await getWorkspaceDirectory('exports/project-bundles')
    const fileHandle = await directory.getFileHandle(outputName, { create: true })
    const { exportProjectBundleStreaming } = await importBundleExportService()
    const result = await exportProjectBundleStreaming(projectId, fileHandle)
    const relativePath = `exports/project-bundles/${outputName}`
    return {
      ok: true,
      message: `Exported project bundle to ${relativePath}.`,
      data: {
        projectId,
        fileName: outputName,
        relativePath,
        size: result.size,
        mediaCount: result.mediaCount,
      },
      changed: true,
    }
  },
})

const importProjectBundle = definePlatformTool({
  name: 'import_project_bundle',
  requiresProject: false,
  title: 'Import project bundle',
  description:
    'Import a complete .freecut.zip project bundle from an absolute local path and extract its media into the workspace.',
  inputSchema: objectSchema(
    {
      path: { type: 'string' },
      newProjectName: { type: 'string' },
      destinationFolder: { type: 'string' },
    },
    ['path'],
  ),
  schema: z.object({
    path: z.string().trim().min(1),
    newProjectName: z.string().trim().min(1).max(100).optional(),
    destinationFolder: z.string().trim().min(1).max(240).optional(),
  }),
  summarize: ({ path }) => `Import project bundle from ${path}`,
  execute: async ({ path, newProjectName, destinationFolder = 'imports' }) => {
    const file = await resolveSingleLocalFile(path, ['.freecut.zip'])
    const destination = await getWorkspaceDirectory(destinationFolder)
    const { importProjectBundle: importBundle } = await importBundleImportService()
    const result = await importBundle(file, destination, { newProjectName })
    await useProjectStore.getState().loadProjects()
    return {
      ok: true,
      message: `Imported project bundle as "${result.project.name}".`,
      data: {
        projectId: result.project.id,
        projectName: result.project.name,
        mediaImported: result.mediaImported,
        mediaSkipped: result.mediaSkipped,
        conflicts: result.conflicts,
        destinationFolder,
      },
      changed: true,
    }
  },
})

export const PROJECT_TRANSFER_PLATFORM_TOOLS = [
  exportProjectSnapshot,
  importProjectSnapshot,
  exportProjectBundle,
  importProjectBundle,
] as const
