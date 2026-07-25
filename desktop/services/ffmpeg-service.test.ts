// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { FfmpegService, type FfmpegPaths } from './ffmpeg-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FfmpegService.resolve', () => {
  it('uses only bundled executables when environment overrides are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-ffmpeg-service-'))
    roots.push(root)
    const directory = join(root, 'windows', 'ffmpeg')
    await mkdir(directory, { recursive: true })
    const ffmpegBytes = Buffer.from('bundled-ffmpeg')
    const ffprobeBytes = Buffer.from('bundled-ffprobe')
    await Promise.all([
      writeFile(join(directory, 'ffmpeg.exe'), ffmpegBytes),
      writeFile(join(directory, 'ffprobe.exe'), ffprobeBytes),
      writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          ffmpegSha256: createHash('sha256').update(ffmpegBytes).digest('hex'),
          ffprobeSha256: createHash('sha256').update(ffprobeBytes).digest('hex'),
          ffmpegSize: ffmpegBytes.byteLength,
          ffprobeSize: ffprobeBytes.byteLength,
        }),
      ),
    ])
    const previousFfmpeg = process.env.FREECUT_FFMPEG_PATH
    const previousFfprobe = process.env.FREECUT_FFPROBE_PATH
    process.env.FREECUT_FFMPEG_PATH = join(root, 'untrusted-ffmpeg.exe')
    process.env.FREECUT_FFPROBE_PATH = join(root, 'untrusted-ffprobe.exe')
    try {
      const service = await FfmpegService.resolve(root, { allowEnvironment: false })
      const paths = (service as unknown as { paths: FfmpegPaths }).paths
      expect(paths).toEqual({
        ffmpeg: join(directory, 'ffmpeg.exe'),
        ffprobe: join(directory, 'ffprobe.exe'),
      })
      await expect(
        (
          service as unknown as {
            ensureIntegrity(): Promise<void>
          }
        ).ensureIntegrity(),
      ).resolves.toBeUndefined()
    } finally {
      if (previousFfmpeg === undefined) delete process.env.FREECUT_FFMPEG_PATH
      else process.env.FREECUT_FFMPEG_PATH = previousFfmpeg
      if (previousFfprobe === undefined) delete process.env.FREECUT_FFPROBE_PATH
      else process.env.FREECUT_FFPROBE_PATH = previousFfprobe
    }
  })

  it('fails closed when bundled executables are missing in packaged mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-ffmpeg-missing-'))
    roots.push(root)

    await expect(
      FfmpegService.resolve(root, { allowEnvironment: false }),
    ).rejects.toThrow('Bundled FFmpeg resources are missing')
  })

  it('rejects bundled executables that no longer match the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-ffmpeg-integrity-'))
    roots.push(root)
    const directory = join(root, 'windows', 'ffmpeg')
    await mkdir(directory, { recursive: true })
    await Promise.all([
      writeFile(join(directory, 'ffmpeg.exe'), 'tampered'),
      writeFile(join(directory, 'ffprobe.exe'), 'ffprobe'),
      writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          ffmpegSha256: createHash('sha256').update('expected').digest('hex'),
          ffprobeSha256: createHash('sha256').update('ffprobe').digest('hex'),
          ffmpegSize: 8,
          ffprobeSize: 7,
        }),
      ),
    ])

    const service = await FfmpegService.resolve(root, { allowEnvironment: false })
    await expect(
      (
        service as unknown as {
          ensureIntegrity(): Promise<void>
        }
      ).ensureIntegrity(),
    ).rejects.toThrow('installation integrity check')
  })
})
