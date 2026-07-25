import { basename } from 'node:path'
import type {
  DesktopTaskExecutionResult,
  DesktopTaskSummary,
  DesktopTaskStatus,
} from '../desktop-types'
import type {
  DashScopeAsrInput,
  DashScopeAsrService,
  DashScopeAsrSubmission,
} from './dashscope-asr-service'
import type { DesktopTask, TaskRepository } from './task-repository'

const RESUMABLE_STATUSES = new Set<DesktopTaskStatus>(['paused', 'failed', 'completed'])
const RETRYABLE_STATUSES = new Set<DesktopTaskStatus>(['failed', 'cancelled'])
const CANCELLABLE_STATUSES = new Set<DesktopTaskStatus>(['queued', 'running', 'paused'])

interface PersistedTranscriptionData extends Record<string, unknown> {
  fileName: string
  baseUrl?: string
  model?: string
  remoteTaskId?: string
}

function readTranscriptionData(task: DesktopTask): PersistedTranscriptionData {
  return {
    fileName:
      typeof task.data?.fileName === 'string' && task.data.fileName
        ? task.data.fileName
        : 'media.bin',
    baseUrl: typeof task.data?.baseUrl === 'string' ? task.data.baseUrl : undefined,
    model: typeof task.data?.model === 'string' ? task.data.model : undefined,
    remoteTaskId: typeof task.data?.remoteTaskId === 'string' ? task.data.remoteTaskId : undefined,
  }
}

function hasRemoteTask(task: DesktopTask): boolean {
  const data = readTranscriptionData(task)
  return Boolean(data.baseUrl && data.remoteTaskId)
}

function summarizeTask(task: DesktopTask): DesktopTaskSummary {
  const transcription = task.kind === 'transcription'
  const hasRemote = transcription && hasRemoteTask(task)
  return {
    id: task.id,
    kind: task.kind,
    projectId: task.projectId,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    fileName: transcription ? readTranscriptionData(task).fileName : undefined,
    canResume: hasRemote && RESUMABLE_STATUSES.has(task.status),
    canRetry: transcription && RETRYABLE_STATUSES.has(task.status),
    canCancel: transcription && CANCELLABLE_STATUSES.has(task.status),
    remoteMayContinue: hasRemote && task.status === 'cancelled',
  }
}

export class TranscriptionTaskService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly runs = new Map<string, Promise<DesktopTaskExecutionResult>>()
  private disposed = false

  constructor(
    private readonly tasks: TaskRepository,
    private readonly asr: DashScopeAsrService,
  ) {}

  async list(): Promise<DesktopTaskSummary[]> {
    return (await this.tasks.list()).map(summarizeTask)
  }

  async transcribe(input: DashScopeAsrInput): Promise<DesktopTaskExecutionResult> {
    const task = await this.tasks.create({
      kind: 'transcription',
      data: this.initialData(input),
    })
    return this.submit(task.id, input)
  }

  async resume(taskId: string): Promise<DesktopTaskExecutionResult> {
    const active = this.runs.get(taskId)
    if (active) return active
    const task = await this.requireTranscription(taskId)
    const data = readTranscriptionData(task)
    if (!RESUMABLE_STATUSES.has(task.status) || !data.baseUrl || !data.remoteTaskId) {
      throw new Error('This transcription task cannot be resumed.')
    }
    return this.run(taskId, (signal) =>
      this.asr.resume(
        {
          baseUrl: data.baseUrl!,
          remoteTaskId: data.remoteTaskId!,
        },
        { signal },
      ),
    )
  }

  async retry(taskId: string, input: DashScopeAsrInput): Promise<DesktopTaskExecutionResult> {
    if (this.runs.has(taskId)) {
      throw new Error('This transcription task is already running.')
    }
    const task = await this.requireTranscription(taskId)
    if (!RETRYABLE_STATUSES.has(task.status)) {
      throw new Error('This transcription task cannot be retried.')
    }
    await this.tasks.update(taskId, {
      status: 'queued',
      progress: 0,
      error: undefined,
      data: this.initialData(input),
    })
    return this.submit(taskId, input)
  }

  async cancel(taskId: string): Promise<DesktopTaskSummary> {
    const task = await this.requireTranscription(taskId)
    if (!CANCELLABLE_STATUSES.has(task.status)) {
      throw new Error('This transcription task cannot be cancelled.')
    }
    this.controllers.get(taskId)?.abort()
    const updated = await this.tasks.update(taskId, {
      status: 'cancelled',
      error: hasRemoteTask(task)
        ? 'Local polling was cancelled. The remote transcription may continue.'
        : undefined,
    })
    return summarizeTask(updated)
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  private submit(taskId: string, input: DashScopeAsrInput): Promise<DesktopTaskExecutionResult> {
    return this.run(taskId, (signal) =>
      this.asr.transcribe(input, {
        signal,
        onSubmitted: (submission) => this.persistSubmission(taskId, submission),
      }),
    )
  }

  private run(
    taskId: string,
    operation: (signal: AbortSignal) => Promise<{ remoteTaskId: string; result: unknown }>,
  ): Promise<DesktopTaskExecutionResult> {
    if (this.disposed) throw new Error('Transcription task service is disposed.')
    const active = this.runs.get(taskId)
    if (active) return active

    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    const run = (async () => {
      await this.tasks.update(taskId, {
        status: 'running',
        error: undefined,
      })
      try {
        const output = await operation(controller.signal)
        controller.signal.throwIfAborted()
        await this.tasks.update(taskId, {
          status: 'completed',
          progress: 1,
          error: undefined,
        })
        return { taskId, result: output.result }
      } catch (error) {
        const current = await this.tasks.get(taskId)
        if (!this.disposed && current?.status !== 'cancelled') {
          await this.tasks.update(taskId, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }
    })().finally(() => {
      this.controllers.delete(taskId)
      this.runs.delete(taskId)
    })
    this.runs.set(taskId, run)
    return run
  }

  private async persistSubmission(
    taskId: string,
    submission: DashScopeAsrSubmission,
  ): Promise<void> {
    const task = await this.requireTranscription(taskId)
    const data = readTranscriptionData(task)
    await this.tasks.update(taskId, {
      data: {
        fileName: data.fileName,
        baseUrl: submission.baseUrl,
        model: submission.model,
        remoteTaskId: submission.remoteTaskId,
      },
    })
  }

  private initialData(input: DashScopeAsrInput): PersistedTranscriptionData {
    return {
      fileName: basename(input.fileName.replaceAll('\0', '')).slice(0, 180) || 'media.bin',
      model: 'speech-to-text',
    }
  }

  private async requireTranscription(taskId: string): Promise<DesktopTask> {
    const task = await this.tasks.get(taskId)
    if (!task) throw new Error(`Unknown desktop task: ${taskId}`)
    if (task.kind !== 'transcription') {
      throw new Error('Only transcription tasks support this operation.')
    }
    return task
  }
}
