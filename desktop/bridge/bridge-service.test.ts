// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { TaskRepository } from '../services/task-repository'
import { BridgeError, BridgeService } from './bridge-service'

const tools = [
  {
    name: 'read_project',
    annotations: { readOnlyHint: true, destructiveHint: false, requiresProject: true },
  },
  {
    name: 'delete_items',
    annotations: { readOnlyHint: false, destructiveHint: true, requiresProject: true },
  },
  {
    name: 'remove_silence',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      requiresProject: true,
      handoffRequired: true,
    },
  },
  {
    name: 'add_text',
    annotations: { readOnlyHint: false, destructiveHint: false, requiresProject: true },
  },
]
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(options?: ConstructorParameters<typeof BridgeService>[1]) {
  const root = await mkdtemp(join(tmpdir(), 'freecut-bridge-'))
  roots.push(root)
  const file = join(root, 'tasks.json')
  const tasks = new TaskRepository(file)
  const service = new BridgeService(tasks, options)
  return { file, service, tasks }
}

function register(service: BridgeService): void {
  service.registerRenderer({ clientId: 'renderer', projectId: 'p1', tools })
}

function completeOnDispatch(service: BridgeService, result: unknown): void {
  service.onCall((call) => {
    void (async () => {
      expect(await service.start('renderer', call.requestId)).toBe(true)
      await service.complete('renderer', call.requestId, result)
    })()
  })
}

