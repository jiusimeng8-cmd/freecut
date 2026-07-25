// @vitest-environment node

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const renameFailure = vi.hoisted(() => ({
  attempts: 0,
  enabled: false,
  targetName: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      if (renameFailure.enabled && newPath.endsWith(renameFailure.targetName)) {
        renameFailure.attempts += 1
        if (renameFailure.attempts <= 2) {
          const error = new Error(
            renameFailure.attempts === 1
              ? 'simulated Windows rename conflict'
              : 'simulated replacement failure',
          ) as NodeJS.ErrnoException
          error.code = renameFailure.attempts === 1 ? 'EPERM' : 'EIO'
          throw error
        }
      }
      await actual.rename(oldPath, newPath)
    },
  }
})

import { FileSystemService } from './file-system-service'
import { PathRegistry } from './path-registry'

const roots: string[] = []

afterEach(async () => {
  renameFailure.attempts = 0
  renameFailure.enabled = false
  renameFailure.targetName = ''
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'freecut-desktop-fs-'))
  roots.push(root)
  const registry = new PathRegistry()
  const rootHandle = await registry.register(root)
  return { root, registry, rootHandle, service: new FileSystemService(registry) }
}

describe('FileSystemService', () => {
  it('round-trips an atomic file write through an authorized root', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const file = registry.descriptor(rootHandle, 'project.json', 'file')
    await service.writeFile(file, new TextEncoder().encode('{"ok":true}'))
    expect(await readFile(join(root, 'project.json'), 'utf8')).toBe('{"ok":true}')
    expect(new TextDecoder().decode((await service.readFile(file)).bytes)).toBe('{"ok":true}')
  })

  it('keeps the previous file when replacement fails after a Windows rename conflict', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const targetPath = join(root, 'project.json')
    await writeFile(targetPath, 'original')
    const file = registry.descriptor(rootHandle, 'project.json', 'file')
    renameFailure.targetName = 'project.json'
    renameFailure.enabled = true

    await expect(service.writeFile(file, new TextEncoder().encode('replacement'))).rejects.toThrow(
      'simulated replacement failure',
    )
    renameFailure.enabled = false

    expect(await readFile(targetPath, 'utf8')).toBe('original')
  })

  it('restores a deterministic backup left by an interrupted replacement', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const targetPath = join(root, 'project.json')
    const backupPath = join(root, '.project.json.freecut-backup')
    await writeFile(backupPath, 'original')
    const file = registry.descriptor(rootHandle, 'project.json', 'file')

    expect(new TextDecoder().decode((await service.readFile(file)).bytes)).toBe('original')
    expect(await readFile(targetPath, 'utf8')).toBe('original')
    await expect(access(backupPath)).rejects.toThrow()
  })

  it('removes a stale backup after the replacement target is present', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const targetPath = join(root, 'project.json')
    const backupPath = join(root, '.project.json.freecut-backup')
    await writeFile(targetPath, 'replacement')
    await writeFile(backupPath, 'original')
    const file = registry.descriptor(rootHandle, 'project.json', 'file')

    expect(new TextDecoder().decode((await service.readFile(file)).bytes)).toBe('replacement')
    await expect(access(backupPath)).rejects.toThrow()
  })

  it('rejects path traversal before touching disk', async () => {
    const { rootHandle, service } = await setup()
    await expect(
      service.readFile({ ...rootHandle, kind: 'file', path: ['..', 'secret.txt'] }),
    ).rejects.toThrow('Invalid file-system path segment')
  })

  it('reads bounded byte ranges', async () => {
    const { root, registry, rootHandle, service } = await setup()
    await writeFile(join(root, 'clip.bin'), Buffer.from('0123456789'))
    const file = registry.descriptor(rootHandle, 'clip.bin', 'file')
    expect(new TextDecoder().decode(await service.readRange(file, 2, 6))).toBe('2345')
  })

  it('streams writes through a temporary file and commits on close', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const file = registry.descriptor(rootHandle, 'export.mp4', 'file')
    const writerId = await service.openWritable(file)
    await service.writeWritable(writerId, new TextEncoder().encode('abcd'))
    await service.seekWritable(writerId, 1)
    await service.writeWritable(writerId, new TextEncoder().encode('XY'))
    await service.truncateWritable(writerId, 3)
    await service.closeWritable(writerId)

    expect(await readFile(join(root, 'export.mp4'), 'utf8')).toBe('aXY')
  })

  it('discards an aborted streaming write without replacing the target', async () => {
    const { root, registry, rootHandle, service } = await setup()
    await writeFile(join(root, 'project.json'), 'original')
    const file = registry.descriptor(rootHandle, 'project.json', 'file')
    const writerId = await service.openWritable(file, true)
    await service.writeWritable(writerId, new TextEncoder().encode('replacement'))
    await service.abortWritable(writerId)

    expect(await readFile(join(root, 'project.json'), 'utf8')).toBe('original')
  })

  it('registers direct or recursive files under one authorized directory token', async () => {
    const { root, service } = await setup()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'clip.mp4'), 'video')
    await writeFile(join(root, 'nested', 'captions.srt'), 'captions')

    const direct = await service.registerLocalFiles(root)
    const recursive = await service.registerLocalFiles(root, true)

    expect(direct.map((handle) => handle.path)).toEqual([['clip.mp4']])
    expect(recursive.map((handle) => handle.path)).toEqual([
      ['clip.mp4'],
      ['nested', 'captions.srt'],
    ])
    expect(new Set(recursive.map((handle) => handle.token)).size).toBe(1)
  })

  it('does not treat a junction outside the authorized root as already authorized', async () => {
    const { root, registry } = await setup()
    const outside = await mkdtemp(join(tmpdir(), 'freecut-desktop-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const link = join(root, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(registry.isAuthorized(join(link, 'secret.txt'))).resolves.toBe(false)
  })

  it('never removes an existing directory when a move target collides', async () => {
    const { root, registry, rootHandle, service } = await setup()
    await writeFile(join(root, 'source.txt'), 'source')
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'target', 'keep.txt'), 'keep')

    const source = registry.descriptor(rootHandle, 'source.txt', 'file')
    await expect(service.moveEntry(source, rootHandle, 'target')).rejects.toThrow(
      'Cannot replace an existing directory',
    )
    await expect(stat(join(root, 'target', 'keep.txt'))).resolves.toBeDefined()
  })

  it('keeps both files when replacing a move destination fails', async () => {
    const { root, registry, rootHandle, service } = await setup()
    const sourcePath = join(root, 'source.txt')
    const destinationPath = join(root, 'target.txt')
    await writeFile(sourcePath, 'source')
    await writeFile(destinationPath, 'destination')
    renameFailure.targetName = 'target.txt'
    renameFailure.enabled = true

    const source = registry.descriptor(rootHandle, 'source.txt', 'file')
    await expect(service.moveEntry(source, rootHandle, 'target.txt')).rejects.toThrow()
    renameFailure.enabled = false

    expect(await readFile(sourcePath, 'utf8')).toBe('source')
    expect(await readFile(destinationPath, 'utf8')).toBe('destination')
  })
})
