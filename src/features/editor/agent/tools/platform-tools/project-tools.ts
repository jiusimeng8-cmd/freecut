import { z } from 'zod'
import {
  commitProjectMetadataChange,
  createProjectObject,
  createProjectRecord,
  getAllProjects,
  getProject,
  isAllowedProjectFps,
  listTrashedProjects,
  useProjectStore,
} from '@/features/editor/deps/projects'
import { useTimelineSettingsStore } from '@/features/editor/deps/timeline-contract'
import type { Project } from '@/types/project'
import { definePlatformTool, objectSchema } from './shared'

function summarizeProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    metadata: project.metadata,
    duration: project.duration,
    schemaVersion: project.schemaVersion,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function navigateTo(detail: { to: 'projects' } | { to: 'editor'; projectId: string }): void {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('freecut:navigate', { detail }))
  }, 250)
}

const projectFieldsSchema = {
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  width: z.number().int().min(320).max(7680).optional(),
  height: z.number().int().min(240).max(4320).optional(),
  fps: z.number().int().refine(isAllowedProjectFps, 'Unsupported project FPS.').optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}

const listProjects = definePlatformTool({
  name: 'list_projects',
  requiresProject: false,
  title: 'List projects',
  description: 'List FreeCut projects and optionally include projects in the workspace trash.',
  inputSchema: objectSchema({
    includeTrashed: { type: 'boolean' },
  }),
  readOnly: true,
  schema: z.object({ includeTrashed: z.boolean().optional() }),
  summarize: () => 'List FreeCut projects',
  execute: async ({ includeTrashed = false }) => {
    const projects = await getAllProjects()
    const live = projects.map((project) => ({
      ...summarizeProject(project),
      trashed: false,
    }))
    const trashed = includeTrashed
      ? (await listTrashedProjects()).map((entry) => ({
          id: entry.id,
          name: entry.marker.originalName,
          trashed: true,
          deletedAt: entry.marker.deletedAt,
        }))
      : []
    return {
      ok: true,
      message: `Found ${live.length} live project${live.length === 1 ? '' : 's'}${includeTrashed ? ` and ${trashed.length} trashed` : ''}.`,
      data: { projects: live, trashed },
    }
  },
})

const createProject = definePlatformTool({
  name: 'create_project',
  requiresProject: false,
  title: 'Create project',
  description:
    'Create a new local FreeCut project without replacing the project currently open in the editor.',
  inputSchema: objectSchema(
    {
      name: { type: 'string' },
      description: { type: 'string' },
      width: { type: 'number', minimum: 320, maximum: 7680 },
      height: { type: 'number', minimum: 240, maximum: 4320 },
      fps: { type: 'number', enum: [24, 25, 30, 50, 60, 120, 240] },
      backgroundColor: { type: 'string' },
    },
    ['name', 'width', 'height', 'fps'],
  ),
  schema: z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).optional(),
    width: z.number().int().min(320).max(7680),
    height: z.number().int().min(240).max(4320),
    fps: z.number().int().refine(isAllowedProjectFps, 'Unsupported project FPS.'),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }),
  summarize: ({ name }) => `Create project "${name}"`,
  execute: async ({ name, description, width, height, fps, backgroundColor }) => {
    const project = createProjectObject({ name, description, width, height, fps })
    if (backgroundColor) {
      project.metadata.backgroundColor = backgroundColor
    }
    const created = await createProjectRecord(project)
    await useProjectStore.getState().loadProjects()
    return {
      ok: true,
      message: `Created project "${created.name}".`,
      data: summarizeProject(created),
      changed: true,
    }
  },
})

const openProject = definePlatformTool({
  name: 'open_project',
  requiresProject: false,
  title: 'Open project',
  description: 'Open an existing FreeCut project in the editor.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }, ['projectId']),
  schema: z.object({ projectId: z.string().min(1) }),
  summarize: ({ projectId }) => `Open project ${projectId}`,
  execute: async ({ projectId }) => {
    const project = await getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const route = `/editor/${encodeURIComponent(projectId)}`
    navigateTo({ to: 'editor', projectId })
    return {
      ok: true,
      message: `Opening project "${project.name}".`,
      data: { project: summarizeProject(project), route },
      changed: false,
    }
  },
})

