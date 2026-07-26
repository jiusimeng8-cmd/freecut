// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { findWhitespaceVariantPath, resolveExistingPath } from './whitespace-path'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(names: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'freecut-whitespace-path-'))
  roots.push(root)
  for (const name of names) await mkdir(join(root, name))
  return root
}

const exists = async (candidate: string): Promise<boolean> => {
  const { stat } = await import('node:fs/promises')
  return stat(candidate).then(
    () => true,
    () => false,
  )
}

describe('findWhitespaceVariantPath', () => {
  it('finds the real folder when the requested path dropped a space', async () => {
    // The exact failure observed: 新建文件夹 (3) requested as 新建文件夹(3).
    const root = await setup(['新建文件夹 (3)'])

    await expect(findWhitespaceVariantPath(join(root, '新建文件夹(3)'))).resolves.toBe(
      join(root, '新建文件夹 (3)'),
    )
  })

  it('finds the real folder when the path wrapped across a line', async () => {
    const root = await setup(['新建文件夹 (3)'])

    await expect(findWhitespaceVariantPath(join(root, '新建文件夹\n(3)'))).resolves.toBe(
      join(root, '新建文件夹 (3)'),
    )
  })

  it('normalizes the ideographic space and NBSP a Chinese IME can produce', async () => {
    const root = await setup(['新建文件夹 (3)'])

    await expect(findWhitespaceVariantPath(join(root, '新建文件夹　(3)'))).resolves.toBe(
      join(root, '新建文件夹 (3)'),
    )
    await expect(findWhitespaceVariantPath(join(root, '新建文件夹 (3)'))).resolves.toBe(
      join(root, '新建文件夹 (3)'),
    )
  })

  it('refuses to guess when two siblings both match after normalization', async () => {
    // `a b` and `ab` both normalize to `ab`, so correcting would be a coin flip.
    const root = await setup(['a b', 'ab'])

    await expect(findWhitespaceVariantPath(join(root, 'a  b'))).resolves.toBeNull()
  })

  it('does not match on a prefix, suffix, or partial name', async () => {
    // Exact-after-normalization only. A looser rule would let a caller probe the
    // filesystem for names it does not already know.
    const root = await setup(['新建文件夹 (3)'])

    await expect(findWhitespaceVariantPath(join(root, '新建'))).resolves.toBeNull()
    await expect(findWhitespaceVariantPath(join(root, '新建文件夹'))).resolves.toBeNull()
    await expect(findWhitespaceVariantPath(join(root, '文件夹 (3)'))).resolves.toBeNull()
    await expect(findWhitespaceVariantPath(join(root, '新建文件夹 (3) extra'))).resolves.toBeNull()
  })

  it('ignores a name that is empty or only whitespace', async () => {
    const root = await setup(['secret'])

    await expect(findWhitespaceVariantPath(join(root, ' '))).resolves.toBeNull()
    await expect(findWhitespaceVariantPath(join(root, '\n'))).resolves.toBeNull()
  })

  it('returns null when the parent directory does not exist', async () => {
    const root = await setup()

    await expect(
      findWhitespaceVariantPath(join(root, 'missing-parent', 'child(1)')),
    ).resolves.toBeNull()
  })

  it('matches files, not just directories', async () => {
    const root = await setup()
    await writeFile(join(root, 'my clip.mp4'), 'x')

    await expect(findWhitespaceVariantPath(join(root, 'myclip.mp4'))).resolves.toBe(
      join(root, 'my clip.mp4'),
    )
  })
})

describe('resolveExistingPath', () => {
  it('prefers the requested path and never scans when it exists', async () => {
    const root = await setup(['新建文件夹 (3)', '新建文件夹(3)'])
    const requested = join(root, '新建文件夹(3)')

    // Both exist, so the exact request must win rather than the variant.
    await expect(resolveExistingPath(requested, exists)).resolves.toBe(requested)
  })

  it('falls back to the whitespace variant when the request does not exist', async () => {
    const root = await setup(['新建文件夹 (3)'])

    await expect(resolveExistingPath(join(root, '新建文件夹(3)'), exists)).resolves.toBe(
      join(root, '新建文件夹 (3)'),
    )
  })

  it('returns null when neither the request nor a variant exists', async () => {
    const root = await setup(['unrelated'])

    await expect(resolveExistingPath(join(root, 'nothinghere'), exists)).resolves.toBeNull()
  })
})
