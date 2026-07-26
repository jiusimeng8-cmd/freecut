import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite-plus'
import { Agent, fetch as undiciFetch } from 'undici'

const CLOUD_MCP_PROXY_PREFIX = '/__freecut_dev_mcp'
const DEFAULT_CLOUD_BASE_URL = 'https://mcp.123jianhao.com'
const CLOUD_AGENT_REQUEST_TIMEOUT_MS = 120_000
const CLOUD_MCP_PATHS = new Set<string>([
  '/api/v1/agents/run',
  '/api/v1/agent-runs',
  '/api/bridge/poll',
  '/api/bridge/ack',
  '/api/v1/uploads/policy',
  '/api/v1/transcribe',
])
const cloudAgentDispatcher = new Agent({
  headersTimeout: CLOUD_AGENT_REQUEST_TIMEOUT_MS,
  bodyTimeout: CLOUD_AGENT_REQUEST_TIMEOUT_MS,
})

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(data))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function requestHeader(request: IncomingMessage, name: string, fallback = ''): string {
  return String(request.headers[name] ?? fallback).trim()
}

function decodedRequestHeader(request: IncomingMessage, name: string, fallback = ''): string {
  return decodeURIComponent(requestHeader(request, name, encodeURIComponent(fallback)))
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  const isLoopbackHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('剪好 MCP 服务必须使用 HTTPS。')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

async function handleCloudMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
  path: string,
): Promise<void> {
  const businessKey = decodedRequestHeader(request, 'x-freecut-business-key')
  if (!businessKey) {
    sendJson(response, 400, { error: '请先配置剪好 MCP Key' })
    return
  }

  const method = request.method === 'GET' ? 'GET' : 'POST'
  const requestInit = {
    method,
    headers: {
      Authorization: `Bearer ${businessKey}`,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body: await readBody(request) } : {}),
  }
  const cloudResponse =
    path === '/api/v1/agents/run'
      ? await undiciFetch(`${baseUrl}${path}`, {
          ...requestInit,
          dispatcher: cloudAgentDispatcher,
        })
      : await fetch(`${baseUrl}${path}`, requestInit)
  const bytes = Buffer.from(await cloudResponse.arrayBuffer())
  response.statusCode = cloudResponse.status
  response.setHeader(
    'Content-Type',
    cloudResponse.headers.get('content-type') || 'application/json; charset=utf-8',
  )
  response.end(bytes)
}

export function devCloudAsrPlugin(configuredBaseUrl?: string): Plugin {
  const baseUrl = normalizeBaseUrl(configuredBaseUrl || DEFAULT_CLOUD_BASE_URL)
  return {
    name: 'freecut-dev-cloud-mcp',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split('?')[0] ?? ''
        if (!requestPath.startsWith(CLOUD_MCP_PROXY_PREFIX)) {
          next()
          return
        }

        if (request.method !== 'POST' && request.method !== 'GET') {
          sendJson(response, 405, { error: '剪好 MCP 开发代理只接受 GET 或 POST 请求。' })
          return
        }

        const cloudPath = requestPath.slice(CLOUD_MCP_PROXY_PREFIX.length)
        const isAgentRunStatus = /^\/api\/v1\/agent-runs\/[0-9a-f-]{36}$/i.test(cloudPath)
        if (!CLOUD_MCP_PATHS.has(cloudPath) && !isAgentRunStatus) {
          sendJson(response, 404, { error: '剪好 MCP 开发代理路径无效。' })
          return
        }

        void handleCloudMcpRequest(request, response, baseUrl, cloudPath).catch((error) => {
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    },
  }
}
