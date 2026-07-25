import { z } from 'zod'
import { definePlatformTool, objectSchema } from './shared'

function requireDesktop() {
  const desktop = window.freecutDesktop
  if (!desktop) throw new Error('This FreeCut tool requires the desktop application.')
  return desktop
}

const readAppRuntime = definePlatformTool({
  name: 'read_app_runtime',
  requiresProject: false,
  title: 'Read application runtime',
  description:
    'Read the current FreeCut application version, platform, update state, and local Agent Runtime status.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut application runtime',
  execute: async () => {
    const desktop = window.freecutDesktop
    if (!desktop) {
      return {
        ok: true,
        message: 'Read FreeCut web runtime.',
        data: {
          runtime: 'web',
          platform: navigator.platform,
          desktop: false,
        },
      }
    }

    const [version, platform, update, agentRuntime] = await Promise.all([
      desktop.app.getVersion(),
      desktop.app.getPlatform(),
      desktop.updates.getStatus(),
      desktop.agentRuntime.getInfo(),
    ])
    return {
      ok: true,
      message: `Read FreeCut Desktop ${version} runtime.`,
      data: {
        runtime: 'desktop',
        desktop: true,
        version,
        platform,
        update,
        agentRuntime,
      },
    }
  },
})

const readBackgroundTasks = definePlatformTool({
  name: 'read_background_tasks',
  requiresProject: false,
  title: 'Read background tasks',
  description:
    'List FreeCut desktop export, media processing, transcription, analysis, and Bridge tasks with their current status.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut background tasks',
  execute: async () => {
    const tasks = await requireDesktop().tasks.list()
    return {
      ok: true,
      message: `Read ${tasks.length} FreeCut background task${tasks.length === 1 ? '' : 's'}.`,
      data: { tasks },
    }
  },
})

const backgroundTaskActionSchema = z.object({
  taskId: z.string().trim().min(1),
  operation: z.enum(['resume', 'cancel']),
})

const manageBackgroundTask = definePlatformTool({
  name: 'manage_background_task',
  requiresProject: false,
  title: 'Manage background task',
  description: 'Resume or cancel one persisted FreeCut desktop background task.',
  inputSchema: objectSchema(
    {
      taskId: { type: 'string' },
      operation: { type: 'string', enum: ['resume', 'cancel'] },
    },
    ['taskId', 'operation'],
  ),
  destructive: true,
  handoff: true,
  schema: backgroundTaskActionSchema,
  summarize: ({ operation, taskId }) => `${operation} background task ${taskId}`,
  execute: async ({ operation, taskId }) => {
    const desktop = requireDesktop()
    const result =
      operation === 'resume'
        ? await desktop.tasks.resume(taskId)
        : await desktop.tasks.cancel(taskId)
    return {
      ok: true,
      message: `${operation === 'resume' ? 'Resumed' : 'Cancelled'} background task ${taskId}.`,
      data: { taskId, operation, result },
      changed: true,
    }
  },
})

const readDiagnostics = definePlatformTool({
  name: 'read_diagnostics',
  requiresProject: false,
  title: 'Read diagnostics',
  description:
    'Read redacted FreeCut system information, recent desktop logs, crash metadata, and background task failures for debugging.',
  inputSchema: objectSchema({}),
  readOnly: true,
  schema: z.object({}),
  summarize: () => 'Read FreeCut diagnostics',
  execute: async () => {
    const diagnostics = await requireDesktop().diagnostics.inspect()
    return {
      ok: true,
      message: 'Read redacted FreeCut diagnostics.',
      data: { diagnostics },
    }
  },
})

const exportDiagnostics = definePlatformTool({
  name: 'export_diagnostics',
  requiresProject: false,
  title: 'Export diagnostics',
  description:
    'Open the native destination picker and export a redacted FreeCut diagnostics bundle.',
  inputSchema: objectSchema({}),
  handoff: true,
  schema: z.object({}),
  summarize: () => 'Export FreeCut diagnostics',
  execute: async () => {
    const directory = await requireDesktop().diagnostics.export()
    return {
      ok: true,
      message: directory ? `Exported FreeCut diagnostics to ${directory}.` : 'Diagnostics export cancelled.',
      data: { directory: directory || null },
      changed: Boolean(directory),
    }
  },
})

export const APPLICATION_PLATFORM_TOOLS = [
  readAppRuntime,
  readBackgroundTasks,
  manageBackgroundTask,
  readDiagnostics,
  exportDiagnostics,
] as const
