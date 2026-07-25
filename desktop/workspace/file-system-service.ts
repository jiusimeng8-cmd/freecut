import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type {
  DesktopEntryDescriptor,
  DesktopFileDescriptor,
  DesktopHandleDescriptor,
} from '../desktop-types'
import { PathRegistry } from './path-registry'

interface WritableSession {
  file: Awaited<ReturnType<typeof open>>
  targetPath: string
  temporaryPath: string
  position: number
}

const MAX_BUFFERED_FILE_BYTES = 64 * 1024 * 1024
const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.srt': 'application/x-subrip',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
}

export function mimeTypeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLocaleLowerCase('en-US')] ?? 'application/octet-stream'
}

export class FileSystemService {
  private readonly writers = new Map<string, WritableSession>()
  private readonly replacements = new Map<string, Promise<void>>()

  constructor(readonly registry: PathRegistry) {}

  async listEntries(handle: DesktopHandleDescriptor): Promise<DesktopEntryDescriptor[]> {
    if (handle.kind !== 'directory') throw new Error('Handle is not a directory.')
    const entries = await readdir(this.registry.resolve(handle), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
  }

  async ensureDirectory(handle: DesktopHandleDescriptor): Promise<void> {
    if (handle.kind !== 'directory') throw new Error('Handle is not a directory.')
    await mkdir(this.registry.resolve(handle), { recursive: true })
  }

  async ensureFile(handle: DesktopHandleDescriptor): Promise<void> {
    if (handle.kind !== 'file') throw new Error('Handle is not a file.')
    const target = this.registry.resolve(handle)
    await this.recoverInterruptedReplacement(target)
    await mkdir(dirname(target), { recursive: true })
    const file = await open(target, 'a')
    await file.close()
  }

  async readFile(handle: DesktopHandleDescriptor): Promise<{
    bytes: Uint8Array
    name: string
    lastModified: number
    mimeType: string
  }> {
    if (handle.kind !== 'file') throw new Error('Handle is not a file.')
    const target = this.registry.resolve(handle)
    await this.recoverInterruptedReplacement(target)
    const metadata = await stat(target)
    if (metadata.size > MAX_BUFFERED_FILE_BYTES) {
      throw new Error('File is too large for buffered IPC; use the desktop media URL.')
    }
    const bytes = await readFile(target)
    return {
      bytes,
      name: basename(target),
      lastModified: Math.round(metadata.mtimeMs),
      mimeType: mimeTypeForPath(target),
    }
  }

  async readRange(
    handle: DesktopHandleDescriptor,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    if (handle.kind !== 'file') throw new Error('Handle is not a file.')
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error('Invalid file byte range.')
    }
    if (end - start > MAX_IPC_CHUNK_BYTES) {
      throw new Error('File byte range exceeds the desktop IPC chunk limit.')
    }
    const target = this.registry.resolve(handle)
    await this.recoverInterruptedReplacement(target)
    const file = await open(target, 'r')
    try {
      const metadata = await file.stat()
      const boundedEnd = Math.min(end, metadata.size)
      const output = Buffer.alloc(Math.max(0, boundedEnd - start))
      if (output.length > 0) {
        await file.read(output, 0, output.length, start)
      }
      return output
    } finally {
      await file.close()
    }
  }

