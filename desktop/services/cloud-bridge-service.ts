import {
  DESKTOP_CREDENTIAL_KEYS,
  DESKTOP_CREDENTIAL_ORIGIN_KEYS,
  type DesktopCloudBridgeRequest,
} from '../desktop-types'
import type { CredentialStore } from './credential-store'

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const ALLOWED_PATHS = new Set<string>([
  '/api/v1/agents/run',
  '/api/v1/agent-runs',
  '/api/v1/agent-turns',
  '/api/bridge/poll',
  '/api/bridge/ack',
])

export class CloudBridgeRequestTimeoutError extends Error {
  readonly code = 'AGENT_TURN_TIMEOUT'

  constructor() {
    super('上游 Agent Turn 在 120 秒内未完成。')
    this.name = 'CloudBridgeRequestTimeoutError'
  }
}

function isAllowedPath(path: DesktopCloudBridgeRequest['path']) {
  return (
    ALLOWED_PATHS.has(path) ||
    /^\/api\/v1\/agent-runs\/[0-9a-f-]{36}(?:\/cancel)?$/i.test(path)
  )
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim())
  const isLocalHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('帧剪服务地址必须使用 HTTPS。')
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

function readErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } }
    if (typeof parsed.error === 'string') return parsed.error
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // Use the response body below.
  }
  return body.trim() || `帧剪 Bridge 请求失败（${status}）。`
}

export class CloudBridgeService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly credentials: CredentialStore) {}

  async request(input: DesktopCloudBridgeRequest): Promise<unknown> {
    const requestId = input.requestId.trim()
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(requestId)) {
      throw new Error('Invalid cloud Bridge requestId.')
    }
    if (!isAllowedPath(input.path)) {
      throw new Error('Unsupported cloud Bridge path.')
    }
    if (this.controllers.has(requestId)) {
      throw new Error('Cloud Bridge requestId is already running.')
    }

    const method = input.method || 'POST'
    const body = method === 'POST' ? JSON.stringify(input.body) : undefined
    if (body && Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Cloud Bridge request body is too large.')
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const [storedBusinessKey, boundOrigin] = await Promise.all([
      this.credentials.get(DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey),
      this.credentials.get(DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey),
    ])
    const businessKey = storedBusinessKey?.trim()
    if (!businessKey) {
      throw new Error('请先配置帧剪业务 Key。')
    }
    if (boundOrigin !== new URL(baseUrl).origin) {
      throw new Error('帧剪业务 Key 与当前服务地址不匹配，请重新配置。')
    }

    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    const timeoutMs =
      input.timeoutMs ?? (input.path === '/api/v1/agent-turns' ? 120_000 : undefined)
    let timedOut = false
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
    try {
      const response = await fetch(`${baseUrl}${input.path}`, {
        method,
        headers: {
          Authorization: `Bearer ${businessKey}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body } : {}),
        cache: 'no-store',
        signal: controller.signal,
      })
      const responseBody = await response.text()
      if (!response.ok) {
        throw new Error(readErrorMessage(response.status, responseBody))
      }
      return responseBody ? JSON.parse(responseBody) : null
    } catch (error) {
      if (timedOut) throw new CloudBridgeRequestTimeoutError()
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      this.controllers.delete(requestId)
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.controllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  dispose(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }
}
