/**
 * Transport-agnostic editor tool contract.
 *
 * One registry of tools feeds three consumers:
 *   1. the cloud OpenAI-compatible Agent — reads the catalog, validates, runs;
 *   2. an in-browser MCP adapter — `inputSchema` + `execute` map directly to
 *      MCP `tools/list` / `tools/call` (see `mcp.ts`);
 *   3. the headless edit CLI — the same `execute` surface, no UI.
 *
 * Because every tool already carries a JSON-Schema `inputSchema`, a normalized
 * `execute(args) => ToolResult`, and capability flags, exposing the editor over
 * MCP later is a thin adapter rather than a rewrite.
 */

/** Minimal JSON Schema shape we author for tool inputs (MCP `inputSchema`). */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolFinalStatus = 'succeeded' | 'failed' | 'cancelled' | 'uncertain'
export type ToolProjectRevision = string | number | null
export type ToolImpactFlag =
  | 'semantic'
  | 'timing'
  | 'caption'
  | 'media'
  | 'effect'
  | 'motion'
  | 'audio'
  | 'mix'

/**
 * Reconciliation is deliberately separate from finalStatus. Existing v2
 * consumers only understand the lowercase terminal status; the richer local
 * state describes whether a write was verified against the live Renderer.
 */
export type ToolReconciliationStatus =
  | 'UNCERTAIN_WRITE'
  | 'RECONCILING'
  | 'VERIFIED_APPLIED'
  | 'VERIFIED_NOT_APPLIED'
  | 'PARTIAL_APPLIED'

export type ToolPhaseName = 'transport' | 'toolAck' | 'commit' | 'postReadback' | 'reconciliation'

export type ToolPhaseStatus = 'pending' | 'succeeded' | 'failed' | 'uncertain'

export interface ToolError {
  code: string
  message: string
  path?: string
  retryable?: boolean
}

export interface ToolWarning {
  code: string
  message: string
}

export interface ToolPhaseReceipt {
  phase: ToolPhaseName
  status: ToolPhaseStatus
  error?: ToolError | null
}

export interface ToolOperationManifest {
  /** Contract id used to create the operation, when the caller supplied one. */
  contractId?: string
  commandId?: string
  commandType?: string
  tool: string
  projectId?: string
  sequence?: number
  attempt?: number
  idempotencyKey?: string
  argsFingerprint?: string
  commitMode?: 'none' | 'timeline-save' | 'tool-owned'
  expectedBeforeSnapshotId?: string
  expectedBeforeFingerprint?: string
  postReadAssertions?: ToolPostReadAssertion[]
  impactFlags: ToolImpactFlag[]
  requiresPostReadback: boolean
}

export type ToolPostReadAssertionOperator =
  | 'equals'
  | 'notEquals'
  | 'exists'
  | 'notExists'
  | 'contains'
  | 'length'

export interface ToolPostReadAssertion {
  path: string
  operator: ToolPostReadAssertionOperator
  expected?: unknown
  message?: string
}

export interface ToolPostReadback {
  status: 'verified' | 'failed' | 'unavailable'
  snapshotId?: string
  fingerprint?: string
  assertions?: ToolPostReadAssertion[]
}

export interface ToolReconciliationEvidence {
  observedAt: string
  method: string
  status: 'applied' | 'not-applied' | 'partial' | 'unknown'
  retryAttempted: false
  newTaskCreated: false
  newCommandCreated: false
  partialChange?: string
}

export interface ToolResult {
  ok: boolean
  /** Short, user- and model-facing outcome line. */
  message: string
  /** Optional structured payload (e.g. query results) for loop/MCP consumers. */
  data?: unknown
  /** Transport request id; adapters fill this when legacy tools omit it. */
  requestId?: string
  /** Stable id for correlating an execution across Agent, MCP, and UI logs. */
  operationId?: string
  /** Whether the call changed persisted editor state. */
  changed?: boolean
  /** Project revision observed after execution, when the storage layer exposes one. */
  projectRevision?: ToolProjectRevision
  /** Concise description of the persisted change, or null for read-only/no-op calls. */
  changeSummary?: string | null
  /** Terminal execution state; adapters derive it from `ok` when omitted. */
  finalStatus?: ToolFinalStatus
  /** Machine-readable failure details. */
  error?: ToolError | null
  /** Non-fatal conditions the caller should surface or consider. */
  warnings?: ToolWarning[]
  /** Stable operation contract used for local reconciliation and audit. */
  operationManifest?: ToolOperationManifest
  /** Individual transport/ack/commit/readback stages for black-box consumers. */
  phaseReceipts?: ToolPhaseReceipt[]
  /** Semantic categories invalidated by this operation. */
  impactFlags?: ToolImpactFlag[]
  /** Local verification state derived from a post-execution readback. */
  reconciliationStatus?: ToolReconciliationStatus
  reconciliation?: ToolReconciliationEvidence
  /** Local snapshot continuity identifiers used by the Bridge and E2E harness. */
  beforeSnapshotId?: string
  afterSnapshotId?: string
  beforeFingerprint?: string
  afterFingerprint?: string
  postReadback?: ToolPostReadback
}

/** Complete receipt emitted by MCP/Bridge adapters for every attempted call. */
export interface ToolReceipt {
  requestId: string
  operationId: string
  changed: boolean
  projectRevision: ToolProjectRevision
  changeSummary: string | null
  finalStatus: ToolFinalStatus
  error: ToolError | null
  warnings: ToolWarning[]
  operationManifest?: ToolOperationManifest
  phaseReceipts?: ToolPhaseReceipt[]
  impactFlags?: ToolImpactFlag[]
  reconciliationStatus?: ToolReconciliationStatus
  reconciliation?: ToolReconciliationEvidence
  beforeSnapshotId?: string
  afterSnapshotId?: string
  beforeFingerprint?: string
  afterFingerprint?: string
  postReadback?: ToolPostReadback
}

export type NormalizedToolResult = Omit<ToolResult, keyof ToolReceipt> & ToolReceipt

export type ToolValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

export interface EditorAgentTool {
  /** Stable id used in plans / MCP `tools/call`. */
  readonly name: string
  /** Human-facing title. */
  readonly title: string
  /** LLM- and MCP-facing description of when to use it. */
  readonly description: string
  /** JSON Schema for the args object (MCP `inputSchema`). */
  readonly inputSchema: JsonSchema
  /** Read-only/query tool — safe to run without confirmation; usable in a gather loop. */
  readonly readOnly: boolean
  /** Mutates the timeline destructively (cut/delete) — always confirm before running. */
  readonly destructive: boolean
  /** Hands off to a review dialog instead of mutating directly. */
  readonly handoff: boolean
  /** Requires a fully loaded editor project rather than the projects/settings shell. */
  readonly requiresProject: boolean
  /** Validate + normalize raw args (returns a friendly error message on failure). */
  validate: (args: unknown) => ToolValidation
  /** One-line plan-step label. */
  summarize: (args: Record<string, unknown>) => string
  /** Execute against the live editor state. */
  execute: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
}
