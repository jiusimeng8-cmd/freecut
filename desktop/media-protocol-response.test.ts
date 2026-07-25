// @vitest-environment node

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createMediaProtocolResponse } from './media-protocol-response'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'freecut-media-protocol-'))
  roots.push(root)
  const path = join(root, 'clip.mp4')
  await writeFile(path, Buffer.from(Array.from({ length: 32 }, (_, index) => index)))
  return { path, metadata: await stat(path) }
}

describe('createMediaProtocolResponse', () => {
  it('returns a standard partial response for byte ranges', async () => {
    const { path, metadata } = await fixture()
    const response = createMediaProtocolResponse(
      new Request('freecut-media://file/token/clip.mp4', {
        headers: { Range: 'bytes=4-11' },
      }),
      path,
      metadata,
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBe('bytes 4-11/32')
    expect(response.headers.get('content-length')).toBe('8')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11,
    ])
  })

  it('supports suffix ranges and rejects unsatisfiable ranges', async () => {
    const { path, metadata } = await fixture()
    const suffix = createMediaProtocolResponse(
      new Request('freecut-media://file/token/clip.mp4', {
        headers: { Range: 'bytes=-4' },
      }),
      path,
      metadata,
    )
    const invalid = createMediaProtocolResponse(
      new Request('freecut-media://file/token/clip.mp4', {
        headers: { Range: 'bytes=100-200' },
      }),
      path,
      metadata,
    )

    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual([28, 29, 30, 31])
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */32')
  })

  it('serves HEAD metadata without opening a response body', async () => {
    const { path, metadata } = await fixture()
    const response = createMediaProtocolResponse(
      new Request('freecut-media://file/token/clip.mp4', { method: 'HEAD' }),
      path,
      metadata,
    )

    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-length')).toBe('32')
    expect(response.headers.get('content-type')).toBe('video/mp4')
  })
})
