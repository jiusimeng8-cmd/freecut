import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSystemExecutable, runProcess } from '../../services/process-runner'

const PRIVATE_FILE_NAMES = ['handles.json', 'tasks.json', 'credentials.json']

let currentUserSidPromise: Promise<string> | null = null

async function currentUserSid(): Promise<string> {
  if (currentUserSidPromise) return currentUserSidPromise
  currentUserSidPromise = (async () => {
    const result = await runProcess({
      executable: resolveSystemExecutable('whoami.exe'),
      args: ['/user', '/fo', 'csv', '/nh'],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    })
    const sid = result.stdout.match(/,"(S-\d(?:-\d+)+)"\s*$/m)?.[1]
    if (result.exitCode !== 0 || !sid) {
      throw new Error(result.stderr.trim() || 'Unable to resolve the current Windows user SID.')
    }
    return sid
  })()
  return currentUserSidPromise
}

async function restrictWindowsPath(path: string, directory: boolean): Promise<void> {
  const sid = await currentUserSid()
  const inheritance = directory ? '(OI)(CI)F' : 'F'
  const result = await runProcess({
    executable: resolveSystemExecutable('icacls.exe'),
    args: [
      path,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:${inheritance}`,
      `*S-1-5-18:${inheritance}`,
    ],
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Unable to secure Windows path: ${path}`)
  }
}

export async function restrictWindowsFile(path: string): Promise<void> {
  await restrictWindowsPath(path, false)
}

export async function prepareWindowsPrivateDataDirectory(userDataPath: string): Promise<string> {
  const privateDirectory = join(userDataPath, 'private')
  await mkdir(privateDirectory, { recursive: true })
  await restrictWindowsPath(privateDirectory, true)

  for (const name of PRIVATE_FILE_NAMES.flatMap((fileName) => [fileName, `${fileName}.bak`])) {
    const source = join(userDataPath, name)
    const destination = join(privateDirectory, name)
    const [sourceStat, destinationStat] = await Promise.all([
      stat(source).catch(() => null),
      stat(destination).catch(() => null),
    ])
    if (sourceStat?.isFile() && !destinationStat) {
      await rename(source, destination)
    } else if (sourceStat?.isFile()) {
      await restrictWindowsFile(source)
    }
  }

  const entries = await readdir(privateDirectory, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => restrictWindowsFile(join(privateDirectory, entry.name))),
  )
  return privateDirectory
}
