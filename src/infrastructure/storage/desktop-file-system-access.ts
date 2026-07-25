import type { DesktopHandleDescriptor } from '../../../desktop/desktop-types'

type PermissionMode = { mode?: 'read' | 'readwrite' }
type EntryKind = 'file' | 'directory'
type WritableCommand =
  | { type: 'write'; data: Blob | BufferSource | string; position?: number | null }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number }

const WRITABLE_COMMAND_TYPES = new Set(['write', 'seek', 'truncate'])
const DESKTOP_WRITE_CHUNK_BYTES = 8 * 1024 * 1024
const desktopFileDescriptors = new WeakMap<File, DesktopHandleDescriptor>()

function getDesktopApi() {
  const api = window.freecutDesktop
  if (!api) throw new DOMException('FreeCut Desktop API is unavailable.', 'NotSupportedError')
  return api
}

function abortError(): DOMException {
  return new DOMException('The user cancelled the file picker.', 'AbortError')
}

function asDomException(error: unknown): DOMException {
  if (error instanceof DOMException) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT|not found|does not exist/i.test(message)) {
    return new DOMException(message, 'NotFoundError')
  }
  if (/EACCES|EPERM|permission|not allowed/i.test(message)) {
    return new DOMException(message, 'NotAllowedError')
  }
  if (/EEXIST|not empty|already exists/i.test(message)) {
    return new DOMException(message, 'InvalidModificationError')
  }
  if (/not a directory|not a file|ENOTDIR|EISDIR/i.test(message)) {
    return new DOMException(message, 'TypeMismatchError')
  }
  return new DOMException(message, 'UnknownError')
}

async function desktopCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw asDomException(error)
  }
}

function validateName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new DOMException('Invalid file-system entry name.', 'TypeError')
  }
}

function childDescriptor(
  parent: DesktopHandleDescriptor,
  name: string,
  kind: EntryKind,
): DesktopHandleDescriptor {
  validateName(name)
  return {
    token: parent.token,
    path: [...parent.path, name],
    name,
    kind,
  }
}

async function toBytes(data: BufferSource | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength)
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return copy
  }
  return new Uint8Array(data.slice(0))
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), { once: true })
    reader.addEventListener('error', () => reject(reader.error), { once: true })
    reader.readAsArrayBuffer(blob)
  })
}

async function writeData(
  writerId: string,
  data: Blob | BufferSource | string,
  position?: number,
): Promise<void> {
  const api = getDesktopApi()
  if (data instanceof Blob) {
    for (let offset = 0; offset < data.size; offset += DESKTOP_WRITE_CHUNK_BYTES) {
      const bytes = new Uint8Array(
        await blobArrayBuffer(data.slice(offset, offset + DESKTOP_WRITE_CHUNK_BYTES)),
      )
      if (position === undefined) {
        await api.fileSystem.writeWritable(writerId, bytes)
      } else {
        await api.fileSystem.writeWritable(writerId, bytes, position + offset)
      }
    }
    return
  }

  const bytes = await toBytes(data)
  for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_WRITE_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, offset + DESKTOP_WRITE_CHUNK_BYTES)
    if (position === undefined) {
      await api.fileSystem.writeWritable(writerId, chunk)
    } else {
      await api.fileSystem.writeWritable(writerId, chunk, position + offset)
    }
  }
}

function isWritableCommand(chunk: FileSystemWriteChunkType): chunk is WritableCommand {
  if (typeof chunk !== 'object' || chunk === null) return false
  return WRITABLE_COMMAND_TYPES.has(String((chunk as { type?: unknown }).type))
}

function hasPathPrefix(prefix: string[], candidate: string[]): boolean {
  return prefix.every((segment, index) => candidate[index] === segment)
}

abstract class DesktopFileSystemHandle {
  abstract readonly kind: EntryKind

  constructor(protected descriptor: DesktopHandleDescriptor) {}

  get name(): string {
    return this.descriptor.name
  }

  toDescriptor(): DesktopHandleDescriptor {
    return {
      ...this.descriptor,
      path: [...this.descriptor.path],
    }
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    if (!(other instanceof DesktopFileSystemHandle)) return false
    const candidate = other.descriptor
    return (
      candidate.token === this.descriptor.token &&
      candidate.kind === this.descriptor.kind &&
      candidate.path.length === this.descriptor.path.length &&
      candidate.path.every((segment, index) => segment === this.descriptor.path[index])
    )
  }

  async queryPermission(_descriptor?: PermissionMode): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(_descriptor?: PermissionMode): Promise<PermissionState> {
    return 'granted'
  }
}

class DesktopWritableFileStream extends WritableStream<FileSystemWriteChunkType> {
  private operation = Promise.resolve()
  private finished = false

  constructor(private readonly writerId: string) {
    let writeFromSink: (chunk: FileSystemWriteChunkType) => Promise<void>
    let closeFromSink: () => Promise<void>
    let abortFromSink: () => Promise<void>
    super({
      write: (chunk) => writeFromSink(chunk),
      close: () => closeFromSink(),
      abort: () => abortFromSink(),
    })
    writeFromSink = (chunk) => this.write(chunk)
    closeFromSink = () => this.commit()
    abortFromSink = () => this.discard()
  }

