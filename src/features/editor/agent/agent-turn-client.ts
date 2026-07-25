import type { CloudMcpConfig } from '@/shared/state/cloud-mcp-config-store'
import { requestCloudBridgeJson } from './cloud-bridge-client'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/i
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i
const TURN_OUTCOMES = new Set(['tool_calls', 'final'])
const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool'])

export interface CloudAgentTurnMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

export interface CloudAgentTurnTool {
  name: string
  title: string
  category: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  destructive: boolean
  handoff: boolean
}

export interface CloudAgentTurnInput {
  turnId: string
  profileId: string
  context: {
    summary: string
    recentMessages: CloudAgentTurnMessage[]
    directorState?: Record<string, unknown>
    snapshotId?: string
    fingerprint?: string
  }
  tools: CloudAgentTurnTool[]
}

export interface CloudAgentTurnToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface CloudAgentTurnResponse {
  turnId: string
  outcome: 'tool_calls' | 'final'
  assistantText: string
  toolCalls: CloudAgentTurnToolCall[]
  usage: {
    inputUnits: number
    outputUnits: number
    charged: boolean
  }
  routing: {
    profileId: string
    providerId: string
    modelId: string
    channelId: string
    protocol: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未知字段：${key}。`)
  }
}

function stringValue(
  value: unknown,
  label: string,
  options: { min?: number; max: number; trim?: boolean } = { max: 512 },
): string {
  if (typeof value !== 'string') throw new Error(`${label} 无效。`)
  const normalized = options.trim ? value.trim() : value
  const min = options.min ?? 0
  if (normalized.length < min || normalized.length > options.max) {
    throw new Error(`${label} 无效。`)
  }
  return normalized
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 无效。`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 无效。`)
  }
  return value as number
}

function parseTurnId(value: unknown, label: string): string {
  const turnId = stringValue(value, label, { min: 1, max: 36, trim: true })
  if (!UUID_PATTERN.test(turnId)) throw new Error(`${label} 无效。`)
  return turnId
}

function parseIdentifier(value: unknown, label: string, max = 160): string {
  const identifier = stringValue(value, label, { min: 1, max, trim: true })
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${label} 无效。`)
  }
  return identifier
}

function parseProfileId(value: unknown, label: string): string {
  const profileId = stringValue(value, label, { min: 1, max: 100, trim: true })
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(`${label} 无效。`)
  }
  return profileId
}

function parseProtocol(value: unknown, label: string): string {
  const protocol = stringValue(value, label, { min: 1, max: 128, trim: true })
  if (!PROTOCOL_PATTERN.test(protocol)) throw new Error(`${label} 无效。`)
  return protocol
}

function parseMessage(value: unknown): CloudAgentTurnMessage {
  const message = recordValue(value, 'Agent Turn message')
  assertExactKeys(message, ['role', 'text'], 'Agent Turn message')
  if (typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) {
    throw new Error('Agent Turn message role 无效。')
  }
  return {
    role: message.role as CloudAgentTurnMessage['role'],
    text: stringValue(message.text, 'Agent Turn message text', { max: 20_000 }),
  }
}

function parseTool(value: unknown): CloudAgentTurnTool {
  const tool = recordValue(value, 'Agent Turn tool')
  assertExactKeys(
    tool,
    ['name', 'title', 'category', 'description', 'inputSchema', 'readOnly', 'destructive', 'handoff'],
    'Agent Turn tool',
  )
  return {
    name: stringValue(tool.name, 'Agent Turn tool name', {
      min: 1,
      max: 160,
      trim: true,
    }),
    title: stringValue(tool.title, 'Agent Turn tool title', {
      min: 1,
      max: 160,
      trim: true,
    }),
    category: stringValue(tool.category, 'Agent Turn tool category', {
      min: 1,
      max: 160,
      trim: true,
    }),
    description: stringValue(tool.description, 'Agent Turn tool description', {
      min: 1,
      max: 4_000,
      trim: true,
    }),
    inputSchema: recordValue(tool.inputSchema, 'Agent Turn tool inputSchema'),
    readOnly: booleanValue(tool.readOnly, 'Agent Turn tool readOnly'),
    destructive: booleanValue(tool.destructive, 'Agent Turn tool destructive'),
    handoff: booleanValue(tool.handoff, 'Agent Turn tool handoff'),
  }
}

export function parseCloudAgentTurnInput(value: unknown): CloudAgentTurnInput {
  const input = recordValue(value, 'Agent Turn 请求')
  assertExactKeys(input, ['turnId', 'profileId', 'context', 'tools'], 'Agent Turn 请求')
  const context = recordValue(input.context, 'Agent Turn context')
  assertExactKeys(
    context,
    ['summary', 'recentMessages', 'directorState', 'snapshotId', 'fingerprint'],
    'Agent Turn context',
  )
  if (!Array.isArray(context.recentMessages) || context.recentMessages.length < 1 || context.recentMessages.length > 24) {
    throw new Error('Agent Turn recentMessages 数量无效。')
  }
  if (!Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > 220) {
    throw new Error('Agent Turn tools 数量无效。')
  }

  const tools = input.tools.map(parseTool)
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error('Agent Turn tools 包含重复名称。')
  }

  return {
    turnId: parseTurnId(input.turnId, 'Agent Turn turnId'),
    profileId: parseProfileId(input.profileId, 'Agent Turn profileId'),
    context: {
      summary: stringValue(context.summary, 'Agent Turn context summary', { max: 20_000 }),
      recentMessages: context.recentMessages.map(parseMessage),
      ...(context.directorState === undefined
        ? {}
        : { directorState: recordValue(context.directorState, 'Agent Turn directorState') }),
      ...(context.snapshotId === undefined
        ? {}
        : {
            snapshotId: stringValue(context.snapshotId, 'Agent Turn snapshotId', {
              min: 1,
              max: 255,
              trim: true,
            }),
          }),
      ...(context.fingerprint === undefined
        ? {}
        : {
            fingerprint: stringValue(context.fingerprint, 'Agent Turn fingerprint', {
              min: 1,
              max: 255,
              trim: true,
            }),
          }),
    },
    tools,
  }
}

