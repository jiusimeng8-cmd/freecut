import { getEditorTool, type JsonSchema } from './tools'
import {
  getToolCapabilityMetadata,
  type ToolCapabilityCategory,
  type ToolCapabilityGroup,
} from './tools/capability-manifest'
import type { ToolImpactFlag, ToolPostReadAssertion } from './tools/types'

/**
 * Versioned, finite command surface used by the cloud queue.
 *
 * The editor registry remains the execution source of truth. This list only
 * defines the smaller set that the cloud Agent may serialize into a queue
 * task, so cloud structured output never needs an arbitrary params dictionary.
 */
export type LegacyCloudCommandVersion = 2
export type CurrentCloudCommandVersion = 3
export type CloudCommandVersion = LegacyCloudCommandVersion | CurrentCloudCommandVersion
export type CloudCommandVersionWireValue = CloudCommandVersion | '2' | '3'

export const LEGACY_CLOUD_COMMAND_VERSION: LegacyCloudCommandVersion = 2
export const LEGACY_CLOUD_COMMAND_CONTRACT_ID = 'freecut.timeline.commands.v2'

/** The current v3 wire value is the JSON number `3`. */
export const CLOUD_COMMAND_VERSION: CurrentCloudCommandVersion = 3
export const CLOUD_COMMAND_CONTRACT_ID = 'freecut.editor.commands.v3'

export type CloudCommandTargetParam = 'clip' | 'clips' | 'item' | 'items'
export const CLOUD_IMPACT_FLAGS: readonly ToolImpactFlag[] = [
  'semantic',
  'timing',
  'caption',
  'media',
  'effect',
  'motion',
  'audio',
  'mix',
] as const

export interface CloudCommandOperationManifest {
  commandId?: string
  idempotencyKey?: string
  expectedBeforeFingerprint?: string
  impactFlags?: ToolImpactFlag[]
  requiresPostReadback?: boolean
}

export interface CloudCommandSpec {
  readonly type: string
  readonly tool: string
  readonly targetParam?: CloudCommandTargetParam
}

const LEGACY_CLOUD_COMMAND_SPECS = [
  { type: 'timeline.read_project', tool: 'read_project' },
  { type: 'timeline.read_timeline', tool: 'read_timeline' },
  { type: 'timeline.read_media', tool: 'read_media' },
  { type: 'timeline.find_clips', tool: 'find_clips' },
  { type: 'timeline.search_transcript', tool: 'search_transcript' },
  { type: 'timeline.import_local_media', tool: 'import_local_media' },
  { type: 'timeline.generate_captions', tool: 'generate_captions' },
  { type: 'timeline.split', tool: 'split' },
  { type: 'timeline.delete_clips', tool: 'delete_clips', targetParam: 'clips' },
  { type: 'timeline.remove_silence', tool: 'remove_silence', targetParam: 'clips' },
  { type: 'timeline.trim_clip', tool: 'trim_clip', targetParam: 'clip' },
  { type: 'timeline.move_clips', tool: 'move_clips', targetParam: 'items' },
  { type: 'timeline.delete_items', tool: 'delete_items', targetParam: 'items' },
  { type: 'timeline.place_media', tool: 'place_media' },
  { type: 'timeline.add_text', tool: 'add_text' },
  { type: 'timeline.update_subtitle', tool: 'update_subtitle', targetParam: 'item' },
  { type: 'timeline.set_transform', tool: 'set_transform', targetParam: 'items' },
  { type: 'timeline.set_keyframes', tool: 'set_keyframes' },
  { type: 'timeline.set_volume', tool: 'set_volume', targetParam: 'clips' },
  { type: 'timeline.set_audio', tool: 'set_audio', targetParam: 'items' },
  { type: 'timeline.save_project', tool: 'save_project' },
  { type: 'timeline.undo', tool: 'undo' },
  { type: 'timeline.redo', tool: 'redo' },
  { type: 'timeline.check_export', tool: 'check_export' },
  { type: 'timeline.enqueue_export', tool: 'enqueue_export' },
  { type: 'timeline.export_subtitles', tool: 'export_subtitles' },
] as const satisfies readonly CloudCommandSpec[]

const COLOR_COMMAND_SPECS = [
  { type: 'editor.list_effects', tool: 'list_effects' },
  { type: 'editor.apply_effect', tool: 'apply_effect', targetParam: 'items' },
  { type: 'editor.manage_effect_preset', tool: 'manage_effect_preset', targetParam: 'items' },
  {
    type: 'editor.manage_color_grade_clipboard',
    tool: 'manage_color_grade_clipboard',
    targetParam: 'items',
  },
  { type: 'editor.import_cube_lut', tool: 'import_cube_lut', targetParam: 'items' },
  { type: 'editor.balance_color', tool: 'balance_color', targetParam: 'items' },
] as const satisfies readonly CloudCommandSpec[]

