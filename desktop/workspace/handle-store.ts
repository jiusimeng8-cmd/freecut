import type { DesktopHandleDescriptor } from '../desktop-types'
import { SerializedJsonFile } from '../services/serialized-json-file'
import { PathRegistry } from './path-registry'

export type DesktopHandleKind = 'workspace' | 'media' | 'project-folder'

interface StoredHandle {
  kind: DesktopHandleKind
  id: string
  absolutePath: string
  handleKind: 'file' | 'directory'
  pickedAt: number
  lastSeenPath?: string
  lastSeenSize?: number
  lastSeenMtime?: number
  activeWorkspaceId?: string
}

export interface DesktopHandleStoreEntry {
  id: string
  handle: DesktopHandleDescriptor
  pickedAt: number
  lastSeenPath?: string
  lastSeenSize?: number
  lastSeenMtime?: number
  activeWorkspaceId?: string
}

function key(kind: DesktopHandleKind, id: string): string {
  return `${kind}:${id}`
}

export class DesktopHandleStore {
  private readonly file: SerializedJsonFile<StoredHandle[]>

  constructor(
    filePath: string,
    private readonly registry: PathRegistry,
  ) {
    this.file = new SerializedJsonFile(filePath, () => [])
  }

  async get(kind: DesktopHandleKind, id: string): Promise<DesktopHandleDescriptor | null> {
    const entry = (await this.file.read()).find(
      (candidate) => key(candidate.kind, candidate.id) === key(kind, id),
    )
    if (!entry) return null
    return this.registry.register(entry.absolutePath).catch(() => null)
  }

  async list(kind: DesktopHandleKind): Promise<DesktopHandleStoreEntry[]> {
    const matches = (await this.file.read())
      .filter((entry) => entry.kind === kind)
      .sort((left, right) => right.pickedAt - left.pickedAt)
    const result: DesktopHandleStoreEntry[] = []
    for (const entry of matches) {
      const handle = await this.registry.register(entry.absolutePath).catch(() => null)
      if (!handle) continue
      result.push({
        id: entry.id,
        handle,
        pickedAt: entry.pickedAt,
        lastSeenPath: entry.lastSeenPath,
        lastSeenSize: entry.lastSeenSize,
        lastSeenMtime: entry.lastSeenMtime,
        activeWorkspaceId: entry.activeWorkspaceId,
      })
    }
    return result
  }

  async save(input: {
    kind: DesktopHandleKind
    id: string
    handle: DesktopHandleDescriptor
    pickedAt: number
    lastSeenPath?: string
    lastSeenSize?: number
    lastSeenMtime?: number
    activeWorkspaceId?: string
  }): Promise<void> {
    const stored: StoredHandle = {
      kind: input.kind,
      id: input.id,
      absolutePath: this.registry.resolve(input.handle),
      handleKind: input.handle.kind,
      pickedAt: input.pickedAt,
      lastSeenPath: input.lastSeenPath,
      lastSeenSize: input.lastSeenSize,
      lastSeenMtime: input.lastSeenMtime,
      activeWorkspaceId: input.activeWorkspaceId,
    }
    await this.file.update((entries) => {
      const index = entries.findIndex(
        (entry) => key(entry.kind, entry.id) === key(stored.kind, stored.id),
      )
      if (index === -1) return [...entries, stored]
      const next = [...entries]
      next[index] = stored
      return next
    })
  }

  async delete(kind: DesktopHandleKind, id: string): Promise<void> {
    await this.file.update((entries) =>
      entries.filter((entry) => key(entry.kind, entry.id) !== key(kind, id)),
    )
  }
}
