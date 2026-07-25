import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DesktopDiagnosticsSnapshot } from '../desktop-types'
import type { FfmpegService } from './ffmpeg-service'
import type { DesktopTask, TaskRepository } from './task-repository'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_INSPECT_LOG_BYTES = 256 * 1024
const MAX_TASKS = 500

function redactSensitiveText(source: string): string {
  return source
    .replace(
      /(["'])(api[_-]?key|business[_-]?key|access[_-]?token|refresh[_-]?token|credential|secret|password)\1\s*:\s*(["'])[^"']*\3/gi,
      '$1$2$1: $3[REDACTED]$3',
    )
    .replace(
      /\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi,
      'Authorization: [REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|business[_-]?key|access[_-]?token|refresh[_-]?token|credential|secret|password)\s*[:=]\s*)(["']?)[^,\s"'}]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
}

function diagnosticTask(task: DesktopTask): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    projectId: task.projectId,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error ? redactSensitiveText(task.error).slice(0, 8_192) : undefined,
    operation:
      task.kind === 'bridge' && typeof task.data?.name === 'string' ? task.data.name : undefined,
  }
}

async function readFileTail(path: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const metadata = await handle.stat()
    const length = Math.min(metadata.size, maxBytes)
    const output = Buffer.alloc(length)
    if (length > 0) {
      await handle.read(output, 0, length, metadata.size - length)
    }
    return output
  } finally {
    await handle.close()
  }
}

async function inspectCrashDumps(sourceDirectory: string): Promise<{
  discovered: number
  included: []
  skipped: Array<{ name: string; size: number; reason: string }>
}> {
  const sourceDirectories = [...new Set([sourceDirectory, join(sourceDirectory, 'reports')])]
  const candidates: Array<{
    path: string
    name: string
    size: number
    mtimeMs: number
  }> = []
  for (const directory of sourceDirectories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(directory, entry.name)
      const metadata = await stat(path).catch(() => null)
      if (!metadata?.isFile()) continue
      candidates.push({
        path,
        name: basename(entry.name),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      })
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)

  return {
    discovered: candidates.length,
    included: [],
    skipped: candidates.map((candidate) => ({
      name: candidate.name,
      size: candidate.size,
      reason: 'sensitive-crash-dump-excluded',
    })),
  }
}

export class DiagnosticsService {
  constructor(
    private readonly input: {
      appVersion: () => string
      osVersion: () => string
      gpuFeatureStatus: () => unknown
      gpuProbe?: () => unknown
      safeMode: () => boolean
      crashDumpsPath: string
      logPath: string
      ffmpeg: FfmpegService
      tasks: TaskRepository
    },
  ) {}

  async inspect(): Promise<DesktopDiagnosticsSnapshot> {
    const [versions, tasks, log, rotatedLog, crashes] = await Promise.all([
      this.input.ffmpeg.versions().catch((error) => ({
        ffmpeg: '',
        ffprobe: error instanceof Error ? error.message : String(error),
      })),
      this.input.tasks.list(),
      readFileTail(this.input.logPath, MAX_INSPECT_LOG_BYTES),
      readFileTail(`${this.input.logPath}.1`, MAX_INSPECT_LOG_BYTES),
      inspectCrashDumps(this.input.crashDumpsPath),
    ])

    return {
      generatedAt: new Date().toISOString(),
      system: {
        appVersion: this.input.appVersion(),
        platform: process.platform,
        architecture: process.arch,
        osVersion: this.input.osVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        ffmpeg: versions,
        gpuFeatureStatus: this.input.gpuFeatureStatus(),
        gpuProbe: this.input.gpuProbe?.(),
        safeMode: this.input.safeMode(),
      },
      tasks: tasks.slice(0, MAX_TASKS).map(diagnosticTask),
      logs: {
        current: log ? redactSensitiveText(log.toString('utf8')) : null,
        rotated: rotatedLog ? redactSensitiveText(rotatedLog.toString('utf8')) : null,
        maxBytesPerFile: MAX_INSPECT_LOG_BYTES,
        redacted: true,
      },
      crashes,
    }
  }

  async export(destinationDirectory: string): Promise<string> {
    const directory = join(
      destinationDirectory || tmpdir(),
      `FreeCut-Diagnostics-${new Date().toISOString().replaceAll(':', '-')}`,
    )
    await mkdir(directory, { recursive: true })
    const [versions, tasks] = await Promise.all([
      this.input.ffmpeg.versions().catch((error) => ({
        ffmpeg: '',
        ffprobe: error instanceof Error ? error.message : String(error),
      })),
      this.input.tasks.list(),
    ])
    const exportedTasks = tasks.slice(0, MAX_TASKS).map(diagnosticTask)
    await writeFile(
      join(directory, 'system.json'),
      JSON.stringify(
        {
          appVersion: this.input.appVersion(),
          platform: process.platform,
          architecture: process.arch,
          osVersion: this.input.osVersion(),
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          ffmpeg: versions,
          gpuFeatureStatus: this.input.gpuFeatureStatus(),
          gpuProbe: this.input.gpuProbe?.(),
          safeMode: this.input.safeMode(),
          tasks: exportedTasks,
        },
        null,
        2,
      ),
    )
    const [log, rotatedLog] = await Promise.all([
      readFileTail(this.input.logPath, MAX_LOG_BYTES),
      readFileTail(`${this.input.logPath}.1`, MAX_LOG_BYTES),
    ])
    if (log) {
      await writeFile(
        join(directory, basename(this.input.logPath)),
        redactSensitiveText(log.toString('utf8')),
      )
    }
    if (rotatedLog) {
      await writeFile(
        join(directory, `${basename(this.input.logPath)}.1`),
        redactSensitiveText(rotatedLog.toString('utf8')),
      )
    }
    const crashes = await inspectCrashDumps(this.input.crashDumpsPath)
    await writeFile(
      join(directory, 'diagnostics-manifest.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          redacted: true,
          rawCrashDumpsIncluded: false,
          limits: {
            logBytes: MAX_LOG_BYTES,
            tasks: MAX_TASKS,
          },
          exported: {
            logBytes: log?.byteLength ?? 0,
            rotatedLogBytes: rotatedLog?.byteLength ?? 0,
            tasks: exportedTasks.length,
            tasksOmitted: Math.max(0, tasks.length - exportedTasks.length),
            crashes,
          },
        },
        null,
        2,
      ),
    )
    return directory
  }
}
