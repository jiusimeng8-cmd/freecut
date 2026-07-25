import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from './process-runner'

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

interface FfmpegIntegrity {
  ffmpegSha256: string
  ffprobeSha256: string
  ffmpegSize: number
  ffprobeSize: number
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

async function loadIntegrity(directory: string): Promise<FfmpegIntegrity> {
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as Partial<FfmpegIntegrity>
  if (
    typeof manifest.ffmpegSha256 !== 'string' ||
    typeof manifest.ffprobeSha256 !== 'string' ||
    !Number.isSafeInteger(manifest.ffmpegSize) ||
    !Number.isSafeInteger(manifest.ffprobeSize)
  ) {
    throw new Error('Bundled FFmpeg integrity manifest is invalid.')
  }
  return manifest as FfmpegIntegrity
}

export class FfmpegService {
  private integrityCheck: Promise<void> | null = null

  constructor(
    private readonly paths: FfmpegPaths,
    private readonly integrity?: FfmpegIntegrity,
  ) {}

  static async resolve(
    resourcesPath: string,
    options: { allowEnvironment?: boolean } = {},
  ): Promise<FfmpegService> {
    const allowEnvironment = options.allowEnvironment !== false
    const packagedDirectory = join(resourcesPath, 'windows', 'ffmpeg')
    const developmentDirectory = join(resourcesPath, 'resources', 'windows', 'ffmpeg')
    const candidates: FfmpegPaths[] = allowEnvironment
      ? [
          {
            ffmpeg: process.env.FREECUT_FFMPEG_PATH ?? '',
            ffprobe: process.env.FREECUT_FFPROBE_PATH ?? '',
          },
          {
            ffmpeg: join(packagedDirectory, 'ffmpeg.exe'),
            ffprobe: join(packagedDirectory, 'ffprobe.exe'),
          },
          {
            ffmpeg: join(developmentDirectory, 'ffmpeg.exe'),
            ffprobe: join(developmentDirectory, 'ffprobe.exe'),
          },
          { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' },
        ]
      : [
          {
            ffmpeg: join(packagedDirectory, 'ffmpeg.exe'),
            ffprobe: join(packagedDirectory, 'ffprobe.exe'),
          },
        ]
    for (const candidate of candidates) {
      if (!candidate.ffmpeg || !candidate.ffprobe) continue
      if (!candidate.ffmpeg.includes('\\') && !candidate.ffmpeg.includes('/')) {
        return new FfmpegService(candidate)
      }
      const available = await Promise.all([
        access(candidate.ffmpeg).then(() => true).catch(() => false),
        access(candidate.ffprobe).then(() => true).catch(() => false),
      ])
      if (available.every(Boolean)) {
        return new FfmpegService(
          candidate,
          allowEnvironment ? undefined : await loadIntegrity(packagedDirectory),
        )
      }
    }
    if (!allowEnvironment) {
      throw new Error('Bundled FFmpeg resources are missing from this FreeCut installation.')
    }
    return new FfmpegService({ ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' })
  }

  async probe(
    inputPath: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    await this.ensureIntegrity()
    const result = await runProcess({
      executable: this.paths.ffprobe,
      args: [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        '-of',
        'json',
        inputPath,
      ],
      timeoutMs: options?.timeoutMs ?? 60_000,
      signal: options?.signal,
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `ffprobe exited with code ${result.exitCode}.`)
    }
    return JSON.parse(result.stdout) as unknown
  }

  async versions(): Promise<{ ffmpeg: string; ffprobe: string }> {
    await this.ensureIntegrity()
    const [ffmpeg, ffprobe] = await Promise.all([
      runProcess({ executable: this.paths.ffmpeg, args: ['-version'], timeoutMs: 10_000 }),
      runProcess({ executable: this.paths.ffprobe, args: ['-version'], timeoutMs: 10_000 }),
    ])
    return {
      ffmpeg: ffmpeg.stdout.split(/\r?\n/, 1)[0] ?? '',
      ffprobe: ffprobe.stdout.split(/\r?\n/, 1)[0] ?? '',
    }
  }

  private ensureIntegrity(): Promise<void> {
    const integrity = this.integrity
    if (!integrity) return Promise.resolve()
    if (this.integrityCheck) return this.integrityCheck
    this.integrityCheck = (async () => {
      const [ffmpegStat, ffprobeStat, ffmpegHash, ffprobeHash] = await Promise.all([
        stat(this.paths.ffmpeg),
        stat(this.paths.ffprobe),
        sha256(this.paths.ffmpeg),
        sha256(this.paths.ffprobe),
      ])
      if (
        ffmpegStat.size !== integrity.ffmpegSize ||
        ffprobeStat.size !== integrity.ffprobeSize ||
        ffmpegHash !== integrity.ffmpegSha256 ||
        ffprobeHash !== integrity.ffprobeSha256
      ) {
        throw new Error('Bundled FFmpeg resources failed the installation integrity check.')
      }
    })()
    return this.integrityCheck
  }
}