describe('BridgeService', () => {
  it('dispatches a registered tool call and returns the Renderer result', async () => {
    const { service } = await setup()
    register(service)
    service.onCall((call) => {
      expect(structuredClone(call)).toEqual(call)
      expect(Object.keys(call).sort()).toEqual([
        'allowDestructive',
        'allowHandoff',
        'args',
        'createdAt',
        'name',
        'projectId',
        'requestId',
      ])
      void (async () => {
        await service.start('renderer', call.requestId)
        await service.complete('renderer', call.requestId, { ok: true, changed: false })
      })()
    })

    await expect(
      service.call({
        requestId: 'r1',
        name: 'read_project',
        args: {},
        projectId: 'p1',
      }),
    ).resolves.toEqual({ ok: true, changed: false })
  })

  it('rejects the caller when completion metadata cannot be persisted', async () => {
    const { service, tasks } = await setup()
    register(service)
    const update = tasks.update.bind(tasks)
    vi.spyOn(tasks, 'update').mockImplementation((id, patch) => {
      if (patch.status === 'completed') {
        return Promise.reject(new Error('task persistence failed'))
      }
      return update(id, patch)
    })

    let requestId = ''
    service.onCall((call) => {
      requestId = call.requestId
    })
    const pending = service.call({
      requestId: 'completion-persistence-failure',
      name: 'read_project',
      args: {},
      projectId: 'p1',
    })
    await vi.waitFor(() => expect(requestId).toBe('completion-persistence-failure'))
    await expect(service.start('renderer', requestId)).resolves.toBe(true)
    await expect(service.complete('renderer', requestId, { ok: true })).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({
        code: 'BRIDGE_PERSISTENCE_FAILED',
        finalStatus: 'failed',
      }),
    )

    const outcome = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ])
    expect(outcome).toEqual(
      expect.objectContaining<Partial<BridgeError>>({
        code: 'BRIDGE_PERSISTENCE_FAILED',
        finalStatus: 'failed',
      }),
    )
  })

  it('requires independent native confirmation for destructive tools', async () => {
    const confirmExecution = vi.fn().mockResolvedValue(true)
    const { service } = await setup({ confirmExecution })
    register(service)
    completeOnDispatch(service, { ok: true })

    await expect(
      service.call({
        requestId: 'r2',
        name: 'delete_items',
        args: {},
        projectId: 'p1',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'CONFIRMATION_REQUIRED' }),
    )
    expect(confirmExecution).not.toHaveBeenCalled()

    await expect(
      service.call({
        requestId: 'r3',
        name: 'delete_items',
        args: {},
        projectId: 'p1',
        allowDestructive: true,
      }),
    ).resolves.toEqual({ ok: true })
    expect(confirmExecution).toHaveBeenCalledWith({
      requestId: 'r3',
      name: 'delete_items',
      projectId: 'p1',
      destructive: true,
      handoff: false,
    })
  })

  it('requires native confirmation for handoff tools', async () => {
    const confirmExecution = vi.fn().mockResolvedValue(true)
    const { service } = await setup({ confirmExecution })
    register(service)
    service.onCall((call) => {
      expect(call.allowHandoff).toBe(true)
      void (async () => {
        await service.start('renderer', call.requestId)
        await service.complete('renderer', call.requestId, { ok: true })
      })()
    })

    await expect(
      service.call({
        requestId: 'handoff-1',
        name: 'remove_silence',
        args: {},
        projectId: 'p1',
      }),
    ).resolves.toEqual({ ok: true })
    expect(confirmExecution).toHaveBeenCalledWith({
      requestId: 'handoff-1',
      name: 'remove_silence',
      projectId: 'p1',
      destructive: false,
      handoff: true,
    })
  })

  it('lets the trusted renderer replace a stale registration', async () => {
    const { service } = await setup()
    service.registerRenderer({ clientId: 'renderer-a', projectId: null, tools })
    service.registerRenderer({ clientId: 'renderer-b', projectId: 'p1', tools })

    expect(service.status().renderer).toEqual(
      expect.objectContaining({ clientId: 'renderer-b', projectId: 'p1' }),
    )
  })

  it('does not persist completed results and rejects a changed fingerprint', async () => {
    const { file, service } = await setup()
    register(service)
    completeOnDispatch(service, { ok: true })
    await service.call({ requestId: 'same', name: 'read_project', args: {}, projectId: 'p1' })
    const [persisted] = await new TaskRepository(file).list()
    expect(persisted?.data).toEqual(
      expect.objectContaining({
        requestId: 'same',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        name: 'read_project',
        projectId: 'p1',
      }),
    )
    expect(persisted?.data).not.toHaveProperty('args')
    expect(persisted?.data).not.toHaveProperty('result')

    const restarted = new BridgeService(new TaskRepository(file))
    await expect(
      restarted.call({ requestId: 'same', name: 'read_project', args: {}, projectId: 'p1' }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_RESULT_EXPIRED' }),
    )
    await expect(
      restarted.call({
        requestId: 'same',
        name: 'read_project',
        args: { detail: true },
        projectId: 'p1',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_CONFLICT' }),
    )
  })

  it('treats reordered JSON object keys as the same completed request', async () => {
    const { file, service } = await setup()
    register(service)
    completeOnDispatch(service, { ok: true })
    await service.call({
      requestId: 'canonical',
      name: 'read_project',
      args: { filters: { media: true, timeline: true } },
      projectId: 'p1',
    })

    const restarted = new BridgeService(new TaskRepository(file))
    await expect(
      restarted.call({
        requestId: 'canonical',
        name: 'read_project',
        args: { filters: { timeline: true, media: true } },
        projectId: 'p1',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_RESULT_EXPIRED' }),
    )
  })

  it('requires native confirmation for every write tool', async () => {
    const confirmExecution = vi.fn().mockResolvedValue(true)
    const { service } = await setup({ confirmExecution })
    register(service)
    completeOnDispatch(service, { ok: true })

    await expect(
      service.call({
        requestId: 'write-1',
        name: 'add_text',
        args: { text: 'title' },
        projectId: 'p1',
      }),
    ).resolves.toEqual({ ok: true })
    expect(confirmExecution).toHaveBeenCalledWith({
      requestId: 'write-1',
      name: 'add_text',
      projectId: 'p1',
      destructive: false,
      handoff: false,
    })
  })

  it('uses the Local Agent approval as the single confirmation for a write tool', async () => {
    const confirmExecution = vi.fn().mockResolvedValue(true)
    const { service } = await setup({ confirmExecution })
    register(service)
    completeOnDispatch(service, { ok: true })

    await expect(
      service.call({
        requestId: 'local-agent-approved-write',
        name: 'delete_items',
        args: {},
        projectId: 'p1',
        allowDestructive: true,
        confirmedByLocalAgent: true,
      }),
    ).resolves.toEqual({ ok: true })

    expect(confirmExecution).not.toHaveBeenCalled()
  })

  it('releases confirmation waits after timeout or cancel and accepts later calls', async () => {
    const confirmExecution = vi.fn(() => new Promise<boolean>(() => undefined))
    const { service } = await setup({ confirmExecution })
    register(service)

    const timedOut = service.call({
      requestId: 'confirm-timeout',
      name: 'add_text',
      args: { text: 'title' },
      projectId: 'p1',
      timeoutMs: 1_000,
    })
    await expect(timedOut).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({
        code: 'CONFIRMATION_TIMEOUT',
        finalStatus: 'failed',
      }),
    )

    const cancelled = service.call({
      requestId: 'confirm-cancel',
      name: 'add_text',
      args: { text: 'title' },
      projectId: 'p1',
      timeoutMs: 10_000,
    })
    await vi.waitFor(() => expect(confirmExecution).toHaveBeenCalledTimes(2))
    await expect(service.cancel('confirm-cancel')).resolves.toEqual({
      requestId: 'confirm-cancel',
      cancelled: true,
      state: 'queued',
    })
    await expect(cancelled).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({
        code: 'BRIDGE_CANCELLED',
        finalStatus: 'cancelled',
      }),
    )

    completeOnDispatch(service, { ok: true, changed: false })
    await expect(
      service.call({
        requestId: 'read-after-confirmation-failure',
        name: 'read_project',
        args: {},
        projectId: 'p1',
      }),
    ).resolves.toEqual({ ok: true, changed: false })
  })

  it('cancels confirmation waits during shutdown', async () => {
    const confirmExecution = vi.fn(() => new Promise<boolean>(() => undefined))
    const { service } = await setup({ confirmExecution })
    register(service)

    const pending = service.call({
      requestId: 'confirm-shutdown',
      name: 'add_text',
      args: { text: 'title' },
      projectId: 'p1',
      timeoutMs: 10_000,
    })
    await vi.waitFor(() => expect(confirmExecution).toHaveBeenCalledOnce())

    service.dispose()

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({
        code: 'BRIDGE_CANCELLED',
        finalStatus: 'cancelled',
      }),
    )
  })

  it('bounds the number of queued calls', async () => {
    const { service } = await setup()
    register(service)
    const queued: Promise<unknown>[] = []
    for (let index = 0; index < 8; index += 1) {
      queued.push(
        service.call({
          requestId: `queued-${index}`,
          name: 'read_project',
          args: {},
          projectId: 'p1',
        }),
      )
    }
    await vi.waitFor(() => expect(service.status().pendingCalls).toBe(8))

    expect(() =>
      service.call({
        requestId: 'queued-overflow',
        name: 'read_project',
        args: {},
        projectId: 'p1',
      }),
    ).toThrowError(expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_BUSY' }))
    service.dispose()
    await Promise.allSettled(queued)
  })

  it('cancels queued work but refuses to claim a running command was cancelled', async () => {
    const { service } = await setup()
    register(service)
    let queuedRequestId = ''
    service.onCall((call) => {
      queuedRequestId = call.requestId
    })
    const queued = service.call({
      requestId: 'queued',
      name: 'read_project',
      args: {},
      projectId: 'p1',
    })
    await vi.waitFor(() => expect(queuedRequestId).toBe('queued'))
    await expect(service.cancel('queued')).resolves.toEqual({
      requestId: 'queued',
      cancelled: true,
      state: 'queued',
    })
    await expect(queued).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_CANCELLED' }),
    )

    let runningRequestId = ''
    service.onCall((call) => {
      if (call.requestId !== 'running') return
      void service.start('renderer', call.requestId).then(() => {
        runningRequestId = call.requestId
      })
    })
    const running = service.call({
      requestId: 'running',
      name: 'read_project',
      args: {},
      projectId: 'p1',
    })
    await vi.waitFor(() => expect(runningRequestId).toBe('running'))
    await expect(service.cancel('running')).resolves.toEqual({
      requestId: 'running',
      cancelled: false,
      state: 'running',
    })
    await service.complete('renderer', 'running', { ok: true })
    await expect(running).resolves.toEqual({ ok: true })
  })

  it('invalidates old-project work when a new Renderer session registers', async () => {
    const { service } = await setup()
    service.registerRenderer({ clientId: 'renderer-p1', projectId: 'p1', tools })
    let requestId = ''
    service.onCall((call) => {
      requestId = call.requestId
    })
    const pending = service.call({
      requestId: 'project-switch',
      name: 'read_project',
      args: {},
      projectId: 'p1',
    })
    await vi.waitFor(() => expect(requestId).toBe('project-switch'))

    service.registerRenderer({ clientId: 'renderer-p2', projectId: 'p2', tools })

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_OFFLINE' }),
    )
    await expect(service.start('renderer-p1', requestId)).rejects.toEqual(
      expect.objectContaining<Partial<BridgeError>>({ code: 'BRIDGE_CONFLICT' }),
    )
  })
})