  write(chunk: FileSystemWriteChunkType): Promise<void> {
    if (this.finished) {
      return Promise.reject(new DOMException('Writable is closed.', 'InvalidStateError'))
    }
    return this.enqueue(async () => {
      if (isWritableCommand(chunk)) {
        if (chunk.type === 'seek') {
          await getDesktopApi().fileSystem.seekWritable(this.writerId, chunk.position)
          return
        }
        if (chunk.type === 'truncate') {
          await getDesktopApi().fileSystem.truncateWritable(this.writerId, chunk.size)
          return
        }
        await writeData(this.writerId, chunk.data, chunk.position ?? undefined)
        return
      }
      await writeData(this.writerId, chunk as Blob | BufferSource | string)
    })
  }

  seek(position: number): Promise<void> {
    if (this.finished) {
      return Promise.reject(new DOMException('Writable is closed.', 'InvalidStateError'))
    }
    return this.enqueue(() => getDesktopApi().fileSystem.seekWritable(this.writerId, position))
  }

  truncate(size: number): Promise<void> {
    if (this.finished) {
      return Promise.reject(new DOMException('Writable is closed.', 'InvalidStateError'))
    }
    return this.enqueue(() => getDesktopApi().fileSystem.truncateWritable(this.writerId, size))
  }

  close(): Promise<void> {
    return this.commit()
  }

  private commit(): Promise<void> {
    if (this.finished) return this.operation
    this.finished = true
    return this.enqueue(() => getDesktopApi().fileSystem.closeWritable(this.writerId))
  }

  private discard(): Promise<void> {
    if (this.finished) return this.operation
    this.finished = true
    return this.enqueue(() => getDesktopApi().fileSystem.abortWritable(this.writerId))
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(() => desktopCall(operation))
    this.operation = result.catch(() => undefined)
    return result
  }
}

class DesktopFileHandle extends DesktopFileSystemHandle {
  readonly kind = 'file' as const

  async getFile(): Promise<File> {
    const api = getDesktopApi()
    const [metadata, url] = await desktopCall(() =>
      Promise.all([api.media.stat(this.descriptor), api.media.getFileUrl(this.descriptor)]),
    )
    const response = await desktopCall(() => fetch(url, { cache: 'no-store' }))
    if (!response.ok) {
      throw new DOMException(
        `Unable to read desktop file (${response.status}).`,
        'NotReadableError',
      )
    }
    const blob = await desktopCall(() => response.blob())
    const file = new File([blob], metadata.name || this.name, {
      type: metadata.mimeType || blob.type,
      lastModified: metadata.lastModified,
    })
    desktopFileDescriptors.set(file, this.toDescriptor())
    return file
  }

  async createWritable(
    options: FileSystemCreateWritableOptions = {},
  ): Promise<FileSystemWritableFileStream> {
    const writerId = await desktopCall(() =>
      getDesktopApi().fileSystem.openWritable(this.descriptor, options.keepExistingData === true),
    )
    return new DesktopWritableFileStream(writerId) as unknown as FileSystemWritableFileStream
  }

  async move(parent: FileSystemDirectoryHandle, newName: string): Promise<void> {
    if (!(parent instanceof DesktopDirectoryHandle)) {
      throw new DOMException('Target is not a FreeCut desktop directory.', 'NotSupportedError')
    }
    validateName(newName)
    const parentDescriptor = parent.toDescriptor()
    await desktopCall(() =>
      getDesktopApi().fileSystem.moveEntry(this.descriptor, parentDescriptor, newName),
    )
    this.descriptor = childDescriptor(parentDescriptor, newName, 'file')
  }
}

class DesktopDirectoryHandle extends DesktopFileSystemHandle {
  readonly kind = 'directory' as const

