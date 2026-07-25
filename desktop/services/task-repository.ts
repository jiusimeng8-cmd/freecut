import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DesktopTaskKind, DesktopTaskStatus } from '../desktop-types'
import { SerializedJsonFile } from './serialized-json-file'

export type { DesktopTaskKind, DesktopTaskStatus } from '../desktop-types'

export interface DesktopTask {
  id: string
  kind: DesktopTaskKind
  projectId?: string
  status: DesktopTaskStatus
  progress?: number
  createdAt: number
  updatedAt: number
  error?: string
  data?: Record<string, unknown>
}

const MAX_PERSISTED_TERMINAL_TASKS = 500
const taskSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['export', 'ffmpeg', 'tts', 'transcription', 'proxy', 'analysis', 'bridge']),
  projectId: z.string().optional(),
  status: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']),
  progress: z.number().finite().optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  error: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})
const taskListSchema = z.array(taskSchema)

function compactTasks(tasks: DesktopTask[]): DesktopTask[] {
  const active = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running' || task.status === 'paused',
  )
  const terminal = tasks
    .filter(
      (task) => task.status !== 'queued' && task.status !== 'running' && task.status !== 'paused',
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PERSISTED_TERMINAL_TASKS)
  return [...active, ...terminal]
}

export class TaskRepository {
  private readonly file: SerializedJsonFile<DesktopTask[]>

  constructor(filePath: string) {
    this.file = new SerializedJsonFile(filePath, () => [], {
      parse: (value) => taskListSchema.parse(value),
      recoverInvalid: true,
    })
  }

  async list(): Promise<DesktopTask[]> {
    return (await this.file.read()).sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async get(id: string): Promise<DesktopTask | null> {
    return (await this.file.read()).find((task) => task.id === id) ?? null
  }

  async findBridgeRequest(requestId: string): Promise<DesktopTask | null> {
    return (
      (await this.file.read()).find(
        (task) => task.kind === 'bridge' && task.data?.requestId === requestId,
      ) ?? null
    )
  }

  async create(input: {
    kind: DesktopTaskKind
    projectId?: string
    data?: Record<string, unknown>
  }): Promise<DesktopTask> {
    const now = Date.now()
    const task: DesktopTask = {
      id: randomUUID(),
      kind: input.kind,
      projectId: input.projectId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      data: input.data,
    }
    await this.file.update((tasks) => compactTasks([...tasks, task]))
    return task
  }

  async update(
    id: string,
    patch: Partial<Omit<DesktopTask, 'id' | 'createdAt'>>,
  ): Promise<DesktopTask> {
    let updated: DesktopTask | null = null
    await this.file.update((tasks) =>
      compactTasks(
        tasks.map((current) => {
          if (current.id !== id) return current
          updated = {
            ...current,
            ...patch,
            error: patch.error?.slice(0, 8_192),
            id,
            createdAt: current.createdAt,
            updatedAt: Date.now(),
          }
          return updated
        }),
      ),
    )
    if (!updated) throw new Error(`Unknown desktop task: ${id}`)
    return updated
  }

  async markInterrupted(): Promise<void> {
    await this.file.update((tasks) =>
      compactTasks(
        tasks.map((task) => {
          const interrupted = task.status === 'queued' || task.status === 'running'
          if (!interrupted) return task
          const bridgeWasInterrupted = task.kind === 'bridge'
          const transcriptionCanResume =
            task.kind === 'transcription' &&
            typeof task.data?.remoteTaskId === 'string' &&
            task.data.remoteTaskId.length > 0 &&
            typeof task.data.baseUrl === 'string' &&
            task.data.baseUrl.length > 0
          return {
            ...task,
            status: bridgeWasInterrupted
              ? 'uncertain'
              : transcriptionCanResume
                ? 'paused'
                : 'failed',
            updatedAt: Date.now(),
            error: bridgeWasInterrupted
              ? 'FreeCut stopped before it could prove whether this Bridge command completed.'
              : transcriptionCanResume
                ? 'FreeCut stopped while cloud transcription was running. The task can be resumed.'
                : 'The application stopped before this task completed.',
          }
        }),
      ),
    )
  }
}
