import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { DesktopHandleDescriptor, FreeCutDesktopApi } from '../../../desktop/desktop-types'
import {
  desktopDescriptorToHandle,
  desktopHandleToDescriptor,
  getDesktopFileUrl,
  installDesktopFileSystemAccess,
} from './desktop-file-system-access'

const root: DesktopHandleDescriptor = {
  token: 'workspace-token',
  path: [],
  name: 'workspace',
  kind: 'directory',
}

const originalDirectoryPicker = window.showDirectoryPicker
const originalOpenFilePicker = window.showOpenFilePicker
const originalSaveFilePicker = window.showSaveFilePicker
const originalFetch = globalThis.fetch

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: undefined,
  })
  Object.defineProperties(window, {
    showDirectoryPicker: { configurable: true, value: originalDirectoryPicker },
    showOpenFilePicker: { configurable: true, value: originalOpenFilePicker },
    showSaveFilePicker: { configurable: true, value: originalSaveFilePicker },
  })
})

function installApi(overrides: Partial<FreeCutDesktopApi> = {}) {
  const api = {
    dialog: {
      pickWorkspace: vi.fn(async () => root),
      pickFiles: vi.fn(async () => []),
      saveFile: vi.fn(async () => null),
    },
    fileSystem: {
      listEntries: vi.fn(async () => []),
      ensureDirectory: vi.fn(async () => undefined),
      ensureFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ({
        bytes: new TextEncoder().encode('hello'),
        name: 'clip.txt',
        lastModified: 123,
        mimeType: 'text/plain',
      })),
      readRange: vi.fn(async () => new Uint8Array()),
      writeFile: vi.fn(async () => undefined),
      openWritable: vi.fn(async () => 'writer-1'),
      writeWritable: vi.fn(async () => undefined),
      seekWritable: vi.fn(async () => undefined),
      truncateWritable: vi.fn(async () => undefined),
      closeWritable: vi.fn(async () => undefined),
      abortWritable: vi.fn(async () => undefined),
      removeEntry: vi.fn(async () => undefined),
      moveEntry: vi.fn(async () => undefined),
    },
    ...overrides,
  } as unknown as FreeCutDesktopApi
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: api,
  })
  return api
}

