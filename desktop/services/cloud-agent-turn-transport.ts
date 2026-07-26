import { DESKTOP_CLOUD_BASE_URL, DESKTOP_CREDENTIAL_KEYS } from '../desktop-types'
import type { LocalDirectorTurnResult } from '../agent-runtime'
import type { CloudBridgeService } from './cloud-bridge-service'
import type { CredentialStore } from './credential-store'
import type { AgentTurnRequest, AgentTurnTransport } from './local-agent-host-service'

export interface CloudAgentTurnTransportOptions {
  /** Only `has` is needed: the request never reads the key, the Bridge does. */
  credentials: Pick<CredentialStore, 'has'>
  cloudBridge: Pick<CloudBridgeService, 'request' | 'cancel'>
  /** Validates the untrusted upstream payload. Owned by Main. */
  parseResponse: (response: unknown, request: AgentTurnRequest) => LocalDirectorTurnResult
  timeoutMs: number
  createRequestId?: () => string
}

/**
 * The Main-initiated Agent Turn transport.
 *
 * `baseUrl` is deliberately not a parameter. It was previously read from the
 * stored `cloud-bridge.origin` credential and handed to `CloudBridgeService`,
 * which validates a request by comparing that same stored origin against
 * `new URL(baseUrl).origin` — the value against itself. The comparison could
 * never fail, so the anti-confused-deputy check on this path was a tautology
 * and a business key bound to some other origin was still sent upstream.
 *
 * Taking the base from the trusted built-in constant instead is what makes the
 * Bridge's origin check meaningful, so it stays hardcoded here. This mirrors
 * `DashScopeAsrService`, which has always resolved its own trusted base.
 */
export function createCloudAgentTurnTransport(
  options: CloudAgentTurnTransportOptions,
): AgentTurnTransport {
  const { credentials, cloudBridge, parseResponse, timeoutMs } = options
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID())

  return {
    run: async ({ request }, signal) => {
      if (signal.aborted) throw new Error('Local Agent run was cancelled.')
      // Presence of a business key is the only precondition this layer checks.
      // Whether that key may travel to the target origin is the Bridge's call,
      // and it can only make it against an independently trusted base.
      if (!(await credentials.has(DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey))) {
        throw Object.assign(new Error('请先配置剪好 MCP Key。'), {
          code: 'LOCAL_AGENT_NOT_CONFIGURED',
        })
      }
      const requestId = createRequestId()
      const cancel = () => {
        void cloudBridge.cancel(requestId)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const response = await cloudBridge.request({
          requestId,
          baseUrl: DESKTOP_CLOUD_BASE_URL,
          method: 'POST',
          path: '/api/v1/agent-turns',
          timeoutMs,
          body: request,
        })
        return parseResponse(response, request)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}
