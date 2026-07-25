// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { DashScopeAsrRunOptions, DashScopeAsrService } from './dashscope-asr-service'
import { TaskRepository } from './task-repository'
import { TranscriptionTaskService } from './transcription-task-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function repository(prefix: string): Promise<{
  file: string
  tasks: TaskRepository
}> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const file = join(root, 'tasks.json')
  return { file, tasks: new TaskRepository(file) }
}

describe('TranscriptionTaskService', () => {
  it('persists remote metadata before completion and returns a sanitized summary', async () => {
    const { tasks } = await repository('freecut-transcription-service-')
    let releaseResult: (() => void) | undefined
    let submitted: (() => void) | undefined
    const submittedPromise = new Promise<void>((resolve) => {
      submitted = resolve
    })
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve
    })
    const transcribe = vi.fn(async (_input: unknown, options?: DashScopeAsrRunOptions) => {
      await options?.onSubmitted?.({
        remoteTaskId: 'remote-task-1',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'fun-asr',
      })
      submitted?.()
      await resultGate
      return {
        remoteTaskId: 'remote-task-1',
        result: { transcripts: [{ text: 'done' }] },
      }
    })
    const service = new TranscriptionTaskService(tasks, {
      transcribe,
    } as unknown as DashScopeAsrService)

    const request = service.transcribe({
      fileName: 'clip.wav',
      mimeType: 'audio/wav',
      bytes: new Uint8Array([1]),
    })
    await submittedPromise

    const [persisted] = await tasks.list()
    expect(persisted).toEqual(
      expect.objectContaining({
        status: 'running',
        data: expect.objectContaining({
          fileName: 'clip.wav',
          remoteTaskId: 'remote-task-1',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        }),
      }),
    )
    const [summary] = await service.list()
    expect(summary).toEqual(
      expect.objectContaining({
        id: persisted!.id,
        fileName: 'clip.wav',
        canCancel: true,
      }),
    )
    expect(summary).not.toHaveProperty('data')
    expect(summary).not.toHaveProperty('remoteTaskId')

    releaseResult?.()
    await expect(request).resolves.toEqual({
      taskId: persisted!.id,
      result: { transcripts: [{ text: 'done' }] },
    })
  })

  it('marks an explicitly cancelled remote transcription without losing its warning', async () => {
    const { tasks } = await repository('freecut-transcription-cancel-')
    let submitted: (() => void) | undefined
    const submittedPromise = new Promise<void>((resolve) => {
      submitted = resolve
    })
    const transcribe = vi.fn(async (_input: unknown, options?: DashScopeAsrRunOptions) => {
      await options?.onSubmitted?.({
        remoteTaskId: 'remote-task-2',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'fun-asr',
      })
      submitted?.()
      return new Promise<{ remoteTaskId: string; result: unknown }>((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        )
      })
    })
    const service = new TranscriptionTaskService(tasks, {
      transcribe,
    } as unknown as DashScopeAsrService)

    const request = service.transcribe({
      fileName: 'clip.wav',
      mimeType: 'audio/wav',
      bytes: new Uint8Array([1]),
    })
    await submittedPromise
    const [task] = await tasks.list()

    await expect(service.cancel(task!.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'cancelled',
        remoteMayContinue: true,
      }),
    )
    await expect(request).rejects.toThrow('cancelled')
    await expect(tasks.get(task!.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'cancelled',
        error: expect.stringContaining('remote transcription may continue'),
      }),
    )
  })

  it('resumes a persisted remote task after restart', async () => {
    const { file, tasks } = await repository('freecut-transcription-resume-')
    const task = await tasks.create({
      kind: 'transcription',
      data: {
        fileName: 'resume.wav',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'fun-asr',
        remoteTaskId: 'remote-task-3',
      },
    })
    await tasks.update(task.id, { status: 'running' })

    const restarted = new TaskRepository(file)
    await restarted.markInterrupted()
    const resume = vi.fn().mockResolvedValue({
      remoteTaskId: 'remote-task-3',
      result: { transcripts: [{ text: 'resumed' }] },
    })
    const service = new TranscriptionTaskService(restarted, {
      resume,
    } as unknown as DashScopeAsrService)

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'paused',
        canResume: true,
      }),
    ])
    await expect(service.resume(task.id)).resolves.toEqual({
      taskId: task.id,
      result: { transcripts: [{ text: 'resumed' }] },
    })
    expect(resume).toHaveBeenCalledWith(
      {
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        remoteTaskId: 'remote-task-3',
      },
      { signal: expect.any(AbortSignal) },
    )
    await expect(restarted.get(task.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        progress: 1,
      }),
    )
  })

  it('retries a failed transcription with fresh media input', async () => {
    const { tasks } = await repository('freecut-transcription-retry-')
    const task = await tasks.create({
      kind: 'transcription',
      data: {
        fileName: 'old.wav',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        remoteTaskId: 'remote-old',
      },
    })
    await tasks.update(task.id, { status: 'failed', error: 'network failed' })
    const transcribe = vi.fn(async (_input: unknown, options?: DashScopeAsrRunOptions) => {
      await options?.onSubmitted?.({
        remoteTaskId: 'remote-new',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        model: 'fun-asr',
      })
      return {
        remoteTaskId: 'remote-new',
        result: { transcripts: [{ text: 'retried' }] },
      }
    })
    const service = new TranscriptionTaskService(tasks, {
      transcribe,
    } as unknown as DashScopeAsrService)

    await expect(
      service.retry(task.id, {
        fileName: 'new.wav',
        mimeType: 'audio/wav',
        bytes: new Uint8Array([2]),
      }),
    ).resolves.toEqual({
      taskId: task.id,
      result: { transcripts: [{ text: 'retried' }] },
    })
    await expect(tasks.get(task.id)).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        error: undefined,
        data: expect.objectContaining({
          fileName: 'new.wav',
          remoteTaskId: 'remote-new',
        }),
      }),
    )
  })
})
