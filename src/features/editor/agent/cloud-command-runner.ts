import { callMcpTool, type McpCallResult } from './tools'
import { getEditorTool } from './tools'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  getCloudCommandSpec,
  parseCloudCommandEnvelope,
  type CloudCommandEnvelope,
  type CloudCommandTargetParam,
} from './cloud-command-contract'
import {
  captureCloudCompositeSnapshot,
  captureCloudSnapshot,
  fingerprintCloudValue,
  getCurrentCloudSnapshotId,
  waitForCloudSnapshotPersistence,
  type CloudCompositeSnapshot,
} from './cloud-bridge-snapshots'
import type {
  NormalizedToolResult,
  ToolError,
  ToolImpactFlag,
  ToolOperationManifest,
  ToolPhaseReceipt,
  ToolPostReadAssertion,
  ToolReconciliationEvidence,
  ToolReconciliationStatus,
} from './tools/types'

export type CloudBridgeCommand = CloudCommandEnvelope

export interface MappedCloudCommand {
  name: string
  args: Record<string, unknown>
}

function paramsOf(command: CloudBridgeCommand): Record<string, unknown> {
  if (command.params === undefined) return {}
  if (typeof command.params !== 'object' || Array.isArray(command.params)) {
    throw new Error('云端命令 params 必须是 JSON 对象。')
  }
  return { ...command.params }
}

function addTargetIfMissing(
  targetParam: CloudCommandTargetParam | undefined,
  args: Record<string, unknown>,
  targetId: string | null | undefined,
): Record<string, unknown> {
  if (!targetId || !targetParam || args[targetParam] !== undefined) return args
  return {
    ...args,
    [targetParam]: targetParam === 'clip' || targetParam === 'item' ? targetId : [targetId],
  }
}

function mapCloudCommand(command: CloudBridgeCommand): MappedCloudCommand {
  const spec = getCloudCommandSpec(command.type)
  if (!spec) {
    throw new Error(`云端返回了本地不支持的命令：${command.type}`)
  }
  return {
    name: spec.tool,
    args: addTargetIfMissing(spec.targetParam, paramsOf(command), command.targetId),
  }
}

export interface CloudPlanStep {
  command: CloudBridgeCommand
  tool: string
  args: Record<string, unknown>
  summary: string
  handoff: boolean
  destructive: boolean
}

const IMPACT_FLAGS_BY_COMMAND: Partial<Record<string, ToolImpactFlag[]>> = {
  'timeline.import_local_media': ['media'],
  'timeline.generate_captions': ['semantic', 'caption', 'timing'],
  'timeline.split': ['semantic', 'timing', 'caption', 'audio'],
  'timeline.delete_clips': ['semantic', 'timing', 'caption', 'media', 'audio', 'mix'],
  'timeline.remove_silence': ['semantic', 'timing', 'caption', 'audio', 'mix'],
  'timeline.trim_clip': ['semantic', 'timing', 'caption', 'audio'],
  'timeline.move_clips': ['timing', 'caption', 'media', 'audio'],
  'timeline.delete_items': ['semantic', 'timing', 'caption', 'media', 'audio', 'mix'],
  'timeline.place_media': ['media', 'timing', 'audio'],
  'timeline.add_text': ['semantic', 'timing', 'motion'],
  'timeline.update_subtitle': ['semantic', 'timing', 'caption'],
  'timeline.set_transform': ['media', 'effect'],
  'timeline.set_keyframes': ['motion', 'timing'],
  'timeline.set_volume': ['audio', 'mix'],
  'timeline.set_audio': ['audio', 'mix'],
  'timeline.undo': ['semantic', 'timing', 'caption', 'media', 'effect', 'motion', 'audio', 'mix'],
  'timeline.redo': ['semantic', 'timing', 'caption', 'media', 'effect', 'motion', 'audio', 'mix'],
  'editor.list_effects': [],
  'editor.apply_effect': ['media', 'effect'],
  'editor.manage_effect_preset': ['media', 'effect'],
  'editor.manage_color_grade_clipboard': ['media', 'effect'],
  'editor.import_cube_lut': ['media', 'effect'],
  'editor.balance_color': ['media', 'effect'],
}