const openProjects = definePlatformTool({
  name: 'open_projects',
  requiresProject: false,
  title: 'Open projects',
  description: 'Leave the editor and open the FreeCut projects page.',
  inputSchema: objectSchema({}),
  schema: z.object({}),
  summarize: () => 'Open projects page',
  execute: () => {
    navigateTo({ to: 'projects' })
    return {
      ok: true,
      message: 'Opening the projects page.',
      data: { route: '/projects' },
      changed: false,
    }
  },
})

const updateProject = definePlatformTool({
  name: 'update_project',
  requiresProject: false,
  title: 'Update project',
  description:
    'Update project identity or canvas metadata. Canvas changes on the open project enter the timeline undo stack.',
  inputSchema: objectSchema(
    {
      projectId: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      width: { type: 'number', minimum: 320, maximum: 7680 },
      height: { type: 'number', minimum: 240, maximum: 4320 },
      fps: { type: 'number', enum: [24, 25, 30, 50, 60, 120, 240] },
      backgroundColor: { type: 'string' },
    },
    ['projectId'],
  ),
  schema: z
    .object({
      projectId: z.string().min(1),
      ...projectFieldsSchema,
    })
    .refine(
      ({ projectId: _projectId, ...updates }) =>
        Object.values(updates).some((value) => value !== undefined),
      'At least one project field is required.',
    ),
  summarize: ({ projectId }) => `Update project ${projectId}`,
  execute: async ({ projectId, name, description, width, height, fps, backgroundColor }) => {
    const store = useProjectStore.getState()
    if (!store.projects.some((project) => project.id === projectId)) {
      await store.loadProjects()
    }
    let project =
      useProjectStore.getState().projects.find((candidate) => candidate.id === projectId) ??
      (useProjectStore.getState().currentProject?.id === projectId
        ? useProjectStore.getState().currentProject
        : null)
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const identityUpdates = {
      ...(name !== undefined && name !== project.name ? { name } : {}),
      ...(description !== undefined && description !== project.description ? { description } : {}),
    }
    if (Object.keys(identityUpdates).length > 0) {
      project = await useProjectStore.getState().updateProject(projectId, identityUpdates)
    }

    const metadataUpdates = {
      ...(width !== undefined && width !== project.metadata.width ? { width } : {}),
      ...(height !== undefined && height !== project.metadata.height ? { height } : {}),
      ...(fps !== undefined && fps !== project.metadata.fps ? { fps } : {}),
      ...(backgroundColor !== undefined &&
      backgroundColor !== (project.metadata.backgroundColor ?? '#000000')
        ? { backgroundColor }
        : {}),
    }
    if (Object.keys(metadataUpdates).length > 0) {
      if (useProjectStore.getState().currentProject?.id === projectId) {
        const committed = await commitProjectMetadataChange({
          project,
          updates: metadataUpdates,
          command: {
            type: 'AGENT_UPDATE_PROJECT_METADATA',
            payload: { fields: Object.keys(metadataUpdates) },
          },
          updateProject: useProjectStore.getState().updateProject,
          markDirty: useTimelineSettingsStore.getState().markDirty,
          onApplied: (updatedProject) => {
            if (fps !== undefined) {
              useTimelineSettingsStore.getState().setFps(updatedProject.metadata.fps)
            }
          },
        })
        project = committed ?? project
      } else {
        project = await useProjectStore.getState().updateProject(projectId, metadataUpdates)
      }
    }

    const changed =
      Object.keys(identityUpdates).length > 0 || Object.keys(metadataUpdates).length > 0
    return {
      ok: true,
      message: changed ? `Updated project "${project.name}".` : 'Project was already up to date.',
      data: summarizeProject(project),
      changed,
    }
  },
})

const duplicateProject = definePlatformTool({
  name: 'duplicate_project',
  requiresProject: false,
  title: 'Duplicate project',
  description:
    'Create a complete local project copy for a baseline or new version, including timeline and media associations.',
  inputSchema: objectSchema(
    {
      projectId: { type: 'string' },
      name: { type: 'string' },
    },
    ['projectId'],
  ),
  schema: z.object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(100).optional(),
  }),
  summarize: ({ projectId }) => `Duplicate project ${projectId}`,
  execute: async ({ projectId, name }) => {
    const store = useProjectStore.getState()
    if (!store.projects.some((project) => project.id === projectId)) {
      await store.loadProjects()
    }
    let duplicate = await useProjectStore.getState().duplicateProject(projectId)
    if (name && name !== duplicate.name) {
      duplicate = await useProjectStore.getState().updateProject(duplicate.id, { name })
    }
    return {
      ok: true,
      message: `Duplicated project as "${duplicate.name}".`,
      data: summarizeProject(duplicate),
      changed: true,
    }
  },
})

