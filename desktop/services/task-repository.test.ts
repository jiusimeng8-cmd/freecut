// @vitest-environment node

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { TaskRepository } from './task-repository'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TaskRepository', () => {
  it('persists tasks and marks interrupted work as failed on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-tasks-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const first = new TaskRepository(file)
    const task = await first.create({ kind: 'export', projectId: 'p1' })
    await first.update(task.id, { status: 'running', progress: 0.4 })

    const second = new TaskRepository(file)
    await second.markInterrupted()
    expect(await second.list()).toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'failed',
        error: expect.stringContaining('stopped'),
      }),
    ])
  })

  it('marks an interrupted Bridge request as uncertain and finds it by requestId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-bridge-tasks-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const first = new TaskRepository(file)
    const task = await first.create({
      kind: 'bridge',
      projectId: 'p1',
      data: { requestId: 'request-1', fingerprint: 'fingerprint-1' },
    })
    await first.update(task.id, { status: 'running' })

    const second = new TaskRepository(file)
    await second.markInterrupted()

    await expect(second.findBridgeRequest('request-1')).resolves.toEqual(
      expect.objectContaining({
        status: 'uncertain',
        error: expect.stringContaining('prove whether'),
      }),
    )
  })

  it('pauses an interrupted transcription when its remote task can be resumed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-transcription-tasks-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const first = new TaskRepository(file)
    const task = await first.create({
      kind: 'transcription',
      data: {
        fileName: 'clip.wav',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'fun-asr',
        remoteTaskId: 'remote-task-1',
      },
    })
    await first.update(task.id, { status: 'running' })

    const restarted = new TaskRepository(file)
    await restarted.markInterrupted()

    await expect(restarted.get(task.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'paused',
        error: expect.stringContaining('can be resumed'),
      }),
    )
  })

  it('serializes concurrent task creation without losing records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-concurrent-tasks-'))
    roots.push(root)
    const repository = new TaskRepository(join(root, 'tasks.json'))

    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        repository.create({
          kind: 'export',
          projectId: `project-${index}`,
          data: { index },
        }),
      ),
    )

    expect(await repository.list()).toHaveLength(80)
  }, 15_000)

  it('marks queued non-Bridge tasks as failed after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-queued-tasks-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const first = new TaskRepository(file)
    const task = await first.create({ kind: 'tts' })

    const restarted = new TaskRepository(file)
    await restarted.markInterrupted()

    await expect(restarted.list()).resolves.toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'failed',
        error: expect.stringContaining('stopped'),
      }),
    ])
  })

  it('keeps active work and the newest 500 terminal tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-task-retention-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    const terminal = Array.from({ length: 505 }, (_, index) => ({
      id: `completed-${index}`,
      kind: 'export' as const,
      status: 'completed' as const,
      createdAt: index,
      updatedAt: index,
    }))
    await writeFile(
      file,
      JSON.stringify([
        ...terminal,
        {
          id: 'paused-task',
          kind: 'export',
          status: 'paused',
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    )

    const repository = new TaskRepository(file)
    await repository.markInterrupted()
    const tasks = await repository.list()

    expect(tasks).toHaveLength(501)
    expect(tasks.some((task) => task.id === 'paused-task')).toBe(true)
    expect(tasks.some((task) => task.id === 'completed-504')).toBe(true)
    expect(tasks.some((task) => task.id === 'completed-4')).toBe(false)
  })

  it('quarantines structurally invalid task data instead of blocking startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-invalid-tasks-'))
    roots.push(root)
    const file = join(root, 'tasks.json')
    await writeFile(file, JSON.stringify({ tasks: [] }))

    await expect(new TaskRepository(file).list()).resolves.toEqual([])
    expect((await readdir(root)).some((name) => name.startsWith('tasks.json.corrupt-'))).toBe(true)
  })
})
