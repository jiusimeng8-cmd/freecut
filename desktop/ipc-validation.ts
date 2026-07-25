import { z } from 'zod'
import type {
  AgentCleanupInput,
  AgentCloudMetadataInput,
  AgentCompleteRunInput,
  AgentContextPackInput,
  AgentLeaseAcquireInput,
  AgentLeaseAssertInput,
  AgentLeaseReleaseInput,
  AgentLeaseRenewInput,
  AgentPutRecordsInput,
  AgentRecordListInput,
  AgentSandboxWriteInput,
  AgentStartRunInput,
} from './agent-runtime'
import { agentRuntimeRecordSchema } from './agent-runtime/agent-thread-schema'
import type {
  DesktopBridgeConfirmationRequest,
  DesktopBridgeRequest,
  DesktopBridgeToolDescriptor,
  DesktopCloudBridgeRequest,
  DesktopHandleDescriptor,
  DesktopLocalAgentRecordListInput,
  DesktopLocalAgentRunInput,
} from './desktop-types'
import type { DesktopHandleKind } from './workspace'

const MAX_IPC_CHUNK_BYTES = 64 * 1024 * 1024
const MAX_STRUCTURED_PAYLOAD_BYTES = 4 * 1024 * 1024
const MAX_ASR_FALLBACK_BYTES = MAX_IPC_CHUNK_BYTES

const pathSegmentSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'Invalid desktop path segment.',
  )

const handleSchema = z.object({
  token: z.string().min(1).max(128),
  path: z.array(pathSegmentSchema).max(128),
  name: z.string().max(255),
  kind: z.enum(['file', 'directory']),
})

const handleKindSchema = z.enum(['workspace', 'media', 'project-folder'])
const idSchema = z.string().trim().min(1).max(256)
const writerIdSchema = z.string().trim().min(1).max(128)
const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const bytesSchema = z.instanceof(Uint8Array)

const bridgeToolSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(16_384).optional(),
  inputSchema: z.unknown().optional(),
  _meta: z
    .object({
      'freecut/category': z
        .object({
          id: z.string().trim().min(1).max(128),
          title: z.string().trim().min(1).max(256),
          group: z.string().trim().min(1).max(128),
        })
        .optional(),
    })
    .optional(),
  annotations: z
    .object({
      title: z.string().max(256).optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      requiresProject: z.boolean().optional(),
      handoffRequired: z.boolean().optional(),
    })
    .optional(),
})

const bridgeRegistrationSchema = z.object({
  clientId: idSchema,
  projectId: z.string().trim().min(1).max(256).nullable(),
  tools: z.array(bridgeToolSchema).min(1).max(512),
})

const bridgeRequestSchema = z.object({
  requestId: idSchema,
  name: z.string().trim().min(1).max(128),
  args: z.unknown(),
  projectId: z.string().trim().min(1).max(256).optional(),
  allowDestructive: z.boolean().optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(15 * 60_000)
    .optional(),
})

const bridgeConfirmationSchema = z.object({
  requestId: idSchema,
  name: z.string().trim().min(1).max(128),
  projectId: z.string().trim().min(1).max(256).optional(),
  destructive: z.boolean(),
  handoff: z.boolean(),
})

const cloudReceiptIdSchema = z.string().trim().min(1).max(1_024)
const cloudReceiptTextSchema = z.string().max(16_384)
const cloudImpactFlagSchema = z.enum([
  'semantic',
  'timing',
  'caption',
  'media',
  'effect',
  'motion',
  'audio',
  'mix',
])
const cloudToolErrorSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: cloudReceiptTextSchema,
    path: z.string().max(1_024).optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
const cloudPostReadAssertionSchema = z
  .object({
    path: z.string().min(1).max(512),
    operator: z.enum(['equals', 'notEquals', 'exists', 'notExists', 'contains', 'length']),
    expected: z.unknown().optional(),
    message: cloudReceiptTextSchema.optional(),
  })
  .strict()
