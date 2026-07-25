import type { CloudMcpConfig } from '@/shared/state/cloud-mcp-config-store'
import { parseCloudBridgeCommand, type CloudBridgeCommand } from './cloud-command-runner'
import type { McpCallResult, NormalizedToolResult } from './tools'
import {
  normalizeCloudCommandVersion,
  type CloudCommandCapability,
  type CloudCommandVersion,
  type CloudCommandVersionWireValue,
} from './cloud-command-contract'
import {
  DESKTOP_CREDENTIAL_KEYS,
  type DesktopCloudBridgeRequest,
} from '../../../../desktop/desktop-types'

const DEVICE_ID_STORAGE_KEY = 'freecut:cloud-bridge-device-id'
const DEV_CLOUD_MCP_PROXY_PREFIX = '/__freecut_dev_mcp'
const DEFAULT_AGENT_RUN_POLL_INTERVAL_MS = 1_000
const DEFAULT_AGENT_RUN_CLIENT_TIMEOUT_MS = 15 * 60_000

export interface CloudBridgeTask {
  id: string
  projectId: string | null
  projectName: string | null
  status: string
  commandVersion?: CloudCommandVersion
  commandContractId?: string
  attempt?: number
  retryOfTaskId?: string
  commands: CloudBridgeCommand[]
}

export interface CloudBridgePollResponse {
  deviceId: string
  task: CloudBridgeTask | null
}

type CloudBridgeReceiptFields = Pick<
  NormalizedToolResult,
  | 'requestId'
  | 'operationId'
  | 'changed'
  | 'projectRevision'
  | 'changeSummary'
  | 'finalStatus'
  | 'error'
  | 'warnings'
  | 'operationManifest'
  | 'phaseReceipts'
  | 'impactFlags'
  | 'reconciliationStatus'
  | 'reconciliation'
  | 'beforeSnapshotId'
  | 'afterSnapshotId'
  | 'beforeFingerprint'
  | 'afterFingerprint'
  | 'postReadback'
>

export type CloudBridgeCommandResult = {
  sequence: number
  commandId?: string
  type?: CloudBridgeCommand['type']
  attempt?: number
  status: 'succeeded' | 'failed'
  beforeSnapshotId?: string
  afterSnapshotId?: string
  errorCode?: string
  errorMessage?: string
  retryable?: boolean
} & Partial<CloudBridgeReceiptFields>

export function selectCloudBridgeReceipt(
  result: McpCallResult,
): Partial<CloudBridgeCommandResult> {
  const structured = result.structuredContent as Partial<NormalizedToolResult> | undefined
  if (!structured || typeof structured !== 'object') return {}

  const {
    requestId,
    operationId,
    changed,
    projectRevision,
    changeSummary,
    finalStatus,
    error,
    warnings,
    operationManifest,
    phaseReceipts,
    impactFlags,
    reconciliationStatus,
    reconciliation,
    beforeSnapshotId,
    afterSnapshotId,
    beforeFingerprint,
    afterFingerprint,
    postReadback,
  } = structured

  return {
    requestId,
    operationId,
    changed,
    projectRevision,
    changeSummary,
    finalStatus,
    error,
    warnings,
    operationManifest,
    phaseReceipts,
    impactFlags,
    reconciliationStatus,
    reconciliation,
    beforeSnapshotId,
    afterSnapshotId,
    beforeFingerprint,
    afterFingerprint,
    postReadback,
  }
}

export interface CloudAgentRunResponse {
  taskId: string
  status: string
  commandPackage: {
    version: CloudCommandVersionWireValue
    contractId?: string
    summary?: string
    operations: CloudBridgeCommand[]
  }
  execution: {
    status: string
    commandCount: number
  }
  usage?: {
    charged: boolean
    chargedCredits?: number
    inputUnits?: number
    outputUnits?: number
    calls?: number
    subagents?: string[]
  }
}

type CloudAgentRunAcceptedResponse = {
  runId: string
  taskId?: string | null
  status: 'accepted' | 'ACCEPTED'
  statusUrl?: string
  eventsUrl: string
}

export type CloudAgentRunPhase =
  | 'ACCEPTED'
  | 'ANALYZING'
  | 'DIRECTING'
  | 'VALIDATING'
  | 'COMMAND_READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface CloudAgentRunRequestMetadata {
  requestId?: string
  roleId?: string
  channelId?: string
  upstreamModel?: string
  upstreamCode?: string
  elapsedMs?: number
}

