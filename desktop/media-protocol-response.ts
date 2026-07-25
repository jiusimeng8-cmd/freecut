import { createReadStream, type Stats } from 'node:fs'
import { Readable } from 'node:stream'
import { mimeTypeForPath } from './workspace/file-system-service'

interface ByteRange {
  start: number
  end: number
}

function parseByteRange(value: string, size: number): ByteRange | null {
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2]) || size === 0) return null

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

export function createMediaProtocolResponse(
  request: Request,
  filePath: string,
  metadata: Stats,
): Response {
  const lastModified = metadata.mtime.toUTCString()
  const etag = `"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers':
      'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified',
    'Cache-Control': 'no-store',
    'Content-Type': mimeTypeForPath(filePath),
    ETag: etag,
    'Last-Modified': lastModified,
    'Cross-Origin-Resource-Policy': 'cross-origin',
  })
  const rangeHeader = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  const shouldUseRange =
    Boolean(rangeHeader) && (!ifRange || ifRange === etag || ifRange === lastModified)

  if (shouldUseRange) {
    const range = parseByteRange(rangeHeader!, metadata.size)
    if (!range) {
      headers.set('Content-Range', `bytes */${metadata.size}`)
      headers.set('Content-Length', '0')
      return new Response(null, { status: 416, headers })
    }
    const length = range.end - range.start + 1
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`)
    headers.set('Content-Length', String(length))
    const body =
      request.method === 'HEAD'
        ? null
        : Readable.toWeb(
            createReadStream(filePath, {
              start: range.start,
              end: range.end,
            }),
          )
    return new Response(body as ReadableStream<Uint8Array> | null, {
      status: 206,
      headers,
    })
  }

  headers.set('Content-Length', String(metadata.size))
  const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(filePath))
  return new Response(body as ReadableStream<Uint8Array> | null, {
    status: 200,
    headers,
  })
}
