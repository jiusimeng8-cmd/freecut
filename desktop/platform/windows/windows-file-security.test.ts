// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { runProcess } from '../../services/process-runner'
import { prepareWindowsPrivateDataDirectory } from './windows-file-security'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'win32')('Windows private data ACL', () => {
  it('migrates sensitive files and removes broad inherited access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-private-data-'))
    roots.push(root)
    await writeFile(join(root, 'tasks.json'), '[{"id":"task-1"}]')

    const privateDirectory = await prepareWindowsPrivateDataDirectory(root)
    const taskPath = join(privateDirectory, 'tasks.json')
    expect(await readFile(taskPath, 'utf8')).toContain('task-1')

    const acl = await runProcess({
      executable: 'icacls.exe',
      args: [taskPath],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    })
    expect(acl.exitCode).toBe(0)
    expect(acl.stdout).toContain('SYSTEM')
    expect(acl.stdout).not.toContain('Authenticated Users')
    expect(acl.stdout).not.toContain('BUILTIN\\Users')
  })
})
