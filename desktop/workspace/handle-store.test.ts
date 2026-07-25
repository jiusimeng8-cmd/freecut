// @vitest-environment node

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { DesktopHandleStore } from './handle-store'
import { PathRegistry } from './path-registry'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'freecut-handle-store-'))
  roots.push(root)
  const registry = new PathRegistry()
  const handle = await registry.register(root)
  const filePath = join(root, 'state', 'handles.json')
  return { filePath, handle, registry, root }
}

describe('DesktopHandleStore', () => {
  it('serializes concurrent saves without losing records on disk', async () => {
    const { filePath, handle, registry } = await setup()
    const store = new DesktopHandleStore(filePath, registry)
    const ids = Array.from({ length: 40 }, (_, index) => `workspace-${index}`)

    await Promise.all(
      ids.map((id, index) =>
        store.save({
          kind: 'workspace',
          id,
          handle,
          pickedAt: index,
        }),
      ),
    )

    const reloaded = new DesktopHandleStore(filePath, new PathRegistry())
    const entries = await reloaded.list('workspace')
    expect(entries).toHaveLength(ids.length)
    expect(new Set(entries.map((entry) => entry.id))).toEqual(new Set(ids))
  })

  it('recovers a damaged primary file from its backup', async () => {
    const { filePath, handle, registry } = await setup()
    const store = new DesktopHandleStore(filePath, registry)
    await store.save({
      kind: 'workspace',
      id: 'workspace-1',
      handle,
      pickedAt: 1,
    })
    await copyFile(filePath, `${filePath}.bak`)
    await writeFile(filePath, '{broken')

    const reloaded = new DesktopHandleStore(filePath, new PathRegistry())
    await expect(reloaded.get('workspace', 'workspace-1')).resolves.not.toBeNull()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toHaveLength(1)
  })
})