const cloudOperationManifestSchema = z
  .object({
    contractId: z.string().max(256).optional(),
    commandId: cloudReceiptIdSchema.optional(),
    commandType: z.string().max(256).optional(),
    tool: z.string().min(1).max(256),
    projectId: cloudReceiptIdSchema.optional(),
    sequence: safeIntegerSchema.optional(),
    attempt: z.number().int().positive().max(10_000).optional(),
    idempotencyKey: cloudReceiptIdSchema.optional(),
    argsFingerprint: z.string().max(1_024).optional(),
    commitMode: z.enum(['none', 'timeline-save', 'tool-owned']).optional(),
    expectedBeforeSnapshotId: cloudReceiptIdSchema.optional(),
    expectedBeforeFingerprint: z.string().max(1_024).optional(),
    postReadAssertions: z.array(cloudPostReadAssertionSchema).max(64).optional(),
    impactFlags: z.array(cloudImpactFlagSchema).max(8),
    requiresPostReadback: z.boolean(),
  })
  .strict()
const cloudPhaseReceiptSchema = z
  .object({
    phase: z.enum(['transport', 'toolAck', 'commit', 'postReadback', 'reconciliation']),
    status: z.enum(['pending', 'succeeded', 'failed', 'uncertain']),
    error: cloudToolErrorSchema.nullable().optional(),
  })
  .strict()
const cloudReconciliationSchema = z
  .object({
    observedAt: z.string().min(1).max(128),
    method: z.string().min(1).max(256),
    status: z.enum(['applied', 'not-applied', 'partial', 'unknown']),
    retryAttempted: z.literal(false),
    newTaskCreated: z.literal(false),
    newCommandCreated: z.literal(false),
    partialChange: cloudReceiptTextSchema.optional(),
  })
  .strict()
const cloudPostReadbackSchema = z
  .object({
    status: z.enum(['verified', 'failed', 'unavailable']),
    snapshotId: cloudReceiptIdSchema.optional(),
    fingerprint: z.string().max(1_024).optional(),
    assertions: z.array(cloudPostReadAssertionSchema).max(64).optional(),
  })
  .strict()
