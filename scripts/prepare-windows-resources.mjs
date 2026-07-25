import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outputDirectory = join(root, 'resources', 'windows', 'ffmpeg')

async function exists(path) {
  return access(path).then(() => true).catch(() => false)
}

function pathCandidates(executable) {
  if (process.platform !== 'win32') return [executable]
  const result = spawnSync('where.exe', [executable], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : []
}

async function resolveExecutable(configured, executable) {
  const candidates = [configured, ...pathCandidates(executable)].filter(Boolean)
  for (const candidate of candidates) {
    if (await exists(candidate)) return realpath(candidate)
  }
  throw new Error(
    `Unable to find ${executable}. Set ${
      executable === 'ffmpeg.exe' ? 'FREECUT_FFMPEG_PATH' : 'FREECUT_FFPROBE_PATH'
    }.`,
  )
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', rejectHash)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function versionLine(executable) {
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${executable} -version failed.`)
  }
  return result.stdout.split(/\r?\n/, 1)[0] ?? ''
}

async function copyWhenChanged(source, destination) {
  const [sourceStat, destinationStat] = await Promise.all([
    stat(source),
    stat(destination).catch(() => null),
  ])
  const sourceHash = await sha256(source)
  if (destinationStat?.size === sourceStat.size && (await sha256(destination)) === sourceHash) {
    return { size: sourceStat.size, sha256: sourceHash }
  }
  await copyFile(source, destination)
  return { size: sourceStat.size, sha256: sourceHash }
}

const ffmpeg = await resolveExecutable(process.env.FREECUT_FFMPEG_PATH, 'ffmpeg.exe')
const ffprobe = await resolveExecutable(process.env.FREECUT_FFPROBE_PATH, 'ffprobe.exe')
await mkdir(outputDirectory, { recursive: true })
const [ffmpegResource, ffprobeResource] = await Promise.all([
  copyWhenChanged(ffmpeg, join(outputDirectory, 'ffmpeg.exe')),
  copyWhenChanged(ffprobe, join(outputDirectory, 'ffprobe.exe')),
])

const distributionRoot = dirname(dirname(ffmpeg))
const noticeFiles = []
for (const name of ['LICENSE', 'README.txt']) {
  const source = join(distributionRoot, name)
  if (!(await exists(source))) continue
  await copyWhenChanged(source, join(outputDirectory, name))
  noticeFiles.push(name)
}

await writeFile(
  join(outputDirectory, 'manifest.json'),
  JSON.stringify(
    {
      ffmpeg: versionLine(ffmpeg),
      ffprobe: versionLine(ffprobe),
      ffmpegSha256: ffmpegResource.sha256,
      ffprobeSha256: ffprobeResource.sha256,
      ffmpegSize: ffmpegResource.size,
      ffprobeSize: ffprobeResource.size,
      noticeFiles,
    },
    null,
    2,
  ),
)

process.stdout.write(`Prepared Windows FFmpeg resources in ${outputDirectory}\n`)