const OPERATION_LEDGER_STORAGE_KEY = 'freecut:renderer-operation-ledger:v1'
const MAX_OPERATION_RECORDS = 128

interface LocalOperationRecord {
  key: string
  argsFingerprint: string
  operationId: string
  projectId: string
  beforeFingerprint: string
  afterFingerprint?: string
  status: ToolReconciliationStatus
  updatedAt: number
  result?: McpCallResult
}

const operationRecords = new Map<string, LocalOperationRecord>()
let operationLedgerLoaded = false

function loadOperationLedger(): void {
  if (operationLedgerLoaded || typeof localStorage === 'undefined') return
  operationLedgerLoaded = true
  try {
    const parsed = JSON.parse(localStorage.getItem(OPERATION_LEDGER_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        typeof entry.argsFingerprint === 'string' &&
        typeof entry.operationId === 'string' &&
        typeof entry.projectId === 'string' &&
        typeof entry.beforeFingerprint === 'string' &&
        typeof entry.status === 'string'
      ) {
        operationRecords.set(entry.key, entry as LocalOperationRecord)
      }
    }
  } catch {
    // A corrupt local ledger must not block the editor; a fresh local record is safe.
  }
}

function persistOperationLedger(): void {
  if (typeof localStorage === 'undefined') return
  const entries = [...operationRecords.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .slice(-MAX_OPERATION_RECORDS)
    .map(({ result: _result, ...entry }) => entry)
  localStorage.setItem(OPERATION_LEDGER_STORAGE_KEY, JSON.stringify(entries))
}

export function clearCloudCommandOperationLedger(): void {
  operationRecords.clear()
  operationLedgerLoaded = false
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(OPERATION_LEDGER_STORAGE_KEY)
  }
}

function operationKey(projectId: string, command: CloudBridgeCommand): string | null {
  const key =
    command.operationManifest?.idempotencyKey ?? command.idempotencyKey ?? command.commandId
  return key ? `${projectId}:${key}` : null
}

function operationId(projectId: string, command: CloudBridgeCommand): string {
  return (
    command.operationManifest?.commandId ??
    command.commandId ??
    command.operationManifest?.idempotencyKey ??
    command.idempotencyKey ??
    `${projectId}:${command.type}:${command.sequence}`
  )
}

function attemptRequestId(operation: string, attempt: number): string {
  return `${operation}:attempt:${attempt}:${crypto.randomUUID()}`
}

function impactFlagsFor(command: CloudBridgeCommand): ToolImpactFlag[] {
  return [...(IMPACT_FLAGS_BY_COMMAND[command.type] ?? [])]
}

function isReadOnlyCommand(command: CloudBridgeCommand): boolean {
  const spec = getCloudCommandSpec(command.type)
  const tool = spec ? getEditorTool(spec.tool) : undefined
  return tool?.readOnly ?? false
}

function buildOperationManifest(
  projectId: string,
  command: CloudBridgeCommand,
  tool: string,
  args: Record<string, unknown>,
  before: CloudCompositeSnapshot,
  operation: string,
): ToolOperationManifest {
  const manifest = command.operationManifest
  const flags = impactFlagsFor(command)
  return {
    contractId: CLOUD_COMMAND_CONTRACT_ID,
    commandId: command.commandId ?? manifest?.commandId ?? operation,
    commandType: command.type,
    tool,
    projectId,
    sequence: command.sequence,
    attempt: Math.max(1, command.attempt ?? 1),
    idempotencyKey: manifest?.idempotencyKey ?? command.idempotencyKey ?? command.commandId,
    argsFingerprint: fingerprintCloudValue({ type: command.type, args }),
    commitMode: isReadOnlyCommand(command)
      ? 'none'
      : command.type === 'timeline.save_project'
        ? 'tool-owned'
        : 'timeline-save',
    expectedBeforeSnapshotId: command.expectedBeforeSnapshotId,
    expectedBeforeFingerprint:
      manifest?.expectedBeforeFingerprint ?? command.expectedBeforeFingerprint ?? before.hash,
    postReadAssertions: command.postReadAssertions,
    impactFlags: flags,
    requiresPostReadback: manifest?.requiresPostReadback ?? !isReadOnlyCommand(command),
  }
}