const cloudBridgeAckResultSchema = z
  .object({
    sequence: safeIntegerSchema,
    commandId: cloudReceiptIdSchema.optional(),
    type: z.string().max(256).optional(),
    attempt: z.number().int().positive().max(10_000).optional(),
    status: z.enum(['succeeded', 'failed']),
    beforeSnapshotId: cloudReceiptIdSchema.optional(),
    afterSnapshotId: cloudReceiptIdSchema.optional(),
    errorCode: z.string().max(256).optional(),
    errorMessage: cloudReceiptTextSchema.optional(),
    retryable: z.boolean().optional(),
    requestId: cloudReceiptIdSchema.optional(),
    operationId: cloudReceiptIdSchema.optional(),
    changed: z.boolean().optional(),
    projectRevision: z.union([z.string(), z.number().finite(), z.null()]).optional(),
    changeSummary: cloudReceiptTextSchema.nullable().optional(),
    finalStatus: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']).optional(),
    error: cloudToolErrorSchema.nullable().optional(),
    warnings: z
      .array(
        z
          .object({
            code: z.string().min(1).max(256),
            message: cloudReceiptTextSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    operationManifest: cloudOperationManifestSchema.optional(),
    phaseReceipts: z.array(cloudPhaseReceiptSchema).max(16).optional(),
    impactFlags: z.array(cloudImpactFlagSchema).max(8).optional(),
    reconciliationStatus: z
      .enum([
        'UNCERTAIN_WRITE',
        'RECONCILING',
        'VERIFIED_APPLIED',
        'VERIFIED_NOT_APPLIED',
        'PARTIAL_APPLIED',
      ])
      .optional(),
    reconciliation: cloudReconciliationSchema.optional(),
    beforeFingerprint: z.string().max(1_024).optional(),
    afterFingerprint: z.string().max(1_024).optional(),
    postReadback: cloudPostReadbackSchema.optional(),
  })
  .strict()
const cloudBridgeAckBodySchema = z
  .object({
    deviceId: cloudReceiptIdSchema,
    taskId: cloudReceiptIdSchema,
    attempt: z.number().int().positive().max(10_000),
    results: z.array(cloudBridgeAckResultSchema).min(1).max(64),
  })
  .strict()

const cloudBridgeRequestSchema = z.object({
  requestId: idSchema,
  baseUrl: z.string().trim().min(1).max(2_048),
  method: z.enum(['GET', 'POST']).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  path: z.union([
    z.literal('/api/v1/agents/run'),
    z.literal('/api/v1/agent-runs'),
    z.literal('/api/v1/agent-turns'),
    z.string().regex(/^\/api\/v1\/agent-runs\/[0-9a-f-]{36}(?:\/cancel)?$/i),
    z.literal('/api/bridge/poll'),
    z.literal('/api/bridge/ack'),
  ]),
  body: z.unknown(),
})

const localAgentRunInputSchema = z
  .object({
    runId: idSchema,
    threadId: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    timelineId: idSchema,
    profileId: z.string().trim().regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/),
    snapshotId: idSchema,
    fingerprint: z.string().trim().min(1).max(512),
    userMessage: z.string().trim().min(1).max(20_000),
  })
  .strict()

const localAgentRecordListInputSchema = z
  .object({
    threadId: idSchema,
    kinds: z.array(z.literal('turn')).length(1),
  })
  .strict()

const asrInputSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    handle: handleSchema.optional(),
    bytes: bytesSchema
      .refine(
        (value) => value.byteLength <= MAX_ASR_FALLBACK_BYTES,
        'ASR fallback bytes exceed the desktop limit.',
      )
      .optional(),
  })
  .refine((value) => value.handle !== undefined || value.bytes !== undefined, {
    message: 'ASR input requires a desktop handle or fallback bytes.',
  })

const ttsInputSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  voiceId: z.string().max(1_024).optional(),
  rate: z.number().finite().min(-10).max(10).optional(),
  volume: z.number().finite().min(0).max(100).optional(),
})

const agentRecordKindSchema = z.enum([
  'thread',
  'task',
  'turn',
  'run',
  'handoff',
  'event',
  'checkpoint',
  'contextSummary',
  'skillLock',
  'evidence',
])

const agentRecordListInputSchema = z
  .object({
    threadId: idSchema.optional(),
    kinds: z.array(agentRecordKindSchema).max(10).optional(),
    offset: safeIntegerSchema.optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  })
  .strict()

const agentPutRecordsInputSchema = z
  .object({
    records: z.array(agentRuntimeRecordSchema).min(1).max(500),
    expectedRevision: safeIntegerSchema.optional(),
  })
  .strict()

const agentStartRunInputSchema = z
  .object({
    id: idSchema,
    threadId: idSchema,
    projectId: idSchema,
    timelineId: idSchema,
    holderId: idSchema,
    leaseTtlMs: z.number().int().min(1_000).max(30 * 60_000),
    input: z.unknown().optional(),
    smokeRunId: idSchema.optional(),
  })
  .strict()

const agentCompleteRunInputSchema = z
  .object({
    runId: idSchema,
    timelineId: idSchema,
    holderId: idSchema,
    fence: z.number().int().positive(),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']),
    output: z.unknown().optional(),
    errorCode: z.string().max(256).optional(),
    additionalRecords: z.array(agentRuntimeRecordSchema).max(100).optional(),
  })
  .strict()

const agentContextPackInputSchema = z
  .object({
    threadId: idSchema,
    runId: idSchema.optional(),
    snapshotId: idSchema,
    fingerprint: z.string().min(1).max(512),
    recentTurnLimit: z.number().int().min(1).max(20).optional(),
  })
  .strict()

