export const AGENT_RUNTIME_CONTRACT_ID = 'freecut.agent-runtime.local-first.v1'
export const AGENT_THREAD_STORE_SCHEMA_VERSION = 1
export const AGENT_CONTEXT_PACK_SCHEMA_VERSION = 1
export const AGENT_THREAD_STORE_HARD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
export const AGENT_SANDBOX_MAX_WRITE_BYTES = 64 * 1024 * 1024

export const AGENT_CONTEXT_PACK_FIELDS = [
  'contractId',
  'schemaVersion',
  'threadId',
  'projectId',
  'runId',
  'contextSummary',
  'recentTurns',
  'directorState',
  'handoff',
  'snapshotId',
  'fingerprint',
] as const

export const AGENT_CLOUD_METADATA_FIELDS = [
  'threadId',
  'runId',
  'status',
  'attempt',
  'commandId',
  'snapshotId',
  'snapshotHash',
  'fingerprint',
  'contractId',
  'contractVersion',
  'errorCode',
  'createdAt',
  'updatedAt',
] as const

export const AGENT_CLOUD_FORBIDDEN_CONTENT_FIELDS = [
  'body',
  'prompt',
  'contextPack',
  'modelInput',
  'modelOutput',
  'handoffBody',
  'transcript',
  'toolArgs',
  'toolResult',
  'mediaBytes',
  'mediaUrl',
  'workspacePath',
  'apiKey',
  'authorization',
  'token',
] as const

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue }

interface AgentRecordBase {
  id: string
  kind: AgentRuntimeRecordKind
  threadId: string
  smokeRunId?: string
  createdAt: number
  updatedAt: number
}

export interface AgentThreadRecord extends Omit<AgentRecordBase, 'kind' | 'threadId'> {
  kind: 'thread'
  threadId: string
  workspaceId: string
  projectId: string
  title?: string
  body?: string
  directorState?: Record<string, AgentJsonValue>
}

export interface AgentTaskRecord extends AgentRecordBase {
  kind: 'task'
  runId?: string
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'uncertain'
  title?: string
  input?: AgentJsonValue
  output?: AgentJsonValue
  errorCode?: string
}

export interface AgentTurnRecord extends AgentRecordBase {
  kind: 'turn'
  role: 'user' | 'assistant' | 'system' | 'tool'
  body: string
  sequence: number
}

export interface AgentRunRecord extends AgentRecordBase {
  kind: 'run'
  projectId: string
  timelineId: string
  status:
    | 'created'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'uncertain'
  input?: AgentJsonValue
  output?: AgentJsonValue
  startedAt?: number
  finishedAt?: number
  errorCode?: string
  fence?: number
}

export interface AgentHandoffRecord extends AgentRecordBase {
  kind: 'handoff'
  runId?: string
  version: number
  summary?: string
  body: string
}

export interface AgentEventRecord extends AgentRecordBase {
  kind: 'event'
  runId?: string
  eventType: string
  payload?: AgentJsonValue
}

export interface AgentCheckpointRecord extends AgentRecordBase {
  kind: 'checkpoint'
  runId?: string
  snapshotId: string
  fingerprint: string
  snapshot?: AgentJsonValue
}

export interface AgentContextSummaryRecord extends AgentRecordBase {
  kind: 'contextSummary'
  version: number
  summary: string
}

export interface AgentSkillLockRecord extends AgentRecordBase {
  kind: 'skillLock'
  schemaVersion: 1
  taskId: string
  runId: string
  skillId: string
  skillVersion: string
  skillDigest: string
  lockHash: string
  lockedAt: number
  source: 'cloud'
  workspaceId: string
  projectId: string
}

export interface AgentEvidenceRecord extends AgentRecordBase {
  kind: 'evidence'
  runId?: string
  artifact: string
  sha256?: string
  mediaType?: string
}

export type AgentRuntimeRecord =
  | AgentThreadRecord
  | AgentTaskRecord
  | AgentTurnRecord
  | AgentRunRecord
  | AgentHandoffRecord
  | AgentEventRecord
  | AgentCheckpointRecord
  | AgentContextSummaryRecord
  | AgentSkillLockRecord
  | AgentEvidenceRecord

export type AgentRuntimeRecordKind = AgentRuntimeRecord['kind']

export interface AgentTimelineLease {
  timelineId: string
  holderId: string
  runId: string
  fence: number
  acquiredAt: number
  expiresAt: number
}

export interface AgentThreadStoreDocument {
  schemaVersion: 1
  revision: number
  updatedAt: number
  records: AgentRuntimeRecord[]
  leases: AgentTimelineLease[]
  nextFence: number
}

