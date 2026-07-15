import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Plugin } from 'vite-plus'

const API_PREFIX = '/__freecut_dev_workspace'
const BRIDGE_HEADER = 'X-FreeCut-Dev-Workspace'
const ERROR_STATUS_BY_CODE: Record<string, number> = {
  ENOENT: 404,
  EACCES: 403,
  EPERM: 403,
  ENOTEMPTY: 409,
  EEXIST: 409,
}

interface RequestContext {
  root: string
  request: IncomingMessage
  response: ServerResponse
  url: URL
}

type RouteHandler = (context: RequestContext) => Promise<void>

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parsePathSegments(rawPath: string | null): string[] {
  const segments = (rawPath ?? '').split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment.includes('\\'))) {
    throw new Error('Invalid workspace path')
  }
  return segments
}

function resolveWorkspacePath(root: string, rawPath: string | null): string {
  const segments = parsePathSegments(rawPath)
  const target = resolve(root, ...segments)
  const relativePath = relative(root, target)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Workspace path escapes configured root')
  }
  return target
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(data))
}

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  return 'code' in error ? String((error as { code: unknown }).code) : ''
}

function errorStatus(error: unknown): number {
  return ERROR_STATUS_BY_CODE[errorCode(error)] ?? 500
}

function requestTarget(context: RequestContext): string {
  return resolveWorkspacePath(context.root, context.url.searchParams.get('path'))
}

async function handleInfo({ root, response }: RequestContext): Promise<void> {
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error('Configured workspace is not a directory')
  sendJson(response, 200, { name: basename(root) })
}

async function handleEntries(context: RequestContext): Promise<void> {
  const entries = await fs.readdir(requestTarget(context), { withFileTypes: true })
  sendJson(
    context.response,
    200,
    entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
      })),
  )
}

async function handleDirectory(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  if (context.url.searchParams.get('create') === '1') {
    await fs.mkdir(target, { recursive: true })
  } else if (!(await fs.stat(target)).isDirectory()) {
    throw new Error('Path is not a directory')
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleFileHandle(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  if (context.url.searchParams.get('create') === '1') {
    await fs.mkdir(dirname(target), { recursive: true })
    const handle = await fs.open(target, 'a')
    await handle.close()
  } else if (!(await fs.stat(target)).isFile()) {
    throw new Error('Path is not a file')
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleReadFile(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  const [data, stat] = await Promise.all([fs.readFile(target), fs.stat(target)])
  context.response.statusCode = 200
  context.response.setHeader('Content-Type', 'application/octet-stream')
  context.response.setHeader('X-FreeCut-File-Name', encodeURIComponent(basename(target)))
  context.response.setHeader('X-FreeCut-Last-Modified', String(Math.round(stat.mtimeMs)))
  context.response.end(data)
}

async function handleWriteFile(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, await readBody(context.request))
  sendJson(context.response, 200, { ok: true })
}

async function handleDeleteEntry(context: RequestContext): Promise<void> {
  const target = requestTarget(context)
  const stat = await fs.stat(target)
  if (stat.isDirectory()) {
    await fs.rm(target, {
      recursive: context.url.searchParams.get('recursive') === '1',
      force: false,
    })
  } else {
    await fs.unlink(target)
  }
  sendJson(context.response, 200, { ok: true })
}

async function handleMove(context: RequestContext): Promise<void> {
  const body = JSON.parse((await readBody(context.request)).toString('utf8')) as {
    from?: string
    to?: string
  }
  const from = resolveWorkspacePath(context.root, body.from ?? null)
  const to = resolveWorkspacePath(context.root, body.to ?? null)
  await fs.mkdir(dirname(to), { recursive: true })
  await fs.rm(to, { recursive: true, force: true })
  await fs.rename(from, to)
  sendJson(context.response, 200, { ok: true })
}

const routeHandlers: Record<string, RouteHandler> = {
  'GET /info': handleInfo,
  'GET /entries': handleEntries,
  'POST /directory': handleDirectory,
  'POST /file-handle': handleFileHandle,
  'GET /file': handleReadFile,
  'PUT /file': handleWriteFile,
  'DELETE /entry': handleDeleteEntry,
  'POST /move': handleMove,
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url || '/', 'http://localhost')
}

function findRouteHandler(context: RequestContext): RouteHandler | undefined {
  const action = context.url.pathname.slice(API_PREFIX.length) || '/'
  return routeHandlers[`${context.request.method || 'GET'} ${action}`]
}

function sendRequestError(response: ServerResponse, error: unknown): void {
  sendJson(response, errorStatus(error), {
    error: error instanceof Error ? error.message : String(error),
  })
}

async function invokeRoute(handler: RouteHandler, context: RequestContext): Promise<void> {
  try {
    await handler(context)
  } catch (error) {
    sendRequestError(context.response, error)
  }
}

async function dispatchRequest(context: RequestContext): Promise<void> {
  const handler = findRouteHandler(context)
  if (!handler) {
    sendJson(context.response, 404, { error: 'Unknown development workspace operation' })
    return
  }
  await invokeRoute(handler, context)
}

async function handleRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'Development workspace bridge is local-only' })
    return
  }

  response.setHeader(BRIDGE_HEADER, '1')
  await dispatchRequest({ root, request, response, url: requestUrl(request) })
}

export function devWorkspacePlugin(workspacePath: string | undefined): Plugin {
  const root = workspacePath ? resolve(workspacePath) : null

  return {
    name: 'freecut-dev-workspace',
    apply: 'serve',
    configureServer(server) {
      if (!root) return
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(API_PREFIX)) {
          next()
          return
        }
        void handleRequest(root, request, response)
      })
    },
  }
}
