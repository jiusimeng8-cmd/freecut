import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { BridgeError, BridgeService } from './bridge-service'

const MAX_BODY_BYTES = 1024 * 1024
const MCP_PROTOCOL_VERSION = '2025-06-18'
const MCP_CATEGORY_RESOURCE_URI = 'freecut://tool-categories'

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

function mcpCategoryResource(tools: ReturnType<BridgeService['tools']>) {
  const categories = new Map<
    string,
    { id: string; title: string; group: string; tools: string[] }
  >()
  for (const tool of tools) {
    const category = tool._meta?.['freecut/category']
    if (!category) continue
    const current = categories.get(category.id) ?? { ...category, tools: [] }
    current.tools.push(tool.name)
    categories.set(category.id, current)
  }
  return [...categories.values()]
}

async function handleMcpRequest(
  service: BridgeService,
  body: Record<string, unknown>,
): Promise<{ status: number; value?: unknown }> {
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return {
      status: 200,
      value: jsonRpcError(body.id, -32600, 'Invalid JSON-RPC request.'),
    }
  }
  const id = body.id
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {}

  if (body.method === 'notifications/initialized') {
    return { status: 202 }
  }
  if (body.method === 'initialize') {
    return {
      status: 200,
      value: jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: 'freecut-desktop',
          version: '1.0.0',
          title: 'FreeCut Desktop',
        },
        instructions:
          'FreeCut exposes its complete categorized tool registry. Write and handoff tools require one-time approval in the desktop app.',
      }),
    }
  }
  if (body.method === 'ping') {
    return { status: 200, value: jsonRpcResult(id, {}) }
  }

  const tools = service.tools()
  if (tools.length === 0) {
    return {
      status: 200,
      value: jsonRpcError(id, -32002, 'No loaded FreeCut editor is connected.'),
    }
  }
  if (body.method === 'tools/list') {
    return {
      status: 200,
      value: jsonRpcResult(id, { tools }),
    }
  }
  if (body.method === 'resources/list') {
    return {
      status: 200,
      value: jsonRpcResult(id, {
        resources: [
          {
            uri: MCP_CATEGORY_RESOURCE_URI,
            name: 'FreeCut tool categories',
            title: 'FreeCut Tool Categories',
            description: 'Complete FreeCut MCP tool catalog grouped by capability category.',
            mimeType: 'application/json',
          },
        ],
      }),
    }
  }
  if (body.method === 'resources/read') {
    if (params.uri !== MCP_CATEGORY_RESOURCE_URI) {
      return {
        status: 200,
        value: jsonRpcError(id, -32002, `Unknown FreeCut resource: ${String(params.uri)}`),
      }
    }
    return {
      status: 200,
      value: jsonRpcResult(id, {
        contents: [
          {
            uri: MCP_CATEGORY_RESOURCE_URI,
            mimeType: 'application/json',
            text: JSON.stringify({ categories: mcpCategoryResource(tools) }),
          },
        ],
      }),
    }
  }
  if (body.method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    if (!name) {
      return {
        status: 200,
        value: jsonRpcError(id, -32602, 'Tool name is required.'),
      }
    }
    const args =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {}
    const projectId = service.status().renderer?.projectId ?? undefined
    try {
      const result = await service.call({
        requestId: `mcp:${randomUUID()}`,
        name,
        args,
        projectId: projectId ?? undefined,
        allowDestructive: true,
        timeoutMs: 120_000,
      })
      return { status: 200, value: jsonRpcResult(id, result) }
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'TOOL_EXECUTION_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 200,
        value: jsonRpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
          structuredContent: {
            ok: false,
            changed: false,
            finalStatus: error instanceof BridgeError ? error.finalStatus : 'failed',
            error: { code, message },
          },
        }),
      }
    }
  }

  return {
    status: 200,
    value: jsonRpcError(id, -32601, `Method not found: ${body.method}`),
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new BridgeError('BRIDGE_UNSUPPORTED_MEDIA_TYPE', 'Bridge requests must use JSON.')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_BODY_BYTES) {
      throw new BridgeError('PAYLOAD_TOO_LARGE', 'Bridge request exceeds 1 MiB.')
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeError('BRIDGE_BAD_REQUEST', 'Bridge request body is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('BRIDGE_BAD_REQUEST', 'Bridge request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function statusForError(error: unknown): number {
  if (!(error instanceof BridgeError)) return 500
  if (error.code === 'BRIDGE_UNSUPPORTED_MEDIA_TYPE') return 415
  if (error.code === 'BRIDGE_BAD_REQUEST' || error.code === 'PROJECT_ID_REQUIRED') return 400
  if (error.code === 'BRIDGE_BUSY') return 429
  if (error.code === 'TOOL_NOT_FOUND' || error.code === 'BRIDGE_NOT_FOUND') return 404
  if (error.code === 'CONFIRMATION_REQUIRED' || error.code === 'CONFIRMATION_DENIED') return 409
  if (error.code === 'BRIDGE_OFFLINE') return 503
  if (error.code === 'BRIDGE_TIMEOUT') return 504
  if (error.code === 'BRIDGE_CANCELLED') return 499
  return 409
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = String(
    request.headers.authorization?.replace(/^Bearer\s+/i, '') ??
      request.headers['x-freecut-token'] ??
      '',
  )
  const expectedBytes = Buffer.from(token)
  const suppliedBytes = Buffer.from(supplied)
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  )
}

export async function startBridgeHttpServer(service: BridgeService): Promise<{
  url: string
  mcpUrl: string
  token: string
  close(): Promise<void>
}> {
  const token = randomBytes(32).toString('base64url')
  const server = createServer((request, response) => {
    void (async () => {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        sendJson(response, 200, service.status())
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/tools') {
        const tools = service.tools()
        if (tools.length === 0) {
          throw new BridgeError('BRIDGE_OFFLINE', 'No loaded FreeCut editor is connected.')
        }
        sendJson(response, 200, { tools })
        return
      }
      if (request.method === 'POST' && url.pathname === '/mcp') {
        const result = await handleMcpRequest(service, await readJson(request))
        if (result.value === undefined) {
          response.statusCode = result.status
          response.end()
        } else {
          sendJson(response, result.status, result.value)
        }
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/call') {
        const body = await readJson(request)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) throw new BridgeError('BRIDGE_BAD_REQUEST', 'Tool name is required.')
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
        if (!requestId) {
          throw new BridgeError('BRIDGE_BAD_REQUEST', 'requestId is required.')
        }
        const result = await service.call({
          requestId,
          name,
          args: body.args ?? {},
          projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
          allowDestructive: body.allowDestructive === true,
          timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        })
        sendJson(response, 200, { requestId, result })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/cancel') {
        const body = await readJson(request)
        const requestId = typeof body.requestId === 'string' ? body.requestId : ''
        if (!requestId) throw new BridgeError('BRIDGE_BAD_REQUEST', 'requestId is required.')
        sendJson(response, 200, await service.cancel(requestId))
        return
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown Bridge route.' } })
    })().catch((error) => {
      sendJson(response, statusForError(error), {
        error: {
          code: error instanceof BridgeError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to resolve FreeCut Bridge address.')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
