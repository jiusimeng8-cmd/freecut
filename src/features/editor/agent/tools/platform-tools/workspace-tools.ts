import { z } from 'zod'
import {
  activateWorkspaceHandle,
  getWorkspaceHandleRecord,
  listKnownWorkspaces,
  queryHandlePermission,
  removeKnownWorkspace,
  requestHandlePermission,
  saveWorkspaceHandleRecord,
} from '@/infrastructure/storage/handles-db'
import { getWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { definePlatformTool, objectSchema } from './shared'

function reloadWorkspace(): void {
  window.setTimeout(() => window.location.reload(), 250)
}

async function workspaceEntries() {
  const [known, current] = await Promise.all([
    listKnownWorkspaces(),
    getWorkspaceHandleRecord(),
  ])
  const entries = await Promise.all(
    known.map(async (record) => ({
      id: record.id,
      name: record.name,
      pickedAt: record.pickedAt,
      active: record.id === current?.activeWorkspaceId,
      permission: await queryHandlePermission(record.handle),
    })),
  )
  return { current, entries }
}

const readWorkspace = definePlatformTool({
  name: 'read_workspace',
  requiresProject: false,
  title: 'Read workspace',
  description:
    'Read the active FreeCut workspace folder, known workspace handles, permissions, and reload requirements.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut workspace',
  execute: async () => {
    const { current, entries } = await workspaceEntries()
    const activeRoot = getWorkspaceRoot()
    return {
      ok: true,
      message: activeRoot
        ? `Active workspace is "${activeRoot.name}".`
        : 'No active workspace root is connected.',
      data: {
        active: activeRoot
          ? {
              id: current?.activeWorkspaceId ?? null,
              name: activeRoot.name,
              persistedHandle: !!current,
            }
          : null,
        workspaces: entries,
      },
    }
  },
})

const addWorkspace = definePlatformTool({
  name: 'add_workspace',
  requiresProject: false,
  title: 'Add workspace',
  description:
    'Open the browser folder picker from a confirmed user action, register the selected read/write workspace, and reload FreeCut.',
  inputSchema: objectSchema({}),
  handoff: true,
  schema: z.object({}),
  summarize: () => 'Choose and add a FreeCut workspace folder',
  execute: async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      return {
        ok: false,
        message: 'This browser does not support choosing a workspace folder.',
        error: {
          code: 'WORKSPACE_PICKER_UNAVAILABLE',
          message: 'The File System Access directory picker is unavailable.',
        },
        changed: false,
      }
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: 'freecut-workspace',
        mode: 'readwrite',
        startIn: 'documents',
      })
      const existing = await queryHandlePermission(handle)
      const permission =
        existing === 'granted' ? existing : await requestHandlePermission(handle)
      if (permission !== 'granted') {
        return {
          ok: false,
          message: `Workspace "${handle.name}" requires read/write permission.`,
          data: { name: handle.name, permission },
          error: {
            code: 'WORKSPACE_PERMISSION_REQUIRED',
            message: 'The browser did not grant read/write permission for this workspace.',
            retryable: true,
          },
          changed: false,
        }
      }
      await saveWorkspaceHandleRecord(handle)
      reloadWorkspace()
      return {
        ok: true,
        message: `Added workspace "${handle.name}" and scheduled a reload.`,
        data: { name: handle.name, reloadScheduled: true },
        changed: true,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          ok: true,
          message: 'Workspace selection was cancelled.',
          data: { cancelled: true },
          changed: false,
        }
      }
      return {
        ok: false,
        message: 'The workspace folder picker must be opened from a direct user confirmation.',
        error: {
          code: 'WORKSPACE_PICKER_USER_GESTURE_REQUIRED',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        changed: false,
      }
    }
  },
})

