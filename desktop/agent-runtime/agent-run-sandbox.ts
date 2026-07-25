import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  AGENT_SANDBOX_MAX_WRITE_BYTES,
  type AgentSandboxStatus,
  type AgentSandboxWriteInput,
} from './agent-thread-types'

const idPattern = /^[a-z0-9][a-z0-9._:-]{0,159}$/i

function validateRunId(runId: string): string {
  if (!idPattern.test(runId)) throw new Error('Invalid Agent runId.')
  return runId
}

function validateSegments(segments: string[]): string[] {
  if (segments.length === 0 || segments.length > 64) {
    throw new Error('Invalid Agent sandbox path.')
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > 255 ||
      segment === '.' ||
      segment === '..' ||
      /[<>:"/\\|?*]/.test(segment) ||
      segment.includes('\0')
    ) {
      throw new Error('Invalid Agent sandbox path.')
    }
  }
  return segments
}

export class AgentRunSandbox {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  async create(runId: string): Promise<void> {
    const runRoot = this.runRoot(runId)
    await mkdir(runRoot, { recursive: true })
    await this.assertDirectoryIsNotLink(runRoot)
  }

  async write(input: AgentSandboxWriteInput): Promise<number> {
    const runRoot = this.runRoot(input.runId)
    const segments = validateSegments(input.path)
    if (input.bytes.byteLength > AGENT_SANDBOX_MAX_WRITE_BYTES) {
      throw new Error('Agent sandbox write exceeds the supported size.')
    }
    await this.assertDirectoryIsNotLink(runRoot)
    let parent = runRoot
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment)
      await mkdir(parent, { recursive: true })
      await this.assertDirectoryIsNotLink(parent)
    }
    const destination = resolve(runRoot, ...segments)
    const escaped = relative(runRoot, destination)
    if (isAbsolute(escaped) || escaped.startsWith('..')) {
      throw new Error('Agent sandbox path escaped the run directory.')
    }
    const existing = await lstat(destination).catch(() => null)
    if (existing?.isSymbolicLink() || existing?.isDirectory()) {
      throw new Error('Agent sandbox destination must be a regular file.')
    }
    await writeFile(destination, input.bytes, { mode: 0o600 })
    return input.bytes.byteLength
  }

  async status(runId: string): Promise<AgentSandboxStatus> {
    const runRoot = this.runRoot(runId)
    const rootMetadata = await lstat(runRoot).catch(() => null)
    if (!rootMetadata) return { runId, exists: false, fileCount: 0, totalBytes: 0 }
    await this.assertDirectoryIsNotLink(runRoot)
    const summary = await this.measure(runRoot)
    return { runId, exists: true, ...summary }
  }

  async cleanup(runId: string): Promise<boolean> {
    const runRoot = this.runRoot(runId)
    const exists = Boolean(await lstat(runRoot).catch(() => null))
    await rm(runRoot, { recursive: true, force: true })
    return exists
  }

  async cleanupExcept(runIds: ReadonlySet<string>): Promise<number> {
    await this.initialize()
    const entries = await readdir(this.root, { withFileTypes: true })
    const retainedDirectories = new Set([...runIds].map((runId) => this.runDirectoryName(runId)))
    let removed = 0
    for (const entry of entries) {
      if (entry.isDirectory() && retainedDirectories.has(entry.name)) continue
      await rm(join(this.root, entry.name), { recursive: true, force: true })
      removed += 1
    }
    return removed
  }

  async cleanupAll(): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
    return entries.filter((entry) => entry.isDirectory()).length
  }

  private runRoot(runId: string): string {
    return join(this.root, this.runDirectoryName(validateRunId(runId)))
  }

  private runDirectoryName(runId: string): string {
    return createHash('sha256').update(runId).digest('hex')
  }

  private async assertDirectoryIsNotLink(path: string): Promise<void> {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Agent sandbox directory is not a regular directory.')
    }
  }

  private async measure(path: string): Promise<{ fileCount: number; totalBytes: number }> {
    let fileCount = 0
    let totalBytes = 0
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      const metadata = await lstat(child)
      if (metadata.isSymbolicLink()) {
        throw new Error('Agent sandbox contains an unsupported symbolic link.')
      }
      if (metadata.isDirectory()) {
        const nested = await this.measure(child)
        fileCount += nested.fileCount
        totalBytes += nested.totalBytes
      } else if (metadata.isFile()) {
        const file = await stat(child)
        fileCount += 1
        totalBytes += file.size
      }
    }
    return { fileCount, totalBytes }
  }
}