function pathValue(root: unknown, path: string): unknown {
  const normalized = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let current = root
  for (const segment of normalized) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return fingerprintCloudValue(left) === fingerprintCloudValue(right)
}

function assertionPassed(
  snapshot: CloudCompositeSnapshot,
  assertion: ToolPostReadAssertion,
): boolean {
  const actual = pathValue(snapshot, assertion.path)
  switch (assertion.operator) {
    case 'equals':
      return valuesEqual(actual, assertion.expected)
    case 'notEquals':
      return !valuesEqual(actual, assertion.expected)
    case 'exists':
      return actual !== undefined && actual !== null
    case 'notExists':
      return actual === undefined || actual === null
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((entry) => valuesEqual(entry, assertion.expected))
        : typeof actual === 'string' && typeof assertion.expected === 'string'
          ? actual.includes(assertion.expected)
          : !!actual &&
            typeof actual === 'object' &&
            typeof assertion.expected === 'string' &&
            assertion.expected in actual
    case 'length':
      return (
        (Array.isArray(actual) || typeof actual === 'string') &&
        actual.length === assertion.expected
      )
  }
}

function failedAssertions(
  snapshot: CloudCompositeSnapshot,
  assertions: ToolPostReadAssertion[] | undefined,
): ToolPostReadAssertion[] {
  return (assertions ?? []).filter((assertion) => !assertionPassed(snapshot, assertion))
}

function phase(
  name: ToolPhaseReceipt['phase'],
  status: ToolPhaseReceipt['status'],
  error?: ToolError | null,
): ToolPhaseReceipt {
  return {
    phase: name,
    status,
    ...(error !== undefined ? { error } : {}),
  }
}

function reconciliationEvidence(
  status: ToolReconciliationStatus,
  partialChange?: string,
): ToolReconciliationEvidence {
  const reconciledStatus =
    status === 'VERIFIED_APPLIED'
      ? 'applied'
      : status === 'VERIFIED_NOT_APPLIED'
        ? 'not-applied'
        : status === 'PARTIAL_APPLIED'
          ? 'partial'
          : 'unknown'
  return {
    observedAt: new Date().toISOString(),
    method: 'renderer-composite-readback',
    status: reconciledStatus,
    retryAttempted: false,
    newTaskCreated: false,
    newCommandCreated: false,
    ...(reconciledStatus === 'partial' && partialChange ? { partialChange } : {}),
  }
}

function makeSyntheticResult(params: {
  ok: boolean
  message: string
  requestId: string
  operationId: string
  changed: boolean
  projectRevision: string | number | null
  finalStatus: NormalizedToolResult['finalStatus']
  error: ToolError | null
  warnings?: NormalizedToolResult['warnings']
  manifest: ToolOperationManifest
  reconciliationStatus: ToolReconciliationStatus
  beforeSnapshotId?: string
  afterSnapshotId?: string
  beforeFingerprint?: string
  afterFingerprint?: string
  phases: ToolPhaseReceipt[]
  postReadback?: NormalizedToolResult['postReadback']
  partialChange?: string
}): McpCallResult {
  const structuredContent: NormalizedToolResult = {
    ok: params.ok,
    message: params.message,
    requestId: params.requestId,
    operationId: params.operationId,
    changed: params.changed,
    projectRevision: params.projectRevision,
    changeSummary: params.changed ? params.message : null,
    finalStatus: params.finalStatus,
    error: params.error,
    warnings: params.warnings ?? [],
    operationManifest: params.manifest,
    phaseReceipts: params.phases,
    impactFlags: params.manifest.impactFlags,
    reconciliationStatus: params.reconciliationStatus,
    reconciliation: reconciliationEvidence(params.reconciliationStatus, params.partialChange),
    ...(params.beforeSnapshotId ? { beforeSnapshotId: params.beforeSnapshotId } : {}),
    ...(params.afterSnapshotId ? { afterSnapshotId: params.afterSnapshotId } : {}),
    ...(params.beforeFingerprint ? { beforeFingerprint: params.beforeFingerprint } : {}),
    ...(params.afterFingerprint ? { afterFingerprint: params.afterFingerprint } : {}),
    ...(params.postReadback ? { postReadback: params.postReadback } : {}),
  }
  return {
    content: [{ type: 'text', text: params.message }],
    isError: !params.ok,
    structuredContent,
  }
}