const CLOUD_COMMAND_SPECS = [
  ...LEGACY_CLOUD_COMMAND_SPECS,
  ...COLOR_COMMAND_SPECS,
] as const satisfies readonly CloudCommandSpec[]

export type LegacyCloudCommandType = (typeof LEGACY_CLOUD_COMMAND_SPECS)[number]['type']
export const LEGACY_CLOUD_COMMAND_TYPES: readonly LegacyCloudCommandType[] = Object.freeze(
  LEGACY_CLOUD_COMMAND_SPECS.map((spec) => spec.type),
)

export type CloudCommandType = (typeof CLOUD_COMMAND_SPECS)[number]['type']
export const CLOUD_COMMAND_TYPES: readonly CloudCommandType[] = Object.freeze(
  CLOUD_COMMAND_SPECS.map((spec) => spec.type),
)

export interface CloudCommandEnvelope {
  sequence: number
  type: CloudCommandType
  commandId?: string
  attempt?: number
  idempotencyKey?: string
  expectedBeforeSnapshotId?: string
  expectedBeforeFingerprint?: string
  operationManifest?: CloudCommandOperationManifest
  postReadAssertions?: ToolPostReadAssertion[]
  targetId?: string | null
  params?: Record<string, unknown>
}

export interface CloudCommandCapability {
  type: CloudCommandType
  tool: string
  targetParam?: CloudCommandTargetParam
  category: ToolCapabilityCategory
  group: ToolCapabilityGroup
  paramsSchema: JsonSchema
  readOnly: boolean
  destructive: boolean
  handoff: boolean
}

const CLOUD_COMMANDS_BY_TYPE = new Map<string, CloudCommandSpec>(
  CLOUD_COMMAND_SPECS.map((spec) => [spec.type, spec]),
)
const LEGACY_CLOUD_COMMANDS_BY_TYPE = new Map<string, CloudCommandSpec>(
  LEGACY_CLOUD_COMMAND_SPECS.map((spec) => [spec.type, spec]),
)

const CLOUD_COMMAND_KEYS = new Set([
  'sequence',
  'type',
  'commandId',
  'attempt',
  'idempotencyKey',
  'expectedBeforeSnapshotId',
  'expectedBeforeFingerprint',
  'operationManifest',
  'postReadAssertions',
  'targetId',
  'params',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeCloudCommandVersion(value: unknown): CloudCommandVersion {
  if (value === 2 || value === '2') return 2
  if (value === 3 || value === '3') return 3
  throw new Error(`不支持的云端命令版本：${String(value)}`)
}

function optionalId(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`云端命令 ${key} 无效。`)
  }
  return value.trim()
}

function optionalAttempt(input: Record<string, unknown>): number | undefined {
  const value = input.attempt
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new Error('云端命令 attempt 无效。')
  }
  return value as number
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`云端命令 ${key} 无效。`)
  }
  return value
}

function parseImpactFlags(value: unknown): ToolImpactFlag[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > CLOUD_IMPACT_FLAGS.length ||
    value.some(
      (flag) => typeof flag !== 'string' || !CLOUD_IMPACT_FLAGS.includes(flag as ToolImpactFlag),
    )
  ) {
    throw new Error('云端命令 impactFlags 无效。')
  }
  const flags = value as ToolImpactFlag[]
  if (new Set(flags).size !== flags.length) {
    throw new Error('云端命令 impactFlags 不能重复。')
  }
  return [...flags]
}

function parseOperationManifest(value: unknown): CloudCommandOperationManifest | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new Error('云端命令 operationManifest 必须是 JSON 对象。')
  }
  const allowed = new Set([
    'commandId',
    'idempotencyKey',
    'expectedBeforeFingerprint',
    'impactFlags',
    'requiresPostReadback',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`云端命令 operationManifest 包含未知字段：${key}`)
    }
  }
  return {
    commandId: optionalId(value, 'commandId'),
    idempotencyKey: optionalId(value, 'idempotencyKey'),
    expectedBeforeFingerprint: optionalId(value, 'expectedBeforeFingerprint'),
    impactFlags: parseImpactFlags(value.impactFlags),
    requiresPostReadback: optionalBoolean(value, 'requiresPostReadback'),
  }
}