const agentCloudMetadataInputSchema = z
  .object({
    threadId: idSchema,
    runId: idSchema,
    status: z.string().trim().min(1).max(128),
    attempt: z.number().int().positive().optional(),
    commandId: idSchema.optional(),
    snapshotId: idSchema.optional(),
    snapshotHash: z.string().min(1).max(512).optional(),
    fingerprint: z.string().min(1).max(512).optional(),
    contractId: z.string().min(1).max(256).optional(),
    contractVersion: z.string().min(1).max(64).optional(),
    errorCode: z.string().max(256).optional(),
    createdAt: safeIntegerSchema.optional(),
    updatedAt: safeIntegerSchema.optional(),
  })
  .strict()

const agentLeaseAcquireInputSchema = z
  .object({
    timelineId: idSchema,
    holderId: idSchema,
    runId: idSchema,
    ttlMs: z.number().int().min(1_000).max(30 * 60_000),
  })
  .strict()

const agentLeaseIdentityFields = {
  timelineId: idSchema,
  holderId: idSchema,
  runId: idSchema,
  fence: z.number().int().positive(),
}

const agentLeaseRenewInputSchema = z
  .object({
    ...agentLeaseIdentityFields,
    ttlMs: z.number().int().min(1_000).max(30 * 60_000),
  })
  .strict()

const agentLeaseIdentitySchema = z.object(agentLeaseIdentityFields).strict()

const agentSandboxWriteInputSchema = z
  .object({
    runId: idSchema,
    path: z.array(pathSegmentSchema).min(1).max(64),
    bytes: bytesSchema.refine(
      (value) => value.byteLength <= MAX_IPC_CHUNK_BYTES,
      'Agent sandbox bytes exceed the desktop limit.',
    ),
  })
  .strict()

const agentCleanupInputSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('thread'), threadId: idSchema }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
])

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new Error(`Invalid ${label}: ${result.error.issues[0]?.message ?? 'unsupported value'}`)
}

export function parseHandle(value: unknown): DesktopHandleDescriptor {
  return parse(handleSchema, value, 'desktop handle')
}

export function parseHandleKind(value: unknown): DesktopHandleKind {
  return parse(handleKindSchema, value, 'desktop handle kind')
}

export function parseId(value: unknown, label: string): string {
  return parse(idSchema, value, label)
}

export function parseWriterId(value: unknown): string {
  return parse(writerIdSchema, value, 'desktop writerId')
}

export function parseEntryName(value: unknown): string {
  return parse(pathSegmentSchema, value, 'desktop entry name')
}

export function parseSafeInteger(value: unknown, label: string): number {
  return parse(safeIntegerSchema, value, label)
}

export function parseBytes(value: unknown, label: string): Uint8Array {
  const bytes = parse(bytesSchema, value, label)
  if (bytes.byteLength > MAX_IPC_CHUNK_BYTES) {
    throw new Error(`${label} exceeds the desktop IPC chunk limit.`)
  }
  return bytes
}

export function parseBridgeRegistration(value: unknown): {
  clientId: string
  projectId: string | null
  tools: DesktopBridgeToolDescriptor[]
} {
  return parse(bridgeRegistrationSchema, value, 'Bridge registration')
}

export function parseBridgeRequest(value: unknown): DesktopBridgeRequest {
  const request = parse(bridgeRequestSchema, value, 'Bridge request')
  assertStructuredPayloadSize(request.args, 'Bridge request args')
  return request
}

export function parseBridgeConfirmation(value: unknown): DesktopBridgeConfirmationRequest {
  return parse(bridgeConfirmationSchema, value, 'Bridge confirmation')
}

export function parseCloudBridgeRequest(value: unknown): DesktopCloudBridgeRequest {
  const request = parse(cloudBridgeRequestSchema, value, 'cloud Bridge request')
  if (request.path === '/api/bridge/ack') {
    request.body = parse(cloudBridgeAckBodySchema, request.body, 'cloud Bridge acknowledgement')
  }
  assertStructuredPayloadSize(request.body, 'cloud Bridge request body')
  return request as DesktopCloudBridgeRequest
}

