import { z } from 'zod'
import {
  AGENT_THREAD_STORE_SCHEMA_VERSION,
  type AgentRuntimeRecord,
  type AgentThreadStoreDocument,
} from './agent-thread-types'

const idPattern = /^[a-z0-9][a-z0-9._:-]{0,159}$/i
const digestPattern = /^[a-f0-9]{64}$/i
const idSchema = z.string().trim().regex(idPattern)
const timestampSchema = z.number().int().nonnegative()
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)
const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

const baseRecordFields = {
  id: idSchema,
  threadId: idSchema,
  smokeRunId: idSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}

const threadRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('thread'),
    workspaceId: idSchema,
    projectId: idSchema,
    title: z.string().max(16_384).optional(),
    body: z.string().max(1_048_576).optional(),
    directorState: jsonObjectSchema.optional(),
  })
  .strict()
  .refine((record) => record.id === record.threadId, {
    message: 'Thread record id must equal threadId.',
  })

const taskRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('task'),
    runId: idSchema.optional(),
    status: z.enum([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
      'uncertain',
    ]),
    title: z.string().max(16_384).optional(),
    input: jsonValueSchema.optional(),
    output: jsonValueSchema.optional(),
    errorCode: z.string().max(256).optional(),
  })
  .strict()

const turnRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('turn'),
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    body: z.string().max(1_048_576),
    sequence: z.number().int().nonnegative(),
  })
  .strict()

const runRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('run'),
    projectId: idSchema,
    timelineId: idSchema,
    status: z.enum([
      'created',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
      'uncertain',
    ]),
    input: jsonValueSchema.optional(),
    output: jsonValueSchema.optional(),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
    errorCode: z.string().max(256).optional(),
    fence: z.number().int().positive().optional(),
  })
  .strict()

const handoffRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('handoff'),
    runId: idSchema.optional(),
    version: z.number().int().positive(),
    summary: z.string().max(131_072).optional(),
    body: z.string().max(1_048_576),
  })
  .strict()

const eventRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('event'),
    runId: idSchema.optional(),
    eventType: idSchema,
    payload: jsonValueSchema.optional(),
  })
  .strict()

const checkpointRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('checkpoint'),
    runId: idSchema.optional(),
    snapshotId: idSchema,
    fingerprint: z.string().min(1).max(512),
    snapshot: jsonValueSchema.optional(),
  })
  .strict()

const contextSummaryRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('contextSummary'),
    version: z.number().int().positive(),
    summary: z.string().max(262_144),
  })
  .strict()

const skillLockRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('skillLock'),
    schemaVersion: z.literal(1),
    taskId: idSchema,
    runId: idSchema,
    skillId: idSchema,
    skillVersion: z.string().trim().min(1).max(256),
    skillDigest: z.string().regex(digestPattern),
    lockHash: z.string().regex(digestPattern),
    lockedAt: timestampSchema,
    source: z.literal('cloud'),
    workspaceId: idSchema,
    projectId: idSchema,
  })
  .strict()

const evidenceRecordSchema = z
  .object({
    ...baseRecordFields,
    kind: z.literal('evidence'),
    runId: idSchema.optional(),
    artifact: z.string().min(1).max(65_536),
    sha256: z.string().regex(digestPattern).optional(),
    mediaType: z.string().max(256).optional(),
  })
  .strict()

export const agentRuntimeRecordSchema = z.discriminatedUnion('kind', [
  threadRecordSchema,
  taskRecordSchema,
  turnRecordSchema,
  runRecordSchema,
  handoffRecordSchema,
  eventRecordSchema,
  checkpointRecordSchema,
  contextSummaryRecordSchema,
  skillLockRecordSchema,
  evidenceRecordSchema,
])

const timelineLeaseSchema = z
  .object({
    timelineId: idSchema,
    holderId: idSchema,
    runId: idSchema,
    fence: z.number().int().positive(),
    acquiredAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()

const storeDocumentSchema = z
  .object({
    schemaVersion: z.literal(AGENT_THREAD_STORE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: timestampSchema,
    records: z.array(agentRuntimeRecordSchema),
    leases: z.array(timelineLeaseSchema),
    nextFence: z.number().int().positive(),
  })
  .strict()

export function parseAgentRuntimeRecord(value: unknown): AgentRuntimeRecord {
  return agentRuntimeRecordSchema.parse(value) as AgentRuntimeRecord
}

export function parseAgentThreadStoreDocument(value: unknown): AgentThreadStoreDocument {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== AGENT_THREAD_STORE_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported Agent Thread Store schema version.')
  }
  return storeDocumentSchema.parse(value) as AgentThreadStoreDocument
}

export function createEmptyAgentThreadStore(now = Date.now()): AgentThreadStoreDocument {
  return {
    schemaVersion: AGENT_THREAD_STORE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    records: [],
    leases: [],
    nextFence: 1,
  }
}
