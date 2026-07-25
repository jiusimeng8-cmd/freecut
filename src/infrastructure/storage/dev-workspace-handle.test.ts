import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDevLocalMediaHandles } from './dev-workspace-handle'

describe('development local media handles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists an absolute local directory and reads returned files', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                name: 'clip.mp4',
                path: 'C:\\Users\\Administrator\\Desktop\\clips\\clip.mp4',
              },
            ],
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'X-FreeCut-Dev-Workspace': '1',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'Content-Type': 'video/mp4',
            'X-FreeCut-File-Name': encodeURIComponent('clip.mp4'),
            'X-FreeCut-Last-Modified': '1234',
          },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const handles = await getDevLocalMediaHandles('C:\\Users\\Administrator\\Desktop\\clips', {
      recursive: true,
    })
    expect(handles).toHaveLength(1)
    expect(handles[0]?.name).toBe('clip.mp4')

    const file = await handles[0]!.getFile()
    expect(file.name).toBe('clip.mp4')
    expect(file.type).toBe('video/mp4')
    expect(file.lastModified).toBe(1234)
    expect(file.size).toBe(3)
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/local-media?')
    expect(fetchMock.mock.calls[0]?.[0]).toContain('recursive=1')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/local-media-file?')
  })
})
