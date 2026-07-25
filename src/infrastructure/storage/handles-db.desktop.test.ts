import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { FreeCutDesktopApi } from '../../../desktop/desktop-types'
import { desktopDescriptorToHandle } from './desktop-file-system-access'
import { getHandle, saveHandle } from './handles-db'

afterEach(() => {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: undefined,
  })
})

describe('handles-db desktop storage', () => {
  it('persists opaque descriptors in Main and restores complete handle metadata', async () => {
    const descriptor = {
      token: 'workspace-token',
      path: [],
      name: 'jianji',
      kind: 'directory' as const,
    }
    const list = vi.fn(async () => [{
      id: 'current',
      handle: descriptor,
      pickedAt: 123,
      activeWorkspaceId: 'workspace-1',
    }])
    const save = vi.fn(async () => undefined)
    Object.defineProperty(window, 'freecutDesktop', {
      configurable: true,
      value: {
        app: { isDesktop: true },
        handles: { list, save },
      } as unknown as FreeCutDesktopApi,
    })
    const handle = desktopDescriptorToHandle(descriptor) as FileSystemDirectoryHandle

    await saveHandle({
      kind: 'workspace',
      id: 'current',
      handle,
      name: handle.name,
      pickedAt: 123,
      activeWorkspaceId: 'workspace-1',
    })
    const restored = await getHandle('workspace', 'current')

    expect(save).toHaveBeenCalledWith({
      kind: 'workspace',
      id: 'current',
      handle: descriptor,
      pickedAt: 123,
      activeWorkspaceId: 'workspace-1',
    })
    expect(restored).toMatchObject({
      key: 'workspace:current',
      id: 'current',
      name: 'jianji',
      pickedAt: 123,
      activeWorkspaceId: 'workspace-1',
    })
    expect(restored?.handle.isSameEntry(handle)).resolves.toBe(true)
  })
})