function parseToolCall(value: unknown, toolNames: Set<string>): CloudAgentTurnToolCall {
  const toolCall = recordValue(value, 'Agent Turn toolCall')
  assertExactKeys(toolCall, ['id', 'name', 'arguments'], 'Agent Turn toolCall')
  const name = stringValue(toolCall.name, 'Agent Turn toolCall name', {
    min: 1,
    max: 160,
    trim: true,
  })
  if (!toolNames.has(name)) throw new Error('Agent Turn toolCall 引用了未声明的工具。')
  return {
    id: stringValue(toolCall.id, 'Agent Turn toolCall id', { min: 1, max: 160, trim: true }),
    name,
    arguments: recordValue(toolCall.arguments, 'Agent Turn toolCall arguments'),
  }
}

export function parseCloudAgentTurnResponse(
  value: unknown,
  input: Pick<CloudAgentTurnInput, 'turnId' | 'profileId' | 'tools'>,
): CloudAgentTurnResponse {
  const response = recordValue(value, 'Agent Turn 响应')
  assertExactKeys(
    response,
    ['turnId', 'outcome', 'assistantText', 'toolCalls', 'usage', 'routing'],
    'Agent Turn 响应',
  )
  const turnId = parseTurnId(response.turnId, 'Agent Turn response turnId')
  if (turnId !== input.turnId) throw new Error('Agent Turn response turnId 不匹配。')
  if (typeof response.outcome !== 'string' || !TURN_OUTCOMES.has(response.outcome)) {
    throw new Error('Agent Turn response outcome 无效。')
  }
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length > 8) {
    throw new Error('Agent Turn response toolCalls 数量无效。')
  }
  const toolCalls = response.toolCalls.map((toolCall) =>
    parseToolCall(toolCall, new Set(input.tools.map((tool) => tool.name))),
  )
  if (new Set(toolCalls.map((toolCall) => toolCall.id)).size !== toolCalls.length) {
    throw new Error('Agent Turn response toolCalls 包含重复 id。')
  }
  if (response.outcome === 'tool_calls' && toolCalls.length === 0) {
    throw new Error('Agent Turn response tool_calls 必须包含工具调用。')
  }
  if (response.outcome === 'final' && toolCalls.length !== 0) {
    throw new Error('Agent Turn response final 不能包含工具调用。')
  }

  const usage = recordValue(response.usage, 'Agent Turn response usage')
  assertExactKeys(usage, ['inputUnits', 'outputUnits', 'charged'], 'Agent Turn response usage')
  const routing = recordValue(response.routing, 'Agent Turn response routing')
  assertExactKeys(
    routing,
    ['profileId', 'providerId', 'modelId', 'channelId', 'protocol'],
    'Agent Turn response routing',
  )
  const profileId = parseProfileId(routing.profileId, 'Agent Turn response routing profileId')
  if (profileId !== input.profileId) {
    throw new Error('Agent Turn response routing profileId 不匹配。')
  }

  return {
    turnId,
    outcome: response.outcome as CloudAgentTurnResponse['outcome'],
    assistantText: stringValue(response.assistantText, 'Agent Turn response assistantText', {
      max: 4_000,
    }),
    toolCalls,
    usage: {
      inputUnits: nonNegativeInteger(usage.inputUnits, 'Agent Turn response usage inputUnits'),
      outputUnits: nonNegativeInteger(usage.outputUnits, 'Agent Turn response usage outputUnits'),
      charged: booleanValue(usage.charged, 'Agent Turn response usage charged'),
    },
    routing: {
      profileId,
      providerId: parseIdentifier(routing.providerId, 'Agent Turn response routing providerId'),
      modelId: stringValue(routing.modelId, 'Agent Turn response routing modelId', {
        min: 1,
        max: 512,
        trim: true,
      }),
      channelId: parseIdentifier(
        routing.channelId,
        'Agent Turn response routing channelId',
      ),
      protocol: parseProtocol(routing.protocol, 'Agent Turn response routing protocol'),
    },
  }
}

export async function runCloudAgentTurn(
  config: CloudMcpConfig,
  input: CloudAgentTurnInput,
  signal?: AbortSignal,
): Promise<CloudAgentTurnResponse> {
  const request = parseCloudAgentTurnInput(input)
  const response = await requestCloudBridgeJson<unknown>(
    config,
    '/api/v1/agent-turns',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    signal,
  )
  return parseCloudAgentTurnResponse(response, request)
}
