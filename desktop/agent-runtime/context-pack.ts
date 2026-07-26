import type {
  AgentCloudMetadataInput,
  AgentCloudMetadataProjection,
  AgentContextPack,
  AgentContextPackInput,
  AgentContextSummaryRecord,
  AgentHandoffRecord,
  AgentThreadStoreDocument,
  AgentTurnRecord,
} from './agent-thread-types'
import { AGENT_RUNTIME_CONTRACT_ID } from './agent-thread-types'

/**
 * A Director round writes two turns (the assistant's narration and the tool
 * receipt), so this limit is consumed at twice the rate a conversation would
 * suggest. At 8 it covered only four rounds of a twelve-round loop, and the
 * originating user request was evicted partway through — leaving the model to
 * infer the goal from its own narration. Sized to cover the whole loop instead.
 */
const DEFAULT_RECENT_TURN_LIMIT = 30
const MAX_RECENT_TURN_LIMIT = 60
const MAX_CONTEXT_TEXT_CHARS = 32_768

function limitedText(value: string): string {
  return value.slice(0, MAX_CONTEXT_TEXT_CHARS)
}

export function buildAgentContextPack(
  document: AgentThreadStoreDocument,
  input: AgentContextPackInput,
): AgentContextPack {
  const thread = document.records.find(
    (record) => record.kind === 'thread' && record.id === input.threadId,
  )
  if (!thread || thread.kind !== 'thread') {
    throw new Error(`Unknown Agent thread: ${input.threadId}`)
  }
  const recentTurnLimit = Math.min(
    MAX_RECENT_TURN_LIMIT,
    Math.max(1, input.recentTurnLimit ?? DEFAULT_RECENT_TURN_LIMIT),
  )
  const threadTurns = document.records
    .filter(
      (record): record is AgentTurnRecord =>
        record.kind === 'turn' && record.threadId === input.threadId,
    )
    .sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt)
  const windowed = threadTurns.slice(-recentTurnLimit)
  // A long tool-calling loop can push the request that started it out of the
  // window, and the model then has nothing stating the goal — which is how a run
  // ends up asking the user for something they already said. Keep the newest user
  // turn regardless of position; it is the one turn the loop cannot work without.
  const latestUserTurn = [...threadTurns].reverse().find((turn) => turn.role === 'user')
  const anchored =
    latestUserTurn && !windowed.includes(latestUserTurn)
      ? [latestUserTurn, ...windowed.slice(1)]
      : windowed
  const recentTurns = anchored.map((turn) => ({
    id: turn.id,
    role: turn.role,
    body: limitedText(turn.body),
    sequence: turn.sequence,
    createdAt: turn.createdAt,
  }))
  const contextSummary = document.records
    .filter(
      (record): record is AgentContextSummaryRecord =>
        record.kind === 'contextSummary' && record.threadId === input.threadId,
    )
    .sort((left, right) => right.version - left.version || right.updatedAt - left.updatedAt)[0]
  const handoff = document.records
    .filter(
      (record): record is AgentHandoffRecord =>
        record.kind === 'handoff' && record.threadId === input.threadId,
    )
    .sort((left, right) => right.version - left.version || right.updatedAt - left.updatedAt)[0]

  return {
    contractId: AGENT_RUNTIME_CONTRACT_ID,
    schemaVersion: 1,
    threadId: thread.id,
    projectId: thread.projectId,
    runId: input.runId,
    contextSummary: contextSummary
      ? {
          id: contextSummary.id,
          version: contextSummary.version,
          summary: limitedText(contextSummary.summary),
        }
      : undefined,
    recentTurns,
    directorState: thread.directorState ? structuredClone(thread.directorState) : undefined,
    handoff: handoff
      ? {
          id: handoff.id,
          version: handoff.version,
          summary: handoff.summary ? limitedText(handoff.summary) : undefined,
        }
      : undefined,
    snapshotId: input.snapshotId,
    fingerprint: input.fingerprint,
  }
}

export function projectAgentCloudMetadata(
  input: AgentCloudMetadataInput,
): AgentCloudMetadataProjection {
  return {
    threadId: input.threadId,
    runId: input.runId,
    status: input.status,
    attempt: input.attempt,
    commandId: input.commandId,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
    fingerprint: input.fingerprint,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    errorCode: input.errorCode,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    contentStorage: 'forbidden',
    contentFields: [],
  }
}
