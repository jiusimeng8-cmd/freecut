// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { FfmpegService } from './ffmpeg-service'
import type { TaskRepository } from './task-repository'
import { DiagnosticsService } from './diagnostics-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DiagnosticsService', () => {
  it('omits task payloads and redacts credentials from exported text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-diagnostics-'))
    roots.push(root)
    const logPath = join(root, 'main.log')
    await writeFile(
      logPath,
      'Authorization: Bearer bearer-secret apiKey=api-secret "businessKey":"business-secret" https://x.test/?token=url-secret',
    )
    await writeFile(`${logPath}.1`, 'password=rotated-secret')
    const crashDumpsPath = join(root, 'Crashpad')
    const crashReportsPath = join(crashDumpsPath, 'reports')
    await mkdir(crashReportsPath, { recursive: true })
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeFile(join(crashReportsPath, `crash-${index}.dmp`), `dump-${index}`),
      ),
    )

    const diagnostics = new DiagnosticsService({
      appVersion: () => '1.0.1',
      osVersion: () => 'test-os',
      gpuFeatureStatus: () => ({ webgpu: 'enabled' }),
      gpuProbe: () => ({ mode: 'software', adapter: true, pixel: [17, 34, 51, 68] }),
      safeMode: () => true,
      crashDumpsPath,
      logPath,
      ffmpeg: {
        versions: async () => ({ ffmpeg: 'ffmpeg test', ffprobe: 'ffprobe test' }),
      } as unknown as FfmpegService,
      tasks: {
        list: async () => [
          {
            id: 'task-1',
            kind: 'bridge',
            projectId: 'project-1',
            status: 'failed',
            createdAt: 1,
            updatedAt: 2,
            error: 'password=task-secret',
            data: {
              name: 'delete_items',
              args: { text: 'private project text' },
              result: { transcript: 'private transcript' },
            },
          },
        ],
      } as unknown as TaskRepository,
    })

    const outputDirectory = await diagnostics.export(root)
    const inspected = await diagnostics.inspect()
    const systemText = await readFile(join(outputDirectory, 'system.json'), 'utf8')
    const system = JSON.parse(systemText) as {
      tasks: Array<Record<string, unknown>>
      gpuProbe: Record<string, unknown>
    }
    const exportedLog = await readFile(join(outputDirectory, 'main.log'), 'utf8')
    const exportedRotatedLog = await readFile(join(outputDirectory, 'main.log.1'), 'utf8')
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, 'diagnostics-manifest.json'), 'utf8'),
    ) as {
      exported: {
        crashes: {
          discovered: number
          included: unknown[]
          skipped: unknown[]
        }
      }
    }
    const exportedCrashes = await stat(join(outputDirectory, 'crashes')).catch(() => null)

    expect(system.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        kind: 'bridge',
        operation: 'delete_items',
        error: 'password=[REDACTED]',
      }),
    ])
    expect(system.tasks[0]).not.toHaveProperty('data')
    expect(systemText).not.toContain('private project text')
    expect(systemText).not.toContain('private transcript')
    expect(systemText).not.toContain('task-secret')
    expect(exportedLog).not.toContain('bearer-secret')
    expect(exportedLog).not.toContain('api-secret')
    expect(exportedLog).not.toContain('business-secret')
    expect(exportedLog).not.toContain('url-secret')
    expect(exportedLog).toContain('Authorization: [REDACTED]')
    expect(exportedRotatedLog).not.toContain('rotated-secret')
    expect(exportedRotatedLog).toContain('password=[REDACTED]')
    expect(inspected.logs.current).toContain('Authorization: [REDACTED]')
    expect(inspected.logs.current).not.toContain('bearer-secret')
    expect(inspected.logs.rotated).toContain('password=[REDACTED]')
    expect(inspected.tasks[0]).not.toHaveProperty('data')
    expect(JSON.stringify(inspected)).not.toContain('private project text')
    expect(system).toEqual(expect.objectContaining({ safeMode: true }))
    expect(system.gpuProbe).toEqual({
      mode: 'software',
      adapter: true,
      pixel: [17, 34, 51, 68],
    })
    expect(manifest.exported.crashes).toEqual(
      expect.objectContaining({
        discovered: 12,
        included: [],
        skipped: expect.arrayContaining([
          expect.objectContaining({ reason: 'sensitive-crash-dump-excluded' }),
        ]),
      }),
    )
    expect(manifest.exported.crashes.skipped).toHaveLength(12)
    expect(exportedCrashes).toBeNull()
  })

  it('exports the newest task window instead of the oldest records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-diagnostics-task-window-'))
    roots.push(root)
    const tasks = Array.from({ length: 501 }, (_, offset) => {
      const index = 500 - offset
      return {
        id: `task-${index}`,
        kind: 'export' as const,
        status: 'completed' as const,
        createdAt: index,
        updatedAt: index,
      }
    })
    const diagnostics = new DiagnosticsService({
      appVersion: () => '1.0.1',
      osVersion: () => 'test-os',
      gpuFeatureStatus: () => ({}),
      safeMode: () => false,
      crashDumpsPath: join(root, 'missing-crashpad'),
      logPath: join(root, 'missing.log'),
      ffmpeg: {
        versions: async () => ({ ffmpeg: '', ffprobe: '' }),
      } as unknown as FfmpegService,
      tasks: { list: async () => tasks } as unknown as TaskRepository,
    })

    const outputDirectory = await diagnostics.export(root)
    const system = JSON.parse(
      await readFile(join(outputDirectory, 'system.json'), 'utf8'),
    ) as { tasks: Array<{ id: string }> }

    expect(system.tasks).toHaveLength(500)
    expect(system.tasks[0]?.id).toBe('task-500')
    expect(system.tasks.at(-1)?.id).toBe('task-1')
    expect(system.tasks.some((task) => task.id === 'task-0')).toBe(false)
  })
})