function updateOperationRecord(record: LocalOperationRecord): void {
  operationRecords.set(record.key, record)
  persistOperationLedger()
}

function duplicateOperationResult(params: {
  record: LocalOperationRecord
  manifest: ToolOperationManifest
  requestId: string
  current: CloudCompositeSnapshot
}): McpCallResult {
  const { record, manifest, requestId, current } = params
  updateOperationRecord({
    ...record,
    status: 'RECONCILING',
    updatedAt: Date.now(),
  })
  const recordedStateStillMatches =
    (record.status === 'VERIFIED_APPLIED' &&
      !!record.afterFingerprint &&
      current.hash === record.afterFingerprint) ||
    (record.status === 'VERIFIED_NOT_APPLIED' && current.hash === record.beforeFingerprint)
  if (record.result && recordedStateStillMatches) {
    const structured = record.result.structuredContent as NormalizedToolResult
    const replayed: NormalizedToolResult = {
      ...structured,
      requestId,
      operationManifest: manifest,
      warnings: [
        ...structured.warnings,
        {
          code: 'IDEMPOTENT_REPLAY',
          message: 'The original write tool was not invoked again.',
        },
      ],
    }
    return {
      content: [{ type: 'text', text: replayed.message }],
      isError: !replayed.ok,
      structuredContent: replayed,
    }
  }

  const status =
    record.status === 'VERIFIED_APPLIED' &&
    record.afterFingerprint &&
    current.hash === record.afterFingerprint
      ? 'VERIFIED_APPLIED'
      : record.status === 'VERIFIED_NOT_APPLIED' && current.hash === record.beforeFingerprint
        ? 'VERIFIED_NOT_APPLIED'
        : record.status === 'PARTIAL_APPLIED'
          ? 'PARTIAL_APPLIED'
          : record.afterFingerprint &&
              record.afterFingerprint !== record.beforeFingerprint &&
              current.hash === record.afterFingerprint
            ? 'VERIFIED_APPLIED'
            : current.hash === record.beforeFingerprint
              ? 'VERIFIED_NOT_APPLIED'
              : 'PARTIAL_APPLIED'
  const changed = status !== 'VERIFIED_NOT_APPLIED'
  const ok = status === 'VERIFIED_APPLIED'
  const error =
    status === 'VERIFIED_APPLIED'
      ? null
      : status === 'VERIFIED_NOT_APPLIED'
        ? {
            code: 'VERIFIED_NOT_APPLIED',
            message:
              'The prior write was verified as not applied; no automatic retry was attempted.',
            retryable: true,
          }
        : {
            code: 'PARTIAL_APPLIED',
            message: 'The prior write no longer matches either the before or after fingerprint.',
            retryable: false,
          }
  const nextRecord: LocalOperationRecord = {
    ...record,
    status,
    afterFingerprint: current.hash,
    updatedAt: Date.now(),
  }
  updateOperationRecord(nextRecord)
  return makeSyntheticResult({
    ok,
    message: error?.message ?? 'Returned the locally verified idempotent operation result.',
    requestId,
    operationId: record.operationId,
    changed,
    projectRevision: current.projectRevision,
    finalStatus: ok ? 'succeeded' : status === 'PARTIAL_APPLIED' ? 'uncertain' : 'failed',
    error,
    warnings: [
      {
        code: 'IDEMPOTENT_REPLAY',
        message: 'The original write tool was not invoked again.',
      },
    ],
    manifest,
    reconciliationStatus: status,
    beforeFingerprint: record.beforeFingerprint,
    afterFingerprint: current.hash,
    phases: [
      phase('transport', 'succeeded'),
      phase('toolAck', 'succeeded'),
      phase('commit', status === 'VERIFIED_APPLIED' ? 'succeeded' : 'uncertain'),
      phase('postReadback', 'succeeded'),
      phase('reconciliation', status === 'PARTIAL_APPLIED' ? 'uncertain' : 'succeeded'),
    ],
    postReadback: {
      status: 'verified',
      fingerprint: current.hash,
      assertions: manifest.postReadAssertions,
    },
    partialChange:
      status === 'PARTIAL_APPLIED'
        ? 'Current Renderer fingerprint differs from both the recorded before and after states.'
        : undefined,
  })
}