export interface CloudAgentRunCommandMetadata {
  contractId?: string
  version?: CloudCommandVersionWireValue
  manifestHash?: string
  operationCount?: number
}

export interface CloudAgentRunCompletion {
  runId: string
  taskId: string
  status: string
  phase: 'COMPLETED'
  commandPackage: CloudAgentRunCommandMetadata | null
}

export interface CloudAgentRunProgress {
  runId: string
  taskId: string | null
  phase: CloudAgentRunPhase
  status: string
  progressCurrent?: number
  progressTotal?: number
  summary?: string
  errorCode?: string
  error: string | null
  stage?: string
  retryable?: boolean
  request?: CloudAgentRunRequestMetadata
  commandPackage?: CloudAgentRunCommandMetadata | null
  eventId?: number
  updatedAt?: string | null
}

type CloudAgentRunStatusResponse = CloudAgentRunProgress & {
  taskId: string | null
  result: CloudAgentRunResponse | null
}

export interface RunCloudAgentOptions {
  pollIntervalMs?: number
  totalTimeoutMs?: number
}

export class CloudAgentRunError extends Error {
  readonly code: string
  readonly progress: CloudAgentRunProgress
  readonly runId: string
  readonly taskId: string | null
  readonly phase: CloudAgentRunPhase
  readonly status: string
  readonly progressCurrent?: number
  readonly progressTotal?: number
  readonly stage?: string
  readonly retryable?: boolean
  readonly request?: CloudAgentRunRequestMetadata
  readonly remoteRunContinues: boolean

