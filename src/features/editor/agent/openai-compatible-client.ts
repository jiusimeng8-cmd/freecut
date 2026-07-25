import type { JsonSchema } from './tools'

export interface OpenAICompatibleConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export type CloudAgentRole = 'system' | 'user' | 'assistant' | 'tool'

export interface CloudAgentToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface CloudAgentMessage {
  role: CloudAgentRole
  content: string | null
  tool_call_id?: string
  tool_calls?: CloudAgentToolCall[]
}

export interface CloudAgentTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface CloudAgentCompletion {
  content: string
  toolCalls: CloudAgentToolCall[]
}

function apiUrl(baseUrl: string, resource: 'chat/completions' | 'models'): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) {
    const apiBase = normalized.slice(0, -'/chat/completions'.length)
    return resource === 'chat/completions' ? normalized : `${apiBase}/models`
  }

  const parsed = new URL(normalized)
  const apiBase =
    parsed.pathname === '' || parsed.pathname === '/' ? `${normalized}/v1` : normalized
  return `${apiBase}/${resource}`
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    return parsed.error?.message || `Cloud agent request failed (${status}).`
  } catch {
    return body.trim() || `Cloud agent request failed (${status}).`
  }
}

export async function createCloudAgentCompletion(params: {
  config: OpenAICompatibleConfig
  messages: CloudAgentMessage[]
  tools: CloudAgentTool[]
  signal?: AbortSignal
}): Promise<CloudAgentCompletion> {
  const response = await fetch(apiUrl(params.config.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.config.model,
      messages: params.messages,
      tools: params.tools,
      tool_choice: 'auto',
      temperature: 0,
    }),
    signal: params.signal,
  })

  if (!response.ok) {
    throw new Error(errorMessage(response.status, await response.text()))
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: CloudAgentToolCall[]
      }
    }>
  }
  const message = payload.choices?.[0]?.message
  if (!message) {
    throw new Error('Cloud agent returned no message.')
  }

  return {
    content: message.content?.trim() ?? '',
    toolCalls: message.tool_calls ?? [],
  }
}

export async function listCloudAgentModels(
  config: Pick<OpenAICompatibleConfig, 'baseUrl' | 'apiKey'>,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(apiUrl(config.baseUrl, 'models'), {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal,
  })

  if (!response.ok) {
    throw new Error(errorMessage(response.status, await response.text()))
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>
  }
  return [
    ...new Set(
      (payload.data ?? [])
        .map((model) => model.id?.trim() ?? '')
        .filter((model): model is string => model.length > 0),
    ),
  ]
}