  async writeFile(handle: DesktopHandleDescriptor, bytes: Uint8Array): Promise<void> {
    if (handle.kind !== 'file') throw new Error('Handle is not a file.')
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IPC_CHUNK_BYTES) {
      throw new Error('File write exceeds the desktop IPC chunk limit.')
    }
    const target = this.registry.resolve(handle)
    await mkdir(dirname(target), { recursive: true })
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    await writeFile(temporary, bytes)
    try {
      const temporaryFile = await open(temporary, 'r+')
      try {
        await temporaryFile.sync()
      } finally {
        await temporaryFile.close()
      }
      await this.replaceTarget(temporary, target)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async openWritable(handle: DesktopHandleDescriptor, keepExistingData = false): Promise<string> {
    if (handle.kind !== 'file') throw new Error('Handle is not a file.')
    const targetPath = this.registry.resolve(handle)
    await this.recoverInterruptedReplacement(targetPath)
    await mkdir(dirname(targetPath), { recursive: true })
    const writerId = randomUUID()
    const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${writerId}.writing`)
    if (keepExistingData) {
      await copyFile(targetPath, temporaryPath)
    }
    const file = await open(temporaryPath, keepExistingData ? 'r+' : 'w+')
    this.writers.set(writerId, {
      file,
      targetPath,
      temporaryPath,
      position: 0,
    })
    return writerId
  }

  async writeWritable(writerId: string, bytes: Uint8Array, position?: number): Promise<void> {
    const writer = this.requireWriter(writerId)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IPC_CHUNK_BYTES) {
      throw new Error('Writable chunk exceeds the desktop IPC chunk limit.')
    }
    if (position !== undefined) {
      if (!Number.isSafeInteger(position) || position < 0) {
        throw new Error('Invalid writable position.')
      }
      writer.position = position
    }
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await writer.file.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        writer.position,
      )
      if (result.bytesWritten === 0) throw new Error('Desktop file write made no progress.')
      writer.position += result.bytesWritten
      offset += result.bytesWritten
    }
  }

  async seekWritable(writerId: string, position: number): Promise<void> {
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new Error('Invalid writable position.')
    }
    this.requireWriter(writerId).position = position
  }

  async truncateWritable(writerId: string, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('Invalid writable size.')
    }
    const writer = this.requireWriter(writerId)
    await writer.file.truncate(size)
    writer.position = Math.min(writer.position, size)
  }

  async closeWritable(writerId: string): Promise<void> {
    const writer = this.requireWriter(writerId)
    this.writers.delete(writerId)
    try {
      await writer.file.sync()
      await writer.file.close()
      await this.replaceTarget(writer.temporaryPath, writer.targetPath)
    } catch (error) {
      await writer.file.close().catch(() => undefined)
      await rm(writer.temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async abortWritable(writerId: string): Promise<void> {
    const writer = this.writers.get(writerId)
    if (!writer) return
    this.writers.delete(writerId)
    await writer.file.close().catch(() => undefined)
    await rm(writer.temporaryPath, { force: true })
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.writers.keys()].map((writerId) => this.abortWritable(writerId)))
  }

  async removeEntry(
    parent: DesktopHandleDescriptor,
    name: string,
    recursive = false,
  ): Promise<void> {
    const target = this.registry.descriptor(parent, name, 'file')
    await rm(this.registry.resolve(target), { recursive, force: false })
  }

  async moveEntry(
    source: DesktopHandleDescriptor,
    destinationParent: DesktopHandleDescriptor,
    newName: string,
  ): Promise<void> {
    const sourcePath = this.registry.resolve(source)
    const destination = this.registry.descriptor(destinationParent, newName, source.kind)
    const destinationPath = this.registry.resolve(destination)
    await this.recoverInterruptedReplacement(sourcePath)
    await this.recoverInterruptedReplacement(destinationPath)
    await mkdir(dirname(destinationPath), { recursive: true })
    const destinationMetadata = await stat(destinationPath).catch(() => null)
    if (destinationMetadata?.isDirectory()) {
      throw new Error('Cannot replace an existing directory while moving an entry.')
    }
    if (destinationMetadata) {
      if (source.kind !== 'file' || !destinationMetadata.isFile()) {
        throw new Error('Cannot replace the existing destination entry.')
      }
      await this.replaceTarget(sourcePath, destinationPath)
      return
    }
    await rename(sourcePath, destinationPath)
  }

  async stat(handle: DesktopHandleDescriptor): Promise<DesktopFileDescriptor> {
    const target = this.registry.resolve(handle)
    if (handle.kind === 'file') {
      await this.recoverInterruptedReplacement(target)
    }
    const metadata = await stat(target)
    return {
      token: handle.token,
      name: basename(target),
      size: metadata.size,
      lastModified: Math.round(metadata.mtimeMs),
      mimeType: metadata.isFile() ? mimeTypeForPath(target) : 'inode/directory',
    }
  }

  async registerLocalFiles(path: string, recursive = false): Promise<DesktopHandleDescriptor[]> {
    if (!isAbsolute(path)) throw new Error('Local media path must be absolute.')
    const root = await this.registry.register(path)
    if (root.kind === 'file') return [root]

    const files: DesktopHandleDescriptor[] = []
    const visit = async (directory: DesktopHandleDescriptor): Promise<void> => {
      const entries = await readdir(this.registry.resolve(directory), { withFileTypes: true })
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push(this.registry.descriptor(directory, entry.name, 'file'))
          if (files.length > 10_000) {
            throw new Error('Local path contains more than 10,000 files.')
          }
        } else if (recursive && entry.isDirectory()) {
          await visit(this.registry.descriptor(directory, entry.name, 'directory'))
        }
      }
    }
    await visit(root)
    return files
  }

  private requireWriter(writerId: string): WritableSession {
    const writer = this.writers.get(writerId)
    if (!writer) throw new Error('Unknown or closed desktop writable.')
    return writer
  }

  private async replaceTarget(sourcePath: string, targetPath: string): Promise<void> {
    return this.withReplacementLock(targetPath, async () => {
      await this.recoverInterruptedReplacementUnlocked(targetPath)
      try {
        await rename(sourcePath, targetPath)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM') throw error
      }

      const backupPath = this.replacementBackupPath(targetPath)
      await rename(targetPath, backupPath)
      try {
        await rename(sourcePath, targetPath)
      } catch (error) {
        await rename(backupPath, targetPath).catch(() => undefined)
        throw error
      }
      await rm(backupPath, { force: true })
    })
  }

  private recoverInterruptedReplacement(targetPath: string): Promise<void> {
    return this.withReplacementLock(targetPath, () =>
      this.recoverInterruptedReplacementUnlocked(targetPath),
    )
  }

  private async recoverInterruptedReplacementUnlocked(targetPath: string): Promise<void> {
    const backupPath = this.replacementBackupPath(targetPath)
    const backup = await stat(backupPath).catch(() => null)
    if (!backup) return
    const target = await stat(targetPath).catch(() => null)
    if (target) {
      await rm(backupPath, { force: true })
      return
    }
    await rename(backupPath, targetPath)
  }

  private replacementBackupPath(targetPath: string): string {
    return join(dirname(targetPath), `.${basename(targetPath)}.freecut-backup`)
  }

  private withReplacementLock(targetPath: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.replacements.get(targetPath) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.catch(() => undefined)
    this.replacements.set(targetPath, settled)
    return result.finally(() => {
      if (this.replacements.get(targetPath) === settled) {
        this.replacements.delete(targetPath)
      }
    })
  }
}
