// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { AgentRunSandbox } from './agent-run-sandbox'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AgentRunSandbox', () => {
  it('isolates a run, reports metadata only, and removes temporary content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-sandbox-'))
    roots.push(root)
    const sandbox = new AgentRunSandbox(join(root, 'sandboxes'))
    await sandbox.initialize()
    await sandbox.create('run-1')

    await expect(
      sandbox.write({
        runId: 'run-1',
        path: ['work', 'result.txt'],
        bytes: new TextEncoder().encode('local result'),
      }),
    ).resolves.toBe(12)
    await expect(sandbox.status('run-1')).resolves.toEqual({
      runId: 'run-1',
      exists: true,
      fileCount: 1,
      totalBytes: 12,
    })

    await expect(sandbox.cleanup('run-1')).resolves.toBe(true)
    await expect(sandbox.status('run-1')).resolves.toEqual({
      runId: 'run-1',
      exists: false,
      fileCount: 0,
      totalBytes: 0,
    })
  })

  it('rejects path traversal instead of exposing arbitrary filesystem access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecut-agent-sandbox-path-'))
    roots.push(root)
    const sandbox = new AgentRunSandbox(join(root, 'sandboxes'))
    await sandbox.initialize()
    await sandbox.create('run-1')

    await expect(
      sandbox.write({
        runId: 'run-1',
        path: ['..', 'outside.txt'],
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('Invalid Agent sandbox path')
  })
})