function classifyResult(params: {
  readOnly: boolean
  toolOk: boolean
  claimedChanged: boolean
  observedChanged: boolean
  assertionFailures: ToolPostReadAssertion[]
  hasAssertions: boolean
}): ToolReconciliationStatus {
  if (params.readOnly) {
    return params.observedChanged ? 'PARTIAL_APPLIED' : 'VERIFIED_NOT_APPLIED'
  }
  if (params.assertionFailures.length > 0) {
    return params.observedChanged ? 'PARTIAL_APPLIED' : 'VERIFIED_NOT_APPLIED'
  }
  if (!params.toolOk && params.observedChanged) return 'PARTIAL_APPLIED'
  if (params.claimedChanged && params.observedChanged) return 'VERIFIED_APPLIED'
  if (params.claimedChanged && !params.observedChanged) return 'VERIFIED_NOT_APPLIED'
  if (!params.claimedChanged && params.observedChanged) return 'PARTIAL_APPLIED'
  if (params.hasAssertions) return 'VERIFIED_APPLIED'
  return 'VERIFIED_NOT_APPLIED'
}

export function describeCloudCommand(command: CloudBridgeCommand): CloudPlanStep {
  const mapped = mapCloudCommand(command)
  const tool = getEditorTool(mapped.name)
  if (!tool) {
    throw new Error(`云端返回了本地不支持的命令：${command.type}`)
  }

  const validation = tool.validate(mapped.args)
  if (!validation.ok) {
    throw new Error(`${tool.name} 命令参数无效：${validation.error}`)
  }

  return {
    command,
    tool: tool.name,
    args: validation.value,
    summary: tool.summarize(validation.value),
    handoff: tool.handoff,
    destructive: tool.destructive,
  }
}

export function parseCloudBridgeCommand(value: unknown): CloudBridgeCommand {
  const command = parseCloudCommandEnvelope(value)
  describeCloudCommand(command)
  return command
}