  async getDirectoryHandle(
    name: string,
    options: FileSystemGetDirectoryOptions = {},
  ): Promise<FileSystemDirectoryHandle> {
    const descriptor = childDescriptor(this.descriptor, name, 'directory')
    const entries = await desktopCall(() => getDesktopApi().fileSystem.listEntries(this.descriptor))
    const existing = entries.find((entry) => entry.name === name)
    if (existing) {
      if (existing.kind !== 'directory') {
        throw new DOMException(`${name} is not a directory.`, 'TypeMismatchError')
      }
    } else if (options.create) {
      await desktopCall(() => getDesktopApi().fileSystem.ensureDirectory(descriptor))
    } else {
      throw new DOMException(`Directory not found: ${name}`, 'NotFoundError')
    }
    return new DesktopDirectoryHandle(descriptor) as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(
    name: string,
    options: FileSystemGetFileOptions = {},
  ): Promise<FileSystemFileHandle> {
    const descriptor = childDescriptor(this.descriptor, name, 'file')
    const entries = await desktopCall(() => getDesktopApi().fileSystem.listEntries(this.descriptor))
    const existing = entries.find((entry) => entry.name === name)
    if (existing) {
      if (existing.kind !== 'file') {
        throw new DOMException(`${name} is not a file.`, 'TypeMismatchError')
      }
    } else if (options.create) {
      await desktopCall(() => getDesktopApi().fileSystem.ensureFile(descriptor))
    } else {
      throw new DOMException(`File not found: ${name}`, 'NotFoundError')
    }
    return new DesktopFileHandle(descriptor) as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string, options: FileSystemRemoveOptions = {}): Promise<void> {
    validateName(name)
    await desktopCall(() =>
      getDesktopApi().fileSystem.removeEntry(this.descriptor, name, options.recursive),
    )
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    const entries = await desktopCall(() => getDesktopApi().fileSystem.listEntries(this.descriptor))
    for (const entry of entries) {
      yield desktopDescriptorToHandle(childDescriptor(this.descriptor, entry.name, entry.kind))
    }
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for await (const handle of this.values()) {
      yield [handle.name, handle]
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const handle of this.values()) {
      yield handle.name
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> {
    return this.entries()
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (!(possibleDescendant instanceof DesktopFileSystemHandle)) return null
    const candidate = possibleDescendant.toDescriptor()
    if (
      candidate.token !== this.descriptor.token ||
      !hasPathPrefix(this.descriptor.path, candidate.path)
    ) {
      return null
    }
    return candidate.path.slice(this.descriptor.path.length)
  }

  async move(parent: FileSystemDirectoryHandle, newName: string): Promise<void> {
    if (!(parent instanceof DesktopDirectoryHandle)) {
      throw new DOMException('Target is not a FreeCut desktop directory.', 'NotSupportedError')
    }
    validateName(newName)
    await desktopCall(() =>
      getDesktopApi().fileSystem.moveEntry(this.descriptor, parent.descriptor, newName),
    )
    this.descriptor = childDescriptor(parent.descriptor, newName, 'directory')
  }
}

export function desktopDescriptorToHandle(
  descriptor: DesktopHandleDescriptor,
): FileSystemDirectoryHandle | FileSystemFileHandle {
  return descriptor.kind === 'directory'
    ? (new DesktopDirectoryHandle(descriptor) as unknown as FileSystemDirectoryHandle)
    : (new DesktopFileHandle(descriptor) as unknown as FileSystemFileHandle)
}

export function desktopHandleToDescriptor(handle: FileSystemHandle): DesktopHandleDescriptor {
  if (!(handle instanceof DesktopFileSystemHandle)) {
    throw new DOMException('Handle is not managed by FreeCut Desktop.', 'DataError')
  }
  return handle.toDescriptor()
}

export function getDesktopFileDescriptor(file: File): DesktopHandleDescriptor | null {
  return desktopFileDescriptors.get(file) ?? null
}

/**
 * Resolve a Desktop file handle to the Main-owned media URL without reading
 * the file bytes. Native browser handles return null so Web keeps its current
 * FileSystem Access path.
 */
export async function getDesktopFileUrl(handle: FileSystemFileHandle): Promise<string | null> {
  if (!(handle instanceof DesktopFileHandle)) return null
  return desktopCall(() => getDesktopApi().media.getFileUrl(handle.toDescriptor()))
}

function toDialogFilters(types: FilePickerAcceptType[] | undefined) {
  if (!types) return undefined
  const filters = types.flatMap((type, index) => {
    const extensions = Object.values(type.accept ?? {})
      .flat()
      .map((extension) => extension.replace(/^\./, '').trim())
      .filter(Boolean)
    return extensions.length > 0
      ? [
          {
            name: type.description?.trim() || `Files ${index + 1}`,
            extensions: [...new Set(extensions)],
          },
        ]
      : []
  })
  return filters.length > 0 ? filters : undefined
}

export function installDesktopFileSystemAccess(): void {
  if (!window.freecutDesktop) return

  Object.defineProperties(window, {
    showDirectoryPicker: {
      configurable: true,
      value: async () => {
        const descriptor = await getDesktopApi().dialog.pickWorkspace()
        if (!descriptor) throw abortError()
        return desktopDescriptorToHandle(descriptor)
      },
    },
    showOpenFilePicker: {
      configurable: true,
      value: async (options: OpenFilePickerOptions = {}) => {
        const descriptors = await getDesktopApi().dialog.pickFiles({
          multiple: options.multiple,
          filters: toDialogFilters(options.types),
        })
        if (descriptors.length === 0) throw abortError()
        return descriptors.map(
          (descriptor) => desktopDescriptorToHandle(descriptor) as FileSystemFileHandle,
        )
      },
    },
    showSaveFilePicker: {
      configurable: true,
      value: async (options: SaveFilePickerOptions = {}) => {
        const descriptor = await getDesktopApi().dialog.saveFile({
          suggestedName: options.suggestedName,
          filters: toDialogFilters(options.types),
        })
        if (!descriptor) throw abortError()
        return desktopDescriptorToHandle(descriptor) as FileSystemFileHandle
      },
    },
  })
}
