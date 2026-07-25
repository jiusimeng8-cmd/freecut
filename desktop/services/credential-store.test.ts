// @vitest-environment node

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const safeStorageState = vi.hoisted(() => ({ available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}))

import { CredentialStore } from './credential-store'

const roots: string[] = []

afterEach(async () => {
  safeStorageState.available = true
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CredentialStore', () => {
  it('serializes concurrent credential writes without losing keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-credentials-'))
    roots.push(root)
    const file = join(root, 'credentials.json')
    const store = new CredentialStore(file)
    const entries = Array.from(
      { length: 40 },
      (_, index) => [`key-${index}`, `value-${index}`] as const,
    )

    await Promise.all(entries.map(([key, value]) => store.set(key, value)))

    await expect(Promise.all(entries.map(([key]) => store.get(key)))).resolves.toEqual(
      entries.map(([, value]) => value),
    )
    const reloaded = new CredentialStore(file)
    await expect(reloaded.get('key-39')).resolves.toBe('value-39')
  })

  it('quarantines invalid credential data and continues with an empty store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-invalid-credentials-'))
    roots.push(root)
    const file = join(root, 'credentials.json')
    await writeFile(file, JSON.stringify({ key: 123 }))

    const store = new CredentialStore(file)

    await expect(store.has('key')).resolves.toBe(false)
    expect((await readdir(root)).some((name) => name.startsWith('credentials.json.corrupt-'))).toBe(
      true,
    )
  })

  it('refuses to write credentials when Windows encryption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-unavailable-encryption-'))
    roots.push(root)
    const file = join(root, 'credentials.json')
    const store = new CredentialStore(file)
    safeStorageState.available = false

    await expect(store.set('key', 'secret')).rejects.toThrow(
      'Windows credential encryption is unavailable',
    )
    await expect(store.has('key')).resolves.toBe(false)
  })
})