  constructor(
    message: string,
    progress: CloudAgentRunProgress,
    options: {
      code?: string
      remoteRunContinues?: boolean
    } = {},
  ) {
    super(message)
    this.name = 'CloudAgentRunError'
    this.code = options.code || progress.errorCode || 'AGENT_RUN_FAILED'
    this.progress = {
      ...progress,
      errorCode: this.code,
      error: progress.error || message,
    }
    this.runId = progress.runId
    this.taskId = progress.taskId
    this.phase = progress.phase
    this.status = progress.status
    this.progressCurrent = progress.progressCurrent
    this.progressTotal = progress.progressTotal
    this.stage = progress.stage
    this.retryable = progress.retryable
    this.request = progress.request
    this.remoteRunContinues = options.remoteRunContinues ?? false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} 无效。`)
  }
  return value.trim()
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return requiredString(value, label)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label)
}

function optionalAttempt(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new Error('云端任务 attempt 无效。')
  }
  return value as number
}

function optionalCommandVersion(value: unknown): CloudCommandVersion | undefined {
  if (value === undefined) return undefined
  return normalizeCloudCommandVersion(value)
}

function optionalNonEmptyString(value: unknown, label: string, maxLength = 512): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredString(value, label, maxLength)
}

function optionalProgress(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new Error(`${label} 无效。`)
  }
  return value as number
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} 无效。`)
  return value
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 无效。`)
  }
  return value as number
}

function optionalNullableString(
  value: unknown,
  label: string,
  maxLength = 512,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return requiredString(value, label, maxLength)
}

function normalizeRunPhase(value: unknown, status: string): CloudAgentRunPhase {
  const candidate = typeof value === 'string' ? value : status
  switch (candidate.trim().toUpperCase()) {
    case 'ACCEPTED':
      return 'ACCEPTED'
    case 'ANALYZING':
    case 'PLANNING':
      return 'ANALYZING'
    case 'DIRECTING':
      return 'DIRECTING'
    case 'VALIDATING':
      return 'VALIDATING'
    case 'COMMAND_READY':
    case 'QUEUED':
      return 'COMMAND_READY'
    case 'EXECUTING':
      return 'EXECUTING'
    case 'VERIFYING':
      return 'VERIFYING'
    case 'COMPLETED':
    case 'SUCCEEDED':
      return 'COMPLETED'
    case 'CANCELLED':
      return 'CANCELLED'
    default:
      return 'FAILED'
  }
}

function parseCloudAgentRequestMetadata(
  value: Record<string, unknown>,
  error: Record<string, unknown> | null,
): CloudAgentRunRequestMetadata | undefined {
  const request = isRecord(value.request)
    ? value.request
    : isRecord(error?.request)
      ? error.request
      : null
  const metadata = {
    requestId: optionalNonEmptyString(
      request?.requestId ?? value.requestId ?? error?.requestId,
      '云端 Agent requestId',
    ),
    roleId: optionalNonEmptyString(
      request?.roleId ?? value.roleId ?? error?.roleId,
      '云端 Agent roleId',
    ),
    channelId: optionalNonEmptyString(
      request?.channelId ?? value.channelId ?? error?.channelId,
      '云端 Agent channelId',
    ),
    upstreamModel: optionalNonEmptyString(
      request?.upstreamModel ?? value.upstreamModel ?? error?.upstreamModel,
      '云端 Agent upstreamModel',
    ),
    upstreamCode: optionalNonEmptyString(
      request?.upstreamCode ?? value.upstreamCode ?? error?.upstreamCode,
      '云端 Agent upstreamCode',
    ),
    elapsedMs: optionalNonNegativeInteger(
      request?.elapsedMs ?? value.elapsedMs ?? error?.elapsedMs,
      '云端 Agent elapsedMs',
    ),
  }
  return Object.values(metadata).some((item) => item !== undefined) ? metadata : undefined
}

function parseCloudAgentCommandMetadata(
  value: unknown,
): CloudAgentRunCommandMetadata | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRecord(value)) throw new Error('云端 Agent commandPackage 无效。')
  return {
    contractId: optionalNonEmptyString(
      value.contractId,
      '云端 Agent commandPackage contractId',
    ),
    version:
      value.version === undefined || value.version === null
        ? undefined
        : normalizeCloudCommandVersion(value.version),
    manifestHash: optionalNonEmptyString(
      value.manifestHash,
      '云端 Agent commandPackage manifestHash',
    ),
    operationCount: optionalNonNegativeInteger(
      value.operationCount,
      '云端 Agent commandPackage operationCount',
    ),
  }
}

function parseCloudAgentResult(
  value: unknown,
  fallbackTaskId: string | null,
): CloudAgentRunResponse | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw new Error('云端 Agent Run result 无效。')
  if (!isRecord(value.commandPackage)) throw new Error('云端 Agent commandPackage 无效。')
  if (!Array.isArray(value.commandPackage.operations)) {
    throw new Error('云端 Agent commandPackage operations 无效。')
  }
  if (!isRecord(value.execution)) throw new Error('云端 Agent execution 无效。')

  return {
    taskId:
      value.taskId === undefined || value.taskId === null
        ? requiredString(fallbackTaskId, '云端 Agent result taskId')
        : requiredString(value.taskId, '云端 Agent result taskId'),
    status: requiredString(value.status, '云端 Agent result status', 64),
    commandPackage: {
      version: normalizeCloudCommandVersion(value.commandPackage.version),
      contractId: optionalNonEmptyString(
        value.commandPackage.contractId,
        '云端 Agent result contractId',
      ),
      summary: optionalNonEmptyString(
        value.commandPackage.summary,
        '云端 Agent result summary',
        4_096,
      ),
      operations: value.commandPackage.operations.map(parseCloudBridgeCommand),
    },
    execution: {
      status: requiredString(value.execution.status, '云端 Agent execution status', 64),
      commandCount: optionalProgress(
        value.execution.commandCount,
        '云端 Agent execution commandCount',
      ) ?? 0,
    },
    usage: isRecord(value.usage)
      ? (value.usage as unknown as CloudAgentRunResponse['usage'])
      : undefined,
  }
}

function parseCloudAgentDirectResult(
  value: Record<string, unknown>,
  taskId: string | null,
): CloudAgentRunResponse | null {
  if (!isRecord(value.commandPackage) || !Array.isArray(value.commandPackage.operations)) {
    return null
  }
  return parseCloudAgentResult(
    {
      taskId,
      status: value.status,
      commandPackage: value.commandPackage,
      execution: value.execution,
    },
    taskId,
  )
}

function parseCloudAgentRunStatus(value: unknown): CloudAgentRunStatusResponse {
  if (!isRecord(value)) throw new Error('云端 Agent Run 状态无效。')
  const runId = requiredString(value.runId, '云端 Agent Run id')
  const status = requiredString(value.status, '云端 Agent Run status', 64)
  const taskId = value.taskId === null || value.taskId === undefined
    ? null
    : requiredString(value.taskId, '云端 Agent taskId')
  const errorObject = isRecord(value.error) ? value.error : null
  const error =
    typeof value.error === 'string'
      ? requiredString(value.error, '云端 Agent 错误', 4_096)
      : optionalNullableString(errorObject?.message, '云端 Agent 错误', 4_096) ?? null
  const progress = isRecord(value.progress) ? value.progress : null
  const errorCode = optionalNonEmptyString(
    value.errorCode ?? errorObject?.code,
    '云端 Agent 错误代码',
    128,
  )
  const stage = optionalNonEmptyString(
    value.stage ?? errorObject?.stage,
    '云端 Agent 阶段',
    128,
  )
  const result = parseCloudAgentResult(value.result, taskId) ?? parseCloudAgentDirectResult(value, taskId)

  return {
    runId,
    taskId,
    status,
    phase: normalizeRunPhase(value.phase, status),
    progressCurrent: optionalProgress(
      progress?.current ?? value.progressCurrent,
      '云端 Agent 进度',
    ),
    progressTotal: optionalProgress(
      progress?.total ?? value.progressTotal,
      '云端 Agent 总进度',
    ),
    summary: optionalNonEmptyString(value.summary, '云端 Agent 摘要', 512),
    errorCode,
    error,
    stage,
    retryable: optionalBoolean(
      value.retryable ?? errorObject?.retryable,
      '云端 Agent retryable',
    ),
    request: parseCloudAgentRequestMetadata(value, errorObject),
    commandPackage: parseCloudAgentCommandMetadata(value.commandPackage),
    eventId: optionalNonNegativeInteger(value.eventId, '云端 Agent eventId'),
    updatedAt: optionalNullableString(value.updatedAt, '云端 Agent updatedAt', 128),
    result,
  }
}

async function requestRunStatusWithDeadline(
  config: CloudMcpConfig,
  path: DesktopCloudBridgeRequest['path'],
  remainingMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const requestController = new AbortController()
  let timedOut = false
  const abortFromCaller = () => requestController.abort()
  const timeout = window.setTimeout(() => {
    timedOut = true
    requestController.abort()
  }, remainingMs)
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    return await requestCloudBridgeJson<unknown>(
      config,
      path,
      { method: 'GET' },
      requestController.signal,
    )
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new DOMException('The client Agent Run deadline was exceeded.', 'TimeoutError')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

function parseCloudBridgeTask(value: unknown): CloudBridgeTask {
  if (!isRecord(value)) {
    throw new Error('云端 Bridge task 必须是 JSON 对象。')
  }
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 64) {
    throw new Error('云端 Bridge task commands 数量无效。')
  }

  const commands = value.commands.map(parseCloudBridgeCommand)
  const sequences = new Set(commands.map((command) => command.sequence))
  if (sequences.size !== commands.length) {
    throw new Error('云端 Bridge task 包含重复 sequence。')
  }
  const commandIds = commands.flatMap((command) => (command.commandId ? [command.commandId] : []))
  if (new Set(commandIds).size !== commandIds.length) {
    throw new Error('云端 Bridge task 包含重复 commandId。')
  }

  return {
    id: requiredString(value.id, '云端任务 id'),
    projectId: nullableString(value.projectId, '云端任务 projectId'),
    projectName: nullableString(value.projectName, '云端任务 projectName'),
    status: requiredString(value.status, '云端任务 status', 64),
    commandVersion: optionalCommandVersion(value.commandVersion),
    commandContractId: optionalString(value.commandContractId, '云端任务 commandContractId'),
    attempt: optionalAttempt(value.attempt),
    retryOfTaskId: optionalString(value.retryOfTaskId, '云端任务 retryOfTaskId'),
    commands,
  }
}

export function parseCloudBridgePollResponse(value: unknown): CloudBridgePollResponse {
  if (!isRecord(value)) {
    throw new Error('云端 Bridge poll 响应必须是 JSON 对象。')
  }
  return {
    deviceId: requiredString(value.deviceId, '云端 Bridge deviceId'),
    task: value.task === null ? null : parseCloudBridgeTask(value.task),
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } }
    if (typeof parsed.error === 'string') return parsed.error
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // Use the response body below when it is not JSON.
  }
  return body.trim() || `帧剪 Bridge 请求失败（${status}）。`
}

function defaultAgentRunErrorMessage(code: string): string {
  switch (code) {
    case 'MODEL_FIRST_EVENT_TIMEOUT':
      return '上游已建立连接，但未返回首个流事件。'
    case 'MODEL_STREAM_IDLE_TIMEOUT':
      return '上游流在两个事件之间长时间没有数据。'
    case 'MODEL_UPSTREAM_TIMEOUT':
      return '单次上游请求超过 120 秒。'
    case 'MODEL_UPSTREAM_RESPONSE_FAILED':
      return '上游返回了失败响应。'
    case 'MODEL_UPSTREAM_INCOMPLETE':
      return '上游响应未完整结束。'
    case 'MODEL_UPSTREAM_CONNECTION_FAILED':
      return '无法建立上游连接。'
    case 'AGENT_COMMAND_PACKAGE_INVALID':
      return '云端生成的命令包未通过校验。'
    case 'CLIENT_CANCELLED':
      return 'Agent Run 已取消。'
    case 'CLIENT_AGENT_RUN_TIMEOUT':
      return '客户端等待 Agent Run 超时，云端任务未被取消。'
    case 'AGENT_RUN_RESULT_UNAVAILABLE':
      return '云端任务已结束，但没有返回可执行结果。'
    default:
      return `Agent Run 失败（${code}）。`
  }
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function requestCloudBridgeJson<T>(
  config: CloudMcpConfig,
  path: DesktopCloudBridgeRequest['path'],
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const desktop = window.freecutDesktop
  if (desktop) {
    const requestId = crypto.randomUUID()
    const cancel = () => {
      void desktop.cloudBridge.cancel(requestId)
    }
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const body =
        typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : null
      return await desktop.cloudBridge.request<T>({
        requestId,
        baseUrl: config.baseUrl,
        path,
        method: init.method === 'GET' ? 'GET' : 'POST',
        body,
      })
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  const useDevelopmentProxy = import.meta.env.DEV
  const response = await fetch(
    useDevelopmentProxy ? `${DEV_CLOUD_MCP_PROXY_PREFIX}${path}` : apiUrl(config.baseUrl, path),
    {
    ...init,
    headers: {
        ...(useDevelopmentProxy
          ? { 'X-FreeCut-Business-Key': encodeURIComponent(config.businessKey) }
          : { Authorization: `Bearer ${config.businessKey}` }),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal,
    cache: 'no-store',
    },
  )
  if (!response.ok) {
    const error = new Error(errorMessage(response.status, await response.text()))
    Object.assign(error, {
      code: response.status === 401 ? 'BRIDGE_AUTH_FAILED' : 'BRIDGE_REQUEST_FAILED',
      status: response.status,
    })
    throw error
  }
  return (await response.json()) as T
}

export async function getCloudBridgeDeviceId(): Promise<string> {
  const desktop = window.freecutDesktop
  if (desktop) {
    const saved = await desktop.credentials.get(DESKTOP_CREDENTIAL_KEYS.cloudBridgeDeviceId)
    if (saved) return saved
    const created = crypto.randomUUID()
    await desktop.credentials.set(DESKTOP_CREDENTIAL_KEYS.cloudBridgeDeviceId, created)
    return created
  }

  const saved = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
  if (saved) return saved
  const created = crypto.randomUUID()
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created)
  return created
}

export async function runCloudAgent(
  config: CloudMcpConfig,
  input: {
    deviceId: string
    businessModel: 'smart-edit-fast' | 'smart-edit-expert'
    commandVersion: CloudCommandVersionWireValue
    commandContractId: string
    prompt: string
    instructions?: string
    projectId?: string
    projectName?: string
    snapshotId?: string
    projectSnapshot?: unknown
    skillSlug?: string
    idempotencyKey: string
  },
  signal?: AbortSignal,
  onProgress?: (progress: CloudAgentRunProgress) => void,
  options: RunCloudAgentOptions = {},
): Promise<CloudAgentRunCompletion> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_AGENT_RUN_POLL_INTERVAL_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_AGENT_RUN_CLIENT_TIMEOUT_MS
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('云端 Agent 轮询间隔无效。')
  }
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new Error('云端 Agent 客户端总超时无效。')
  }
  const startedAt = Date.now()
  const accepted = await requestCloudBridgeJson<CloudAgentRunAcceptedResponse>(
    config,
    '/api/v1/agent-runs',
    {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        executionMode: 'bridge',
      }),
    },
    signal,
  )
  onProgress?.({
    runId: accepted.runId,
    taskId: accepted.taskId ?? null,
    phase: 'ACCEPTED',
    status: accepted.status,
    error: null,
  })

  let latestProgress: CloudAgentRunProgress = {
    runId: accepted.runId,
    taskId: accepted.taskId ?? null,
    phase: 'ACCEPTED',
    status: accepted.status,
    error: null,
  }

  while (true) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= totalTimeoutMs) {
      throw new CloudAgentRunError(
        defaultAgentRunErrorMessage('CLIENT_AGENT_RUN_TIMEOUT'),
        latestProgress,
        { code: 'CLIENT_AGENT_RUN_TIMEOUT', remoteRunContinues: true },
      )
    }
    await waitForPoll(Math.min(pollIntervalMs, totalTimeoutMs - elapsedMs), signal)
    const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new CloudAgentRunError(
        defaultAgentRunErrorMessage('CLIENT_AGENT_RUN_TIMEOUT'),
        latestProgress,
        { code: 'CLIENT_AGENT_RUN_TIMEOUT', remoteRunContinues: true },
      )
    }
    let status: CloudAgentRunStatusResponse
    try {
      status = parseCloudAgentRunStatus(
        await requestRunStatusWithDeadline(
          config,
          `/api/v1/agent-runs/${accepted.runId}`,
          remainingMs,
          signal,
        ),
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new CloudAgentRunError(
          defaultAgentRunErrorMessage('CLIENT_AGENT_RUN_TIMEOUT'),
          latestProgress,
          { code: 'CLIENT_AGENT_RUN_TIMEOUT', remoteRunContinues: true },
        )
      }
      throw error
    }
    latestProgress = status
    onProgress?.(status)
    if (status.phase === 'COMPLETED') {
      return {
        runId: status.runId,
        taskId: status.taskId ?? accepted.taskId ?? accepted.runId,
        status: status.status,
        phase: 'COMPLETED',
        commandPackage: status.commandPackage ?? null,
      }
    }
    if (status.phase === 'FAILED' || status.phase === 'CANCELLED') {
      const code =
        status.errorCode ||
        (status.phase === 'CANCELLED' ? 'CLIENT_CANCELLED' : 'AGENT_RUN_FAILED')
      throw new CloudAgentRunError(
        status.error || defaultAgentRunErrorMessage(code),
        status,
        { code },
      )
    }
    if (Date.now() - startedAt >= totalTimeoutMs) {
      throw new CloudAgentRunError(
        defaultAgentRunErrorMessage('CLIENT_AGENT_RUN_TIMEOUT'),
        latestProgress,
        { code: 'CLIENT_AGENT_RUN_TIMEOUT', remoteRunContinues: true },
      )
    }
  }
}

export function cancelCloudAgentRun(
  config: CloudMcpConfig,
  runId: string,
): Promise<unknown> {
  return requestCloudBridgeJson(
    config,
    `/api/v1/agent-runs/${runId}/cancel`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}

export async function pollCloudBridge(
  config: CloudMcpConfig,
  input: {
    deviceId: string
    name: string
    platform: string
    clientVersion: string
    commandVersion: CloudCommandVersionWireValue
    commandContractId: string
    commandCapabilities: CloudCommandCapability[]
    currentProjectId?: string
    currentProjectName?: string
    currentSnapshotId?: string
  },
  signal?: AbortSignal,
): Promise<CloudBridgePollResponse> {
  const response = await requestCloudBridgeJson<unknown>(
    config,
    '/api/bridge/poll',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    signal,
  )
  const parsed = parseCloudBridgePollResponse(response)
  if (parsed.deviceId !== input.deviceId) {
    throw new Error('云端 Bridge poll 返回了不匹配的 deviceId。')
  }
  return parsed
}

export function acknowledgeCloudBridgeTask(
  config: CloudMcpConfig,
  input: {
    deviceId: string
    taskId: string
    attempt: number
    results: CloudBridgeCommandResult[]
  },
  signal?: AbortSignal,
): Promise<{ taskId: string; status: string; retryable: boolean }> {
  return requestCloudBridgeJson(
    config,
    '/api/bridge/ack',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    signal,
  )
}