export interface AgentRuntimeInfo {
  contractId: typeof AGENT_RUNTIME_CONTRACT_ID
  schemaVersion: typeof AGENT_THREAD_STORE_SCHEMA_VERSION
  dataRoot: string
  storePath: string
  sandboxRoot: string
  logsPath: string
  storeRevision: number
  recordCounts: Record<AgentRuntimeRecordKind, number>
  sandboxLifecycle: {
    create: 'run-start'
    cleanup: 'after-durable-terminal-result'
    uncertainRunPolicy: 'retain-for-reconciliation'
  }
  contextPackAllowlist: readonly string[]
  safeStorageBoundary: {
    storesAgentContent: false
    stores: readonly ['business-keys', 'device-credentials']
  }
  timelineWritePolicy: {
    mode: 'single-writer-per-timeline'
    fencing: true
  }
  cleanupPolicy: {
    explicitOnly: true
    credentialsPreserved: true
    cloudRestoreAvailable: false
  }
  capacityPolicy: {
    durableStoreHardLimitBytes: number
    sandboxMaxWriteBytes: number
    automaticContentEviction: false
  }
  cloudZeroRetention: {
    persistedMetadataAllowlist: readonly string[]
    forbiddenContentFields: readonly string[]
    assertions: readonly string[]
  }
}

export interface AgentRecordListInput {
  threadId?: string
  kinds?: AgentRuntimeRecordKind[]
  offset?: number
  limit?: number
}

export interface AgentRecordListResult {
  revision: number
  records: AgentRuntimeRecord[]
  offset: number
  nextOffset?: number
  total: number
}

export interface AgentPutRecordsInput {
  records: AgentRuntimeRecord[]
  expectedRevision?: number
}

export interface AgentPutRecordsResult {
  revision: number
  stored: Array<{ kind: AgentRuntimeRecordKind; id: string }>
}

export interface AgentStartRunInput {
  id: string
  threadId: string
  projectId: string
  timelineId: string
  holderId: string
  leaseTtlMs: number
  input?: AgentJsonValue
  smokeRunId?: string
}

export type AgentStartRunResult =
  | {
      started: true
      run: AgentRunRecord
      lease: AgentTimelineLease
      revision: number
    }
  | {
      started: false
      reason: 'LEASE_HELD'
      lease: AgentTimelineLease
    }

export interface AgentCompleteRunInput {
  runId: string
  timelineId: string
  holderId: string
  fence: number
  status: 'succeeded' | 'failed' | 'cancelled' | 'uncertain'
  output?: AgentJsonValue
  errorCode?: string
  additionalRecords?: AgentRuntimeRecord[]
}

export interface AgentContextPackInput {
  threadId: string
  runId?: string
  snapshotId: string
  fingerprint: string
  recentTurnLimit?: number
}

export interface AgentContextPack {
  contractId: typeof AGENT_RUNTIME_CONTRACT_ID
  schemaVersion: 1
  threadId: string
  projectId: string
  runId?: string
  contextSummary?: {
    id: string
    version: number
    summary: string
  }
  recentTurns: Array<{
    id: string
    role: AgentTurnRecord['role']
    body: string
    sequence: number
    createdAt: number
  }>
  directorState?: Record<string, AgentJsonValue>
  handoff?: {
    id: string
    version: number
    summary?: string
  }
  snapshotId: string
  fingerprint: string
}

export interface AgentCloudMetadataInput {
  threadId: string
  runId: string
  status: string
  attempt?: number
  commandId?: string
  snapshotId?: string
  snapshotHash?: string
  fingerprint?: string
  contractId?: string
  contractVersion?: string
  errorCode?: string
  createdAt?: number
  updatedAt?: number
}

export interface AgentCloudMetadataProjection extends AgentCloudMetadataInput {
  contentStorage: 'forbidden'
  contentFields: []
}

export interface AgentLeaseAcquireInput {
  timelineId: string
  holderId: string
  runId: string
  ttlMs: number
}

export type AgentLeaseAcquireResult =
  | { acquired: true; lease: AgentTimelineLease }
  | { acquired: false; reason: 'LEASE_HELD'; lease: AgentTimelineLease }

export interface AgentLeaseRenewInput {
  timelineId: string
  holderId: string
  runId: string
  fence: number
  ttlMs: number
}

export interface AgentLeaseReleaseInput {
  timelineId: string
  holderId: string
  runId: string
  fence: number
}

export interface AgentLeaseAssertInput {
  timelineId: string
  holderId: string
  runId: string
  fence: number
}

export interface AgentSandboxWriteInput {
  runId: string
  path: string[]
  bytes: Uint8Array
}

export interface AgentSandboxStatus {
  runId: string
  exists: boolean
  fileCount: number
  totalBytes: number
}

export type AgentCleanupInput =
  | { scope: 'thread'; threadId: string }
  | { scope: 'all' }

export interface AgentCleanupResult {
  scope: AgentCleanupInput['scope']
  removedRecords: number
  removedSandboxes: number
  credentialsPreserved: true
  cloudRestoreAvailable: false
}