describe('desktop file system access', () => {
  it('installs Electron-backed pickers and converts cancelled picks to AbortError', async () => {
    const api = installApi()
    installDesktopFileSystemAccess()

    const picked = await window.showDirectoryPicker()
    expect(desktopHandleToDescriptor(picked)).toEqual(root)
    await expect(window.showOpenFilePicker()).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.dialog.pickWorkspace).toHaveBeenCalledOnce()
  })

  it('creates and enumerates child handles with opaque descriptors', async () => {
    const api = installApi()
    vi.mocked(api.fileSystem.listEntries).mockResolvedValue([
      { name: 'projects', kind: 'directory' },
      { name: 'index.json', kind: 'file' },
    ])
    const handle = desktopDescriptorToHandle(root) as FileSystemDirectoryHandle

    const projects = await handle.getDirectoryHandle('projects')
    const file = await handle.getFileHandle('new.json', { create: true })
    expect(desktopHandleToDescriptor(projects).path).toEqual(['projects'])
    expect(desktopHandleToDescriptor(file).path).toEqual(['new.json'])
    expect(api.fileSystem.ensureFile).toHaveBeenCalledOnce()
    const keys: string[] = []
    for await (const key of handle.keys()) keys.push(key)
    expect(keys).toEqual(['projects', 'index.json'])
  })

  it('streams writable chunks through Main instead of buffering the full file', async () => {
    const api = installApi()
    const file = desktopDescriptorToHandle({
      token: root.token,
      path: ['export.mp4'],
      name: 'export.mp4',
      kind: 'file',
    }) as FileSystemFileHandle
    const writable = await file.createWritable()

    await writable.write('abc')
    await writable.seek(1)
    await writable.write(new Uint8Array([9, 8]))
    await writable.truncate(3)
    await writable.close()

    expect(api.fileSystem.openWritable).toHaveBeenCalledWith(
      expect.objectContaining({ path: ['export.mp4'] }),
      false,
    )
    expect(api.fileSystem.writeWritable).toHaveBeenNthCalledWith(
      1,
      'writer-1',
      new TextEncoder().encode('abc'),
    )
    expect(api.fileSystem.seekWritable).toHaveBeenCalledWith('writer-1', 1)
    expect(api.fileSystem.truncateWritable).toHaveBeenCalledWith('writer-1', 3)
    expect(api.fileSystem.closeWritable).toHaveBeenCalledWith('writer-1')
  })

  it('splits large Blob writes below the Main IPC limit', async () => {
    const api = installApi()
    const file = desktopDescriptorToHandle({
      token: root.token,
      path: ['large-export.mp4'],
      name: 'large-export.mp4',
      kind: 'file',
    }) as FileSystemFileHandle
    const writable = await file.createWritable()
    const bytes = new Uint8Array(17 * 1024 * 1024)
    bytes[0] = 1
    bytes[8 * 1024 * 1024] = 2
    bytes[16 * 1024 * 1024] = 3

    await writable.write(new Blob([bytes]))
    await writable.close()

    expect(api.fileSystem.writeWritable).toHaveBeenCalledTimes(3)
    expect(vi.mocked(api.fileSystem.writeWritable).mock.calls.map((call) => call[1].byteLength)).toEqual(
      [8 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024],
    )
    expect(vi.mocked(api.fileSystem.writeWritable).mock.calls.map((call) => call[1][0])).toEqual([
      1, 2, 3,
    ])
  })

  it('loads File data through the desktop media protocol instead of IPC bytes', async () => {
    const api = installApi({
      media: {
        stat: vi.fn(async () => ({
          token: root.token,
          name: 'clip.txt',
          size: 5,
          lastModified: 123,
          mimeType: 'text/plain',
        })),
        getFileUrl: vi.fn(async () => 'freecut-media://file/workspace-token/clip.txt'),
        openLocalPath: vi.fn(async () => []),
      },
    })
    globalThis.fetch = vi.fn(
      async () =>
        new Response('hello', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
    )
    const handle = desktopDescriptorToHandle({
      token: root.token,
      path: ['clip.txt'],
      name: 'clip.txt',
      kind: 'file',
    }) as FileSystemFileHandle

    const file = await handle.getFile()

    expect(file.name).toBe('clip.txt')
    expect(file.size).toBe(5)
    expect(file.type).toBe('text/plain')
    expect(file.lastModified).toBe(123)
    expect(api.media.getFileUrl).toHaveBeenCalledWith(
      expect.objectContaining({ path: ['clip.txt'] }),
    )
    expect(api.fileSystem.readFile).not.toHaveBeenCalled()
  })

  it('exposes a streaming media URL without fetching file bytes', async () => {
    const api = installApi({
      media: {
        stat: vi.fn(async () => ({
          token: root.token,
          name: 'large.mp4',
          size: 5_000_000_000,
          lastModified: 123,
          mimeType: 'video/mp4',
        })),
        getFileUrl: vi.fn(async () => 'freecut-media://file/workspace-token/large.mp4'),
        openLocalPath: vi.fn(async () => []),
      },
    })
    globalThis.fetch = vi.fn()
    const handle = desktopDescriptorToHandle({
      token: root.token,
      path: ['large.mp4'],
      name: 'large.mp4',
      kind: 'file',
    }) as FileSystemFileHandle

    await expect(getDesktopFileUrl(handle)).resolves.toBe(
      'freecut-media://file/workspace-token/large.mp4',
    )

    expect(api.media.getFileUrl).toHaveBeenCalledWith(
      expect.objectContaining({ path: ['large.mp4'] }),
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('supports standard WritableStream writers used by chunked media encoders', async () => {
    const api = installApi()
    const file = desktopDescriptorToHandle({
      token: root.token,
      path: ['proxy.mp4'],
      name: 'proxy.mp4',
      kind: 'file',
    }) as FileSystemFileHandle
    const stream = await file.createWritable()
    const writer = stream.getWriter()

    await writer.write(new Uint8Array([1, 2, 3]))
    await writer.close()

    expect(api.fileSystem.writeWritable).toHaveBeenCalledWith('writer-1', new Uint8Array([1, 2, 3]))
    expect(api.fileSystem.closeWritable).toHaveBeenCalledWith('writer-1')
  })
})
