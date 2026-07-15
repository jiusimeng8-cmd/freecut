const API_PREFIX = '/__freecut_dev_workspace'
const BRIDGE_HEADER = 'X-FreeCut-Dev-Workspace'

type PermissionMode = { mode?: 'read' | 'readwrite' }
type EntryKind = 'file' | 'directory'

interface EntryDescriptor {
  name: string
  kind: EntryKind
}

type WritableCommand =
  | { type: 'write'; data: Blob | BufferSource | string; position?: number | null }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number }

const WRITABLE_COMMAND_TYPES = new Set(['write', 'seek', 'truncate'])

function apiUrl(action: string, path: string[], params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ path: path.join('/'), ...params })
  return `${API_PREFIX}${action}?${search.toString()}`
}

function toDomException(status: number, message: string): DOMException {
  if (status === 404) return new DOMException(message, 'NotFoundError')
  if (status === 403) return new DOMException(message, 'NotAllowedError')
  if (status === 409) return new DOMException(message, 'InvalidModificationError')
  return new DOMException(message, 'UnknownError')
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw toDomException(response.status, body?.error ?? response.statusText)
}

async function toBytes(data: Blob | BufferSource | string): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.byteLength)
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return bytes
  }
  return new Uint8Array(data.slice(0))
}

function replaceBytes(
  current: Uint8Array<ArrayBuffer>,
  position: number,
  replacement: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const nextLength = Math.max(current.length, position + replacement.length)
  const next = new Uint8Array(nextLength)
  next.set(current)
  next.set(replacement, position)
  return next
}

class DevWorkspaceWritable {
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array()
  private position = 0
  private closed = false

  constructor(
    private readonly path: string[],
    initialBytes?: Uint8Array<ArrayBuffer>,
  ) {
    if (initialBytes) {
      this.bytes = initialBytes
      this.position = initialBytes.length
    }
  }

  async write(chunk: FileSystemWriteChunkType): Promise<void> {
    if (this.closed) throw new DOMException('Writable is closed', 'InvalidStateError')

    if (isWritableCommand(chunk)) {
      await this.writeCommand(chunk)
      return
    }

    await this.writeData(chunk as Blob | BufferSource | string)
  }

  private async writeCommand(command: WritableCommand): Promise<void> {
    if (command.type === 'seek') return this.seek(command.position)
    if (command.type === 'truncate') return this.truncate(command.size)
    if (typeof command.position === 'number') this.position = command.position
    await this.writeData(command.data)
  }

  private async writeData(chunk: Blob | BufferSource | string): Promise<void> {
    const data = await toBytes(chunk)
    this.bytes = replaceBytes(this.bytes, this.position, data)
    this.position += data.length
  }

  async seek(position: number): Promise<void> {
    if (position < 0) throw new DOMException('Position must be non-negative', 'InvalidStateError')
    this.position = position
  }

  async truncate(size: number): Promise<void> {
    if (size < 0) throw new DOMException('Size must be non-negative', 'InvalidStateError')
    const next = new Uint8Array(size)
    next.set(this.bytes.subarray(0, size))
    this.bytes = next
    this.position = Math.min(this.position, size)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await requireOk(
      await fetch(apiUrl('/file', this.path), {
        method: 'PUT',
        body: this.bytes,
      }),
    )
  }

  async abort(): Promise<void> {
    this.closed = true
  }
}

abstract class DevWorkspaceHandle {
  abstract readonly kind: EntryKind

  constructor(
    readonly path: string[],
    readonly name: string,
  ) {}

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (
      other instanceof DevWorkspaceHandle &&
      other.kind === this.kind &&
      other.path.join('/') === this.path.join('/')
    )
  }

  async queryPermission(_descriptor?: PermissionMode): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(_descriptor?: PermissionMode): Promise<PermissionState> {
    return 'granted'
  }
}

function isWritableCommand(chunk: FileSystemWriteChunkType): chunk is WritableCommand {
  if (typeof chunk !== 'object' || chunk === null) return false
  return WRITABLE_COMMAND_TYPES.has(String((chunk as { type?: unknown }).type))
}

