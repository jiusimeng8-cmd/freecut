// @vitest-environment node

import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('../../services/process-runner', () => ({
  runProcess: vi.fn(),
  resolveSystemExecutable: (relativePath: string) => relativePath,
}))

import { runProcess } from '../../services/process-runner'
import { WindowsTtsService } from './windows-tts-service'

const roots: string[] = []

afterEach(async () => {
  vi.mocked(runProcess).mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'freecut-windows-tts-test-'))
  roots.push(root)
  const outputDirectory = join(root, 'output')
  return {
    outputDirectory,
    service: new WindowsTtsService(outputDirectory),
  }
}

function validWave(): Buffer {
  const bytes = Buffer.alloc(16)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(8, 4)
  bytes.write('WAVE', 8, 'ascii')
  return bytes
}

function mockSynthesis(bytes: Buffer): () => string {
  let temporaryDirectory = ''
  vi.mocked(runProcess).mockImplementation(async ({ args }) => {
    const fileIndex = args.indexOf('-File')
    const scriptPath = args[fileIndex + 1]!
    const inputPath = args[fileIndex + 2]!
    const outputPath = args[fileIndex + 3]!
    temporaryDirectory = dirname(scriptPath)
    expect(dirname(inputPath)).toBe(temporaryDirectory)
    expect(dirname(outputPath)).toBe(temporaryDirectory)
    await writeFile(outputPath, bytes)
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  return () => temporaryDirectory
}

describe('WindowsTtsService', () => {
  it.each([
    ['blank text', ' \n ', 'TTS text is required.'],
    ['oversized text', 'a'.repeat(100_001), 'TTS text exceeds 100,000 characters.'],
  ])('rejects %s before starting PowerShell', async (_case, text, message) => {
    const { service } = await setup()

    await expect(service.synthesize({ text })).rejects.toThrow(message)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('keeps intermediate files in a cleaned temporary directory and returns only the WAV', async () => {
    const { outputDirectory, service } = await setup()
    const bytes = validWave()
    const getTemporaryDirectory = mockSynthesis(bytes)

    const outputPath = await service.synthesize({ text: 'private text' })
    const temporaryDirectory = getTemporaryDirectory()

    expect(dirname(outputPath)).toBe(outputDirectory)
    expect(basename(temporaryDirectory)).toMatch(/^freecut-tts-/)
    expect(temporaryDirectory).not.toBe(outputDirectory)
    await expect(readFile(outputPath)).resolves.toEqual(bytes)
    await expect(readdir(outputDirectory)).resolves.toEqual([basename(outputPath)])
    await expect(access(temporaryDirectory)).rejects.toThrow()
  })

  it.each([
    ['empty output', Buffer.alloc(0), 'empty WAV file'],
    ['invalid header', Buffer.from('RIFF0000NOPE'), 'invalid WAV file'],
  ])('rejects %s and leaves no output artifact', async (_case, bytes, message) => {
    const { outputDirectory, service } = await setup()
    const getTemporaryDirectory = mockSynthesis(bytes)

    await expect(service.synthesize({ text: 'hello' })).rejects.toThrow(message)

    await expect(readdir(outputDirectory)).resolves.toEqual([])
    await expect(access(getTemporaryDirectory())).rejects.toThrow()
  })

  it('removes FreeCut TTS temporary directories older than 24 hours', async () => {
    const { service } = await setup()
    const staleDirectory = await mkdtemp(join(tmpdir(), 'freecut-tts-stale-test-'))
    const freshDirectory = await mkdtemp(join(tmpdir(), 'freecut-tts-fresh-test-'))
    roots.push(staleDirectory, freshDirectory)
    await writeFile(join(staleDirectory, 'input.json'), 'private text')
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(staleDirectory, staleTime, staleTime)
    mockSynthesis(validWave())

    await service.synthesize({ text: 'hello' })

    await expect(access(staleDirectory)).rejects.toThrow()
    await expect(access(freshDirectory)).resolves.toBeUndefined()
  })
})