export async function executeCloudCommand(
  projectId: string,
  command: CloudBridgeCommand,
): Promise<McpCallResult> {
  const mapped = mapCloudCommand(command)
  const tool = getEditorTool(mapped.name)
  if (!tool) {
    throw new Error(`云端返回了本地不支持的命令：${command.type}`)
  }
  const validation = tool.validate(mapped.args)
  if (!validation.ok) {
    throw new Error(`${tool.name} 命令参数无效：${validation.error}`)
  }

  const attempt = Math.max(1, command.attempt ?? 1)
  const logicalOperationId = operationId(projectId, command)
  const requestId = attemptRequestId(logicalOperationId, attempt)
  const before = captureCloudCompositeSnapshot(projectId)
  const manifest = buildOperationManifest(
    projectId,
    command,
    mapped.name,
    validation.value,
    before,
    logicalOperationId,
  )
  const argsFingerprint = manifest.argsFingerprint!
  const currentSnapshotId = getCurrentCloudSnapshotId(projectId)
  const expectedFingerprint =
    command.operationManifest?.expectedBeforeFingerprint ?? command.expectedBeforeFingerprint

  if (
    command.commandId &&
    command.operationManifest?.commandId &&
    command.commandId !== command.operationManifest.commandId
  ) {
    const error = {
      code: 'COMMAND_ID_CONFLICT',
      message: 'Top-level commandId does not match operationManifest.commandId.',
      retryable: false,
    }
    return makeSyntheticResult({
      ok: false,
      message: error.message,
      requestId,
      operationId: logicalOperationId,
      changed: false,
      projectRevision: before.projectRevision,
      finalStatus: 'failed',
      error,
      manifest,
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      beforeSnapshotId: currentSnapshotId,
      beforeFingerprint: before.hash,
      afterFingerprint: before.hash,
      phases: [
        phase('transport', 'succeeded'),
        phase('toolAck', 'failed', error),
        phase('commit', 'failed', error),
        phase('postReadback', 'succeeded'),
        phase('reconciliation', 'succeeded'),
      ],
      postReadback: {
        status: 'verified',
        snapshotId: currentSnapshotId,
        fingerprint: before.hash,
      },
    })
  }

  if (
    (command.expectedBeforeSnapshotId && command.expectedBeforeSnapshotId !== currentSnapshotId) ||
    (expectedFingerprint && expectedFingerprint !== before.hash)
  ) {
    const error = {
      code: 'SNAPSHOT_CONFLICT',
      message: 'The command precondition does not match the current Renderer snapshot.',
      retryable: false,
    }
    return makeSyntheticResult({
      ok: false,
      message: error.message,
      requestId,
      operationId: logicalOperationId,
      changed: false,
      projectRevision: before.projectRevision,
      finalStatus: 'failed',
      error,
      manifest,
      reconciliationStatus: 'VERIFIED_NOT_APPLIED',
      beforeSnapshotId: currentSnapshotId,
      beforeFingerprint: before.hash,
      afterFingerprint: before.hash,
      phases: [
        phase('transport', 'succeeded'),
        phase('toolAck', 'failed', error),
        phase('commit', 'failed', error),
        phase('postReadback', 'succeeded'),
        phase('reconciliation', 'succeeded'),
      ],
      postReadback: {
        status: 'verified',
        snapshotId: currentSnapshotId,
        fingerprint: before.hash,
      },
    })
  }

  loadOperationLedger()
  const key = operationKey(projectId, command)
  const existing = key ? operationRecords.get(key) : undefined
  if (existing) {
    if (existing.argsFingerprint !== argsFingerprint) {
      const error = {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used with different normalized arguments.',
        retryable: false,
      }
      return makeSyntheticResult({
        ok: false,
        message: error.message,
        requestId,
        operationId: logicalOperationId,
        changed: false,
        projectRevision: before.projectRevision,
        finalStatus: 'failed',
        error,
        manifest,
        reconciliationStatus: 'VERIFIED_NOT_APPLIED',
        beforeFingerprint: existing.beforeFingerprint,
        afterFingerprint: before.hash,
        phases: [
          phase('transport', 'succeeded'),
          phase('toolAck', 'failed', error),
          phase('commit', 'failed', error),
          phase('postReadback', 'succeeded'),
          phase('reconciliation', 'succeeded'),
        ],
        postReadback: { status: 'verified', fingerprint: before.hash },
      })
    }
    return duplicateOperationResult({
      record: existing,
      manifest,
      requestId,
      current: before,
    })
  }

  const beforeSnapshotId = captureCloudSnapshot(projectId)
  await waitForCloudSnapshotPersistence(beforeSnapshotId)
  if (key) {
    updateOperationRecord({
      key,
      argsFingerprint,
      operationId: logicalOperationId,
      projectId,
      beforeFingerprint: before.hash,
      status: 'UNCERTAIN_WRITE',
      updatedAt: Date.now(),
    })
  }

  const initialPhases: ToolPhaseReceipt[] = [
    phase('transport', 'succeeded'),
    phase('toolAck', 'pending'),
    phase('commit', 'pending'),
    phase('postReadback', 'pending'),
    phase('reconciliation', 'pending'),
  ]
  const callResult = await callMcpTool(mapped.name, validation.value, {
    requestId,
    operationManifest: manifest,
    phaseReceipts: initialPhases,
    impactFlags: manifest.impactFlags,
  })
  const toolResult = callResult.structuredContent as NormalizedToolResult
  const after = captureCloudCompositeSnapshot(projectId)
  const afterSnapshotId = captureCloudSnapshot(projectId)
  await waitForCloudSnapshotPersistence(afterSnapshotId)
  const assertionFailures = failedAssertions(after, command.postReadAssertions)
  const claimedChanged = toolResult.changed
  const observedChanged = before.hash !== after.hash
  const reconciliationStatus = classifyResult({
    readOnly: tool.readOnly,
    toolOk: !callResult.isError && toolResult.ok,
    claimedChanged,
    observedChanged,
    assertionFailures,
    hasAssertions: (command.postReadAssertions?.length ?? 0) > 0,
  })
  const changeMismatch = !tool.readOnly && claimedChanged !== observedChanged
  const partialApplied = reconciliationStatus === 'PARTIAL_APPLIED'
  const verifiedFailure =
    changeMismatch ||
    assertionFailures.length > 0 ||
    partialApplied ||
    callResult.isError ||
    !toolResult.ok
  const error: ToolError | null = verifiedFailure
    ? (toolResult.error ??
      (changeMismatch
        ? {
            code: 'WRITE_RESULT_MISMATCH',
            message:
              'The tool changed flag did not match the Renderer timeline/hash/history readback.',
            retryable: false,
          }
        : assertionFailures.length > 0
          ? {
              code: 'POST_READ_ASSERTION_FAILED',
              message:
                assertionFailures[0]?.message ??
                `Post-read assertion failed at ${assertionFailures[0]?.path}.`,
              retryable: false,
            }
          : {
              code: 'PARTIAL_APPLIED',
              message: 'The Renderer observed a partial or inconsistent operation result.',
              retryable: false,
            }))
    : null
  const finalStatus =
    verifiedFailure || reconciliationStatus === 'UNCERTAIN_WRITE'
      ? partialApplied || changeMismatch
        ? 'uncertain'
        : 'failed'
      : toolResult.finalStatus
  const finalOk = !verifiedFailure
  const warnings = [...toolResult.warnings]
  if (
    command.operationManifest?.impactFlags &&
    !valuesEqual(command.operationManifest.impactFlags, manifest.impactFlags)
  ) {
    warnings.push({
      code: 'IMPACT_FLAGS_OVERRIDDEN',
      message: 'Renderer authoritative impact flags replaced the caller-provided flags.',
    })
  }
  const phases: ToolPhaseReceipt[] = [
    phase('transport', 'succeeded'),
    phase(
      'toolAck',
      toolResult.ok && !callResult.isError ? 'succeeded' : 'failed',
      toolResult.error,
    ),
    phase(
      'commit',
      partialApplied ? 'uncertain' : toolResult.ok && !callResult.isError ? 'succeeded' : 'failed',
      error,
    ),
    phase('postReadback', assertionFailures.length === 0 ? 'succeeded' : 'failed', error),
    phase('reconciliation', partialApplied || changeMismatch ? 'uncertain' : 'succeeded', error),
  ]
  const structuredContent: NormalizedToolResult = {
    ...toolResult,
    ok: finalOk,
    message: error?.message ?? toolResult.message,
    changed: observedChanged,
    // `updatedAt` is project metadata, not a storage commit revision. Keep
    // the legacy null value unless the tool/storage layer supplies a revision.
    projectRevision: toolResult.projectRevision ?? null,
    changeSummary: observedChanged ? (toolResult.changeSummary ?? toolResult.message) : null,
    finalStatus,
    error,
    warnings,
    operationManifest: manifest,
    phaseReceipts: phases,
    impactFlags: manifest.impactFlags,
    reconciliationStatus,
    reconciliation: reconciliationEvidence(
      reconciliationStatus,
      partialApplied
        ? 'Renderer state changed, but the tool result or post-read assertions were incomplete.'
        : undefined,
    ),
    beforeSnapshotId,
    afterSnapshotId,
    beforeFingerprint: before.hash,
    afterFingerprint: after.hash,
    postReadback: {
      status: assertionFailures.length === 0 ? 'verified' : 'failed',
      snapshotId: afterSnapshotId,
      fingerprint: after.hash,
      assertions: command.postReadAssertions,
    },
  }
  const result: McpCallResult = {
    content: [{ type: 'text', text: structuredContent.message }],
    isError: !structuredContent.ok,
    structuredContent,
  }

  if (key) {
    updateOperationRecord({
      key,
      argsFingerprint,
      operationId: logicalOperationId,
      projectId,
      beforeFingerprint: before.hash,
      afterFingerprint: after.hash,
      status: reconciliationStatus,
      updatedAt: Date.now(),
      result,
    })
  }
  return result
}