function hasPathPrefix(prefix: string[], candidate: string[]): boolean {
  return prefix.every((segment, index) => candidate[index] === segment)
}

class DevWorkspaceFileHandle extends DevWorkspaceHandle {
  readonly kind = 'file' as const

  async getFile(): Promise<File> {
    const response = await requireOk(await fetch(apiUrl('/file', this.path), { cache: 'no-store' }))
    const lastModified = Number(response.headers.get('X-FreeCut-Last-Modified')) || Date.now()
    const encodedName = response.headers.get('X-FreeCut-File-Name')
    const name = encodedName ? decodeURIComponent(encodedName) : this.name
    return new File([await response.blob()], name, {
      lastModified,
      type: response.headers.get('Content-Type') ?? '',
    })
  }

  async createWritable(
    options: FileSystemCreateWritableOptions = {},
  ): Promise<FileSystemWritableFileStream> {
    const initialBytes = options.keepExistingData
      ? new Uint8Array(await (await this.getFile()).arrayBuffer())
      : undefined
    return new DevWorkspaceWritable(
      this.path,
      initialBytes,
    ) as unknown as FileSystemWritableFileStream
  }

  async move(parent: FileSystemDirectoryHandle, newName: string): Promise<void> {
    if (!(parent instanceof DevWorkspaceDirectoryHandle)) {
      throw new DOMException('Target directory is not a development workspace', 'NotSupportedError')
    }
    await requireOk(
      await fetch(`${API_PREFIX}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.path.join('/'),
          to: [...parent.path, newName].join('/'),
        }),
      }),
    )
  }
}

class DevWorkspaceDirectoryHandle extends DevWorkspaceHandle {
  readonly kind = 'directory' as const

  async getDirectoryHandle(
    name: string,
    options: FileSystemGetDirectoryOptions = {},
  ): Promise<FileSystemDirectoryHandle> {
    const path = [...this.path, name]
    await requireOk(
      await fetch(apiUrl('/directory', path, { create: options.create ? '1' : '0' }), {
        method: 'POST',
      }),
    )
    return new DevWorkspaceDirectoryHandle(path, name) as unknown as FileSystemDirectoryHandle
  }

  async getFileHandle(
    name: string,
    options: FileSystemGetFileOptions = {},
  ): Promise<FileSystemFileHandle> {
    const path = [...this.path, name]
    await requireOk(
      await fetch(apiUrl('/file-handle', path, { create: options.create ? '1' : '0' }), {
        method: 'POST',
      }),
    )
    return new DevWorkspaceFileHandle(path, name) as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string, options: FileSystemRemoveOptions = {}): Promise<void> {
    await requireOk(
      await fetch(
        apiUrl('/entry', [...this.path, name], { recursive: options.recursive ? '1' : '0' }),
        {
          method: 'DELETE',
        },
      ),
    )
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    const response = await requireOk(
      await fetch(apiUrl('/entries', this.path), { cache: 'no-store' }),
    )
    const entries = (await response.json()) as EntryDescriptor[]
    for (const entry of entries) {
      const path = [...this.path, entry.name]
      yield entry.kind === 'directory'
        ? (new DevWorkspaceDirectoryHandle(
            path,
            entry.name,
          ) as unknown as FileSystemDirectoryHandle)
        : (new DevWorkspaceFileHandle(path, entry.name) as unknown as FileSystemFileHandle)
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
    if (!(possibleDescendant instanceof DevWorkspaceHandle)) return null
    if (!hasPathPrefix(this.path, possibleDescendant.path)) return null
    return possibleDescendant.path.slice(this.path.length)
  }
}

async function fetchDevWorkspaceInfo(): Promise<{ name: string } | null> {
  try {
    const response = await fetch(`${API_PREFIX}/info`, { cache: 'no-store' })
    if (!response.ok || response.headers.get(BRIDGE_HEADER) !== '1') return null
    return (await response.json()) as { name: string }
  } catch {
    return null
  }
}

export async function getDevWorkspaceHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!import.meta.env.DEV) return null
  const info = await fetchDevWorkspaceInfo()
  if (!info) return null
  return new DevWorkspaceDirectoryHandle([], info.name) as unknown as FileSystemDirectoryHandle
}