function parsePostReadAssertions(value: unknown): ToolPostReadAssertion[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('云端命令 postReadAssertions 数量无效。')
  }
  const operators = new Set<ToolPostReadAssertion['operator']>([
    'equals',
    'notEquals',
    'exists',
    'notExists',
    'contains',
    'length',
  ])
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`云端命令 postReadAssertions[${index}] 无效。`)
    }
    const allowed = new Set(['path', 'operator', 'expected', 'message'])
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw new Error(`云端命令 postReadAssertions[${index}] 包含未知字段：${key}`)
      }
    }
    if (
      typeof entry.path !== 'string' ||
      !entry.path.trim() ||
      entry.path.length > 512 ||
      typeof entry.operator !== 'string' ||
      !operators.has(entry.operator as ToolPostReadAssertion['operator'])
    ) {
      throw new Error(`云端命令 postReadAssertions[${index}] 无效。`)
    }
    if (entry.message !== undefined && typeof entry.message !== 'string') {
      throw new Error(`云端命令 postReadAssertions[${index}].message 无效。`)
    }
    return {
      path: entry.path.trim(),
      operator: entry.operator as ToolPostReadAssertion['operator'],
      ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    }
  })
}

export function parseCloudCommandEnvelope(
  value: unknown,
  version: CloudCommandVersionWireValue = CLOUD_COMMAND_VERSION,
): CloudCommandEnvelope {
  if (!isRecord(value)) {
    throw new Error('云端命令必须是 JSON 对象。')
  }
  for (const key of Object.keys(value)) {
    if (!CLOUD_COMMAND_KEYS.has(key)) {
      throw new Error(`云端命令包含未知字段：${key}`)
    }
  }

  if (
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence as number) > 10_000
  ) {
    throw new Error('云端命令 sequence 无效。')
  }
  if (typeof value.type !== 'string') {
    throw new Error('云端命令 type 无效。')
  }
  const spec = getCloudCommandSpec(value.type, version)
  if (!spec) {
    throw new Error(`云端返回了本地不支持的命令：${value.type}`)
  }

  const targetId = value.targetId
  if (
    targetId !== undefined &&
    targetId !== null &&
    (typeof targetId !== 'string' || !targetId.trim() || targetId.length > 512)
  ) {
    throw new Error('云端命令 targetId 无效。')
  }

  const params = value.params
  if (params !== undefined && !isRecord(params)) {
    throw new Error('云端命令 params 必须是 JSON 对象。')
  }

  return {
    sequence: value.sequence as number,
    type: spec.type as CloudCommandType,
    commandId: optionalId(value, 'commandId'),
    attempt: optionalAttempt(value),
    idempotencyKey:
      value.idempotencyKey === undefined ? undefined : optionalId(value, 'idempotencyKey'),
    expectedBeforeSnapshotId: optionalId(value, 'expectedBeforeSnapshotId'),
    expectedBeforeFingerprint:
      value.expectedBeforeFingerprint === undefined
        ? undefined
        : optionalId(value, 'expectedBeforeFingerprint'),
    operationManifest: parseOperationManifest(value.operationManifest),
    postReadAssertions: parsePostReadAssertions(value.postReadAssertions),
    targetId: typeof targetId === 'string' ? targetId.trim() : targetId,
    params: params ? { ...params } : undefined,
  }
}

function strictObjectSchema(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    additionalProperties: false,
  }
}

export function getCloudCommandSpec(
  type: string,
  version: CloudCommandVersionWireValue = CLOUD_COMMAND_VERSION,
): CloudCommandSpec | undefined {
  return normalizeCloudCommandVersion(version) === LEGACY_CLOUD_COMMAND_VERSION
    ? LEGACY_CLOUD_COMMANDS_BY_TYPE.get(type)
    : CLOUD_COMMANDS_BY_TYPE.get(type)
}

export function listCloudCommandCapabilities(
  version: CloudCommandVersionWireValue = CLOUD_COMMAND_VERSION,
): CloudCommandCapability[] {
  const specs =
    normalizeCloudCommandVersion(version) === LEGACY_CLOUD_COMMAND_VERSION
      ? LEGACY_CLOUD_COMMAND_SPECS
      : CLOUD_COMMAND_SPECS
  return specs.map((spec) => {
    const toolName = spec.tool
    const tool = getEditorTool(toolName)
    if (!tool) {
      throw new Error(`Cloud command contract references missing tool: ${toolName}`)
    }
    const category = getToolCapabilityMetadata(toolName)
    if (!category) {
      throw new Error(`Cloud command capability ${toolName} is missing category metadata.`)
    }
    return {
      type: spec.type,
      tool: tool.name,
      targetParam: 'targetParam' in spec ? spec.targetParam : undefined,
      category: category.id,
      group: category.group,
      paramsSchema: strictObjectSchema(tool.inputSchema),
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      handoff: tool.handoff,
    }
  })
}