const trashProject = definePlatformTool({
  name: 'trash_project',
  requiresProject: false,
  title: 'Move project to trash',
  description:
    'Soft-delete a closed project into the FreeCut workspace trash. Optional local-folder deletion is irreversible.',
  inputSchema: objectSchema(
    {
      projectId: { type: 'string' },
      clearLocalFiles: { type: 'boolean' },
    },
    ['projectId'],
  ),
  destructive: true,
  schema: z.object({
    projectId: z.string().min(1),
    clearLocalFiles: z.boolean().optional(),
  }),
  summarize: ({ projectId }) => `Move project ${projectId} to trash`,
  execute: async ({ projectId, clearLocalFiles = false }) => {
    if (useProjectStore.getState().currentProject?.id === projectId) {
      throw new Error('The currently open project cannot be trashed.')
    }
    if ((await listTrashedProjects()).some((entry) => entry.id === projectId)) {
      return {
        ok: true,
        message: `Project ${projectId} is already in the trash.`,
        data: { projectId, trashed: true },
        changed: false,
      }
    }
    const store = useProjectStore.getState()
    if (!store.projects.some((project) => project.id === projectId)) {
      await store.loadProjects()
    }
    const result = await useProjectStore.getState().deleteProject(projectId, clearLocalFiles)
    return {
      ok: true,
      message: `Moved project "${result.originalName}" to the trash.`,
      data: { projectId, ...result },
      changed: true,
    }
  },
})

const restoreProject = definePlatformTool({
  name: 'restore_project',
  requiresProject: false,
  title: 'Restore project',
  description: 'Restore a soft-deleted project from the FreeCut workspace trash.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }, ['projectId']),
  schema: z.object({ projectId: z.string().min(1) }),
  summarize: ({ projectId }) => `Restore project ${projectId}`,
  execute: async ({ projectId }) => {
    if (!(await listTrashedProjects()).some((entry) => entry.id === projectId)) {
      return {
        ok: true,
        message: `Project ${projectId} is not in the trash.`,
        data: { projectId },
        changed: false,
      }
    }
    await useProjectStore.getState().restoreProject(projectId)
    return {
      ok: true,
      message: `Restored project ${projectId}.`,
      data: { projectId },
      changed: true,
    }
  },
})

const deleteProjectForever = definePlatformTool({
  name: 'delete_project_forever',
  requiresProject: false,
  title: 'Permanently delete project',
  description: 'Permanently delete one project already in the workspace trash.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }, ['projectId']),
  destructive: true,
  schema: z.object({ projectId: z.string().min(1) }),
  summarize: ({ projectId }) => `Permanently delete project ${projectId}`,
  execute: async ({ projectId }) => {
    if (!(await listTrashedProjects()).some((entry) => entry.id === projectId)) {
      throw new Error(`Project is not in the trash: ${projectId}`)
    }
    await useProjectStore.getState().permanentlyDeleteProject(projectId)
    return {
      ok: true,
      message: `Permanently deleted project ${projectId}.`,
      data: { projectId },
      changed: true,
    }
  },
})

const emptyProjectTrash = definePlatformTool({
  name: 'empty_project_trash',
  requiresProject: false,
  title: 'Empty project trash',
  description: 'Permanently delete every project currently in the FreeCut workspace trash.',
  inputSchema: objectSchema({}),
  destructive: true,
  schema: z.object({}),
  summarize: () => 'Empty project trash',
  execute: async () => {
    const entries = await listTrashedProjects()
    for (const entry of entries) {
      await useProjectStore.getState().permanentlyDeleteProject(entry.id)
    }
    return {
      ok: true,
      message:
        entries.length === 0
          ? 'The project trash was already empty.'
          : `Permanently deleted ${entries.length} trashed project${entries.length === 1 ? '' : 's'}.`,
      data: { deletedProjectIds: entries.map((entry) => entry.id) },
      changed: entries.length > 0,
    }
  },
})

export const PROJECT_PLATFORM_TOOLS = [
  listProjects,
  createProject,
  openProject,
  openProjects,
  updateProject,
  duplicateProject,
  trashProject,
  restoreProject,
  deleteProjectForever,
  emptyProjectTrash,
] as const
