import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, normalize, relative, resolve } from 'node:path'
import type { DesktopHandleDescriptor } from '../desktop-types'

interface RegisteredPath {
  path: string
  kind: 'file' | 'directory'
}

function pathKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function validateSegments(segments: readonly string[]): void {
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      throw new Error('Invalid file-system path segment.')
    }
  }
}

export class PathRegistry {
  private readonly byToken = new Map<string, RegisteredPath>()
  private readonly tokenByPath = new Map<string, string>()

  async register(path: string): Promise<DesktopHandleDescriptor> {
    if (!isAbsolute(path)) {
      throw new Error('Desktop file-system paths must be absolute.')
    }
    const absolutePath = await realpath(resolve(path))
    const metadata = await stat(absolutePath)
    const kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : null
    if (!kind) {
      throw new Error('Only files and directories can be registered.')
    }
    const key = pathKey(absolutePath)
    const existingToken = this.tokenByPath.get(key)
    const token = existingToken ?? randomUUID()
    this.byToken.set(token, { path: absolutePath, kind })
    this.tokenByPath.set(key, token)
    return { token, path: [], name: basename(absolutePath), kind }
  }

  resolve(handle: DesktopHandleDescriptor): string {
    const root = this.byToken.get(handle.token)
    if (!root) throw new Error('Unknown or expired desktop file handle.')
    validateSegments(handle.path)
    if (root.kind === 'file' && handle.path.length > 0) {
      throw new Error('A file handle cannot contain child path segments.')
    }
    const target = resolve(root.path, ...handle.path)
    const relativePath = relative(root.path, target)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('Desktop path escapes its authorized root.')
    }
    let current = root.path
    for (const segment of handle.path) {
      current = resolve(current, segment)
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error('Symbolic links are not allowed inside an authorized desktop root.')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        break
      }
    }
    return target
  }

  descriptor(
    parent: DesktopHandleDescriptor,
    name: string,
    kind: 'file' | 'directory',
  ): DesktopHandleDescriptor {
    validateSegments([name])
    if (parent.kind !== 'directory') throw new Error('Parent handle is not a directory.')
    return {
      token: parent.token,
      path: [...parent.path, name],
      name,
      kind,
    }
  }

  async isAuthorized(path: string): Promise<boolean> {
    if (!isAbsolute(path)) return false
    const target = await realpath(resolve(path)).catch(() => null)
    if (!target) return false
    for (const root of this.byToken.values()) {
      const pathFromRoot = relative(root.path, target)
      if (
        pathFromRoot === '' ||
        (root.kind === 'directory' &&
          !pathFromRoot.startsWith('..') &&
          !isAbsolute(pathFromRoot))
      ) {
        return true
      }
    }
    return false
  }
}
