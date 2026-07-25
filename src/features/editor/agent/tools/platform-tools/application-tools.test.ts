import { afterEach, describe, expect, it, vi } from 'vitest'
import { callMcpTool, listMcpTools } from '../mcp'

const originalDesktop = window.freecutDesktop

afterEach(() => {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    writable: true,
    value: originalDesktop,
  })
  vi.restoreAllMocks()
})

function installDesktopMock() {
  const cancel = vi.fn().mockResolvedValue({
    id: 'task-1',
    kind: 'bridge',
    status: 'cancelled',
    createdAt: 1,
    updatedAt: 2,
    canResume: false,
    canRetry: false,
    canCancel: false,
    remoteMayContinue: false,
  })
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    writable: true,
    value: {
      app: {
        isDesktop: true,
        getVersion: vi.fn().mockResolvedValue('1.0.1'),
        getPlatform: vi.fn().mockResolvedValue('win32'),
      },
      updates: {
        getStatus: vi.fn().mockResolvedValue({
          phase: 'idle',
          currentVersion: '1.0.1',
          updatedAt: 1,
        }),
      },
      agentRuntime: {
        getInfo: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          dataRoot: 'C:\\Users\\Test\\AppData\\FreeCut\\private\\agent-runtime',
        }),
      },
      tasks: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'task-1',
            kind: 'bridge',
            status: 'failed',
            createdAt: 1,
            updatedAt: 2,
            canResume: false,
            canRetry: false,
            canCancel: true,
            remoteMayContinue: false,
          },
        ]),
        resume: vi.fn(),
        cancel,
      },
      diagnostics: {
        inspect: vi.fn().mockResolvedValue({
          generatedAt: '2026-07-23T00:00:00.000Z',
          system: { appVersion: '1.0.1' },
          tasks: [],
          logs: {
            current: 'renderer error: test',
            rotated: null,
            maxBytesPerFile: 262144,
            redacted: true,
          },
          crashes: { discovered: 0, included: [], skipped: [] },
        }),
        export: vi.fn().mockResolvedValue('C:\\Temp\\FreeCut-Diagnostics'),
      },
    },
  })
  return { cancel }
}

describe('application MCP tools', () => {
  it('publishes runtime and diagnostic tools in explicit categories', () => {
    const byName = new Map(listMcpTools().map((tool) => [tool.name, tool]))
    expect(byName.get('read_app_runtime')?._meta['freecut/category']).toMatchObject({
      id: 'appRuntime',
      group: 'application',
    })
    expect(byName.get('read_diagnostics')?._meta['freecut/category']).toMatchObject({
      id: 'diagnostics',
      group: 'diagnostics',
    })
  })

  it('reads desktop runtime, tasks, and redacted diagnostics through MCP', async () => {
    installDesktopMock()

    const runtime = await callMcpTool('read_app_runtime', {}, { requestId: 'runtime-1' })
    expect(runtime.isError).toBe(false)
    expect(runtime.structuredContent.data).toMatchObject({
      runtime: 'desktop',
      version: '1.0.1',
      platform: 'win32',
      agentRuntime: { schemaVersion: 1 },
    })

    const tasks = await callMcpTool('read_background_tasks', {}, { requestId: 'tasks-1' })
    expect(tasks.structuredContent.data).toMatchObject({
      tasks: [{ id: 'task-1', status: 'failed' }],
    })

    const diagnostics = await callMcpTool(
      'read_diagnostics',
      {},
      { requestId: 'diagnostics-1' },
    )
    expect(diagnostics.structuredContent.data).toMatchObject({
      diagnostics: {
        logs: { current: 'renderer error: test', redacted: true },
      },
    })
  })

  it('routes background task management through the desktop task service', async () => {
    const { cancel } = installDesktopMock()
    const result = await callMcpTool(
      'manage_background_task',
      { taskId: 'task-1', operation: 'cancel' },
      { requestId: 'task-cancel-1' },
    )

    expect(result.isError).toBe(false)
    expect(result.structuredContent.changed).toBe(true)
    expect(cancel).toHaveBeenCalledWith('task-1')
  })
})