export function parseLocalAgentRunInput(value: unknown): DesktopLocalAgentRunInput {
  return parse(localAgentRunInputSchema, value, 'Local Agent run input')
}

export function parseLocalAgentRecordListInput(
  value: unknown,
): DesktopLocalAgentRecordListInput {
  return parse(localAgentRecordListInputSchema, value, 'Local Agent record list input')
}

export function parseAsrInput(value: unknown) {
  return parse(asrInputSchema, value, 'ASR input')
}

export function parseTtsInput(value: unknown) {
  return parse(ttsInputSchema, value, 'TTS input')
}

export function parseAgentRecordListInput(value: unknown): AgentRecordListInput {
  return parse(agentRecordListInputSchema, value, 'Agent record list input')
}

export function parseAgentPutRecordsInput(value: unknown): AgentPutRecordsInput {
  const input = parse(agentPutRecordsInputSchema, value, 'Agent records')
  assertStructuredPayloadSize(input, 'Agent records')
  return input as AgentPutRecordsInput
}

export function parseAgentStartRunInput(value: unknown): AgentStartRunInput {
  const input = parse(agentStartRunInputSchema, value, 'Agent run start input')
  assertStructuredPayloadSize(input, 'Agent run start input')
  return input as AgentStartRunInput
}

export function parseAgentCompleteRunInput(value: unknown): AgentCompleteRunInput {
  const input = parse(agentCompleteRunInputSchema, value, 'Agent run completion input')
  assertStructuredPayloadSize(input, 'Agent run completion input')
  return input as AgentCompleteRunInput
}

export function parseAgentContextPackInput(value: unknown): AgentContextPackInput {
  return parse(agentContextPackInputSchema, value, 'Agent ContextPack input')
}

export function parseAgentCloudMetadataInput(value: unknown): AgentCloudMetadataInput {
  return parse(agentCloudMetadataInputSchema, value, 'Agent cloud metadata')
}

export function parseAgentLeaseAcquireInput(value: unknown): AgentLeaseAcquireInput {
  return parse(agentLeaseAcquireInputSchema, value, 'Agent lease acquisition')
}

export function parseAgentLeaseRenewInput(value: unknown): AgentLeaseRenewInput {
  return parse(agentLeaseRenewInputSchema, value, 'Agent lease renewal')
}

export function parseAgentLeaseReleaseInput(value: unknown): AgentLeaseReleaseInput {
  return parse(agentLeaseIdentitySchema, value, 'Agent lease release')
}

export function parseAgentLeaseAssertInput(value: unknown): AgentLeaseAssertInput {
  return parse(agentLeaseIdentitySchema, value, 'Agent lease assertion')
}

export function parseAgentSandboxWriteInput(value: unknown): AgentSandboxWriteInput {
  return parse(agentSandboxWriteInputSchema, value, 'Agent sandbox write')
}

export function parseAgentCleanupInput(value: unknown): AgentCleanupInput {
  return parse(agentCleanupInputSchema, value, 'Agent cleanup input')
}

export function parseHandleStoreEntry(value: unknown) {
  return parse(
    z.object({
      kind: handleKindSchema,
      id: idSchema,
      handle: handleSchema,
      pickedAt: safeIntegerSchema,
      lastSeenPath: z.string().max(32_768).optional(),
      lastSeenSize: safeIntegerSchema.optional(),
      lastSeenMtime: z.number().finite().nonnegative().optional(),
      activeWorkspaceId: z.string().max(256).optional(),
    }),
    value,
    'desktop handle store entry',
  )
}

export function assertStructuredPayloadSize(value: unknown, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > MAX_STRUCTURED_PAYLOAD_BYTES) {
    throw new Error(`${label} exceeds the desktop structured payload limit.`)
  }
}