const switchWorkspace = definePlatformTool({
  name: 'switch_workspace',
  requiresProject: false,
  title: 'Switch workspace',
  description:
    'Activate a previously known FreeCut workspace and reload the application so all stores reopen from it.',
  handoff: true,
  inputSchema: objectSchema({ workspaceId: { type: 'string' } }, ['workspaceId']),
  schema: z.object({ workspaceId: z.string().min(1) }),
  summarize: ({ workspaceId }) => `Switch workspace to ${workspaceId}`,
  execute: async ({ workspaceId }) => {
    const record = await activateWorkspaceHandle(workspaceId)
    if (!record) throw new Error(`Workspace not found: ${workspaceId}`)
    const permission = await queryHandlePermission(record.handle)
    const granted =
      permission === 'granted' ? permission : await requestHandlePermission(record.handle)
    if (granted !== 'granted') {
      return {
        ok: false,
        message: `Workspace "${record.name}" requires user permission before it can be opened.`,
        data: { workspaceId, name: record.name, permission: granted },
        error: {
          code: 'WORKSPACE_PERMISSION_REQUIRED',
          message: 'The browser did not grant read/write permission for this workspace.',
          retryable: true,
        },
        changed: false,
      }
    }
    reloadWorkspace()
    return {
      ok: true,
      message: `Switching to workspace "${record.name}".`,
      data: { workspaceId, name: record.name, reloadScheduled: true },
      changed: true,
    }
  },
})

const reconnectWorkspace = definePlatformTool({
  name: 'reconnect_workspace',
  requiresProject: false,
  title: 'Reconnect workspace',
  description:
    'Request read/write permission for the currently selected workspace and reload FreeCut after permission is restored.',
  handoff: true,
  inputSchema: objectSchema({}),
  schema: z.object({}),
  summarize: () => 'Reconnect active workspace',
  execute: async () => {
    const current = await getWorkspaceHandleRecord()
    if (!current) throw new Error('No persisted workspace handle is available to reconnect.')
    const permission = await requestHandlePermission(current.handle)
    if (permission !== 'granted') {
      return {
        ok: false,
        message: `Permission was not granted for workspace "${current.name}".`,
        data: { name: current.name, permission },
        error: {
          code: 'WORKSPACE_PERMISSION_REQUIRED',
          message: 'The workspace permission request was denied or dismissed.',
          retryable: true,
        },
        changed: false,
      }
    }
    reloadWorkspace()
    return {
      ok: true,
      message: `Reconnected workspace "${current.name}".`,
      data: {
        workspaceId: current.activeWorkspaceId ?? null,
        name: current.name,
        reloadScheduled: true,
      },
      changed: true,
    }
  },
})

const removeWorkspace = definePlatformTool({
  name: 'remove_workspace',
  requiresProject: false,
  title: 'Remove workspace',
  description:
    'Forget one known workspace handle. This does not delete any files in the workspace folder.',
  inputSchema: objectSchema({ workspaceId: { type: 'string' } }, ['workspaceId']),
  destructive: true,
  schema: z.object({ workspaceId: z.string().min(1) }),
  summarize: ({ workspaceId }) => `Forget workspace ${workspaceId}`,
  execute: async ({ workspaceId }) => {
    const { current, entries } = await workspaceEntries()
    const target = entries.find((entry) => entry.id === workspaceId)
    if (!target) {
      return {
        ok: true,
        message: `Workspace ${workspaceId} was already absent.`,
        data: { workspaceId },
        changed: false,
      }
    }
    const wasActive = current?.activeWorkspaceId === workspaceId
    await removeKnownWorkspace(workspaceId)
    if (wasActive) reloadWorkspace()
    return {
      ok: true,
      message: `Forgot workspace "${target.name}" without deleting its files.`,
      data: { workspaceId, name: target.name, wasActive, reloadScheduled: wasActive },
      changed: true,
    }
  },
})

export const WORKSPACE_PLATFORM_TOOLS = [
  readWorkspace,
  addWorkspace,
  switchWorkspace,
  reconnectWorkspace,
  removeWorkspace,
] as const
