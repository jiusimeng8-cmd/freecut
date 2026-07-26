// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { createEmptyAgentThreadStore } from './agent-thread-schema'
import { buildAgentContextPack, projectAgentCloudMetadata } from './context-pack'

describe('Agent ContextPack', () => {
  it('contains only the frozen allowlist and never includes handoff body or evidence content', () => {
    const document = createEmptyAgentThreadStore(1)
    document.records = [
      {
        kind: 'thread',
        id: 'thread-1',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        directorState: { phase: 'review' },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        kind: 'turn',
        id: 'turn-1',
        threadId: 'thread-1',
        role: 'user',
        body: 'recent user message',
        sequence: 1,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        kind: 'contextSummary',
        id: 'summary-1',
        threadId: 'thread-1',
        version: 1,
        summary: 'bounded summary',
        createdAt: 3,
        updatedAt: 3,
      },
      {
        kind: 'handoff',
        id: 'handoff-1',
        threadId: 'thread-1',
        version: 2,
        summary: 'handoff summary',
        body: 'LOCAL_ONLY_HANDOFF_BODY_SENTINEL',
        createdAt: 4,
        updatedAt: 4,
      },
      {
        kind: 'evidence',
        id: 'evidence-1',
        threadId: 'thread-1',
        artifact: 'LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL',
        createdAt: 5,
        updatedAt: 5,
      },
    ]

    const pack = buildAgentContextPack(document, {
      threadId: 'thread-1',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })
    expect(Object.keys(pack).sort()).toEqual(
      [
        'contractId',
        'contextSummary',
        'directorState',
        'fingerprint',
        'handoff',
        'projectId',
        'recentTurns',
        'runId',
        'schemaVersion',
        'snapshotId',
        'threadId',
      ].sort(),
    )
    expect(JSON.stringify(pack)).not.toContain('LOCAL_ONLY_HANDOFF_BODY_SENTINEL')
    expect(JSON.stringify(pack)).not.toContain('LOCAL_ONLY_EVIDENCE_ARTIFACT_SENTINEL')
  })

  it('keeps the originating user request in the window during a long tool loop', () => {
    const document = createEmptyAgentThreadStore(1)
    document.records = [
      {
        kind: 'thread',
        id: 'thread-1',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        kind: 'turn',
        id: 'turn-user',
        threadId: 'thread-1',
        role: 'user',
        body: 'IMPORT_TO_TIMELINE_REQUEST',
        sequence: 0,
        createdAt: 2,
        updatedAt: 2,
      },
      // Two turns per round, the way the Director loop writes them, for enough
      // rounds to push the request past any sane window.
      ...Array.from({ length: 80 }, (_unused, index) => ({
        kind: 'turn' as const,
        id: `turn-${index}`,
        threadId: 'thread-1',
        role: index % 2 === 0 ? ('assistant' as const) : ('tool' as const),
        body: `round chatter ${index}`,
        sequence: index + 1,
        createdAt: index + 3,
        updatedAt: index + 3,
      })),
    ]

    const pack = buildAgentContextPack(document, {
      threadId: 'thread-1',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    // Without anchoring the model sees only its own narration and has to ask
    // the user for a goal they already stated.
    expect(pack.recentTurns.map((turn) => turn.body)).toContain('IMPORT_TO_TIMELINE_REQUEST')
    // The newest turns still win the remaining slots.
    expect(pack.recentTurns.at(-1)?.body).toBe('round chatter 79')
  })

  it('anchors the newest user request rather than the first one', () => {
    const document = createEmptyAgentThreadStore(1)
    document.records = [
      {
        kind: 'thread',
        id: 'thread-1',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        kind: 'turn',
        id: 'turn-old',
        threadId: 'thread-1',
        role: 'user',
        body: 'STALE_EARLIER_REQUEST',
        sequence: 0,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        kind: 'turn',
        id: 'turn-current',
        threadId: 'thread-1',
        role: 'user',
        body: 'CURRENT_REQUEST',
        sequence: 1,
        createdAt: 3,
        updatedAt: 3,
      },
      ...Array.from({ length: 80 }, (_unused, index) => ({
        kind: 'turn' as const,
        id: `turn-${index}`,
        threadId: 'thread-1',
        role: 'assistant' as const,
        body: `chatter ${index}`,
        sequence: index + 2,
        createdAt: index + 4,
        updatedAt: index + 4,
      })),
    ]

    const pack = buildAgentContextPack(document, {
      threadId: 'thread-1',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
    })

    const bodies = pack.recentTurns.map((turn) => turn.body)
    expect(bodies).toContain('CURRENT_REQUEST')
    expect(bodies).not.toContain('STALE_EARLIER_REQUEST')
  })

  it('never exceeds the requested window size while anchoring', () => {
    const document = createEmptyAgentThreadStore(1)
    document.records = [
      {
        kind: 'thread',
        id: 'thread-1',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        kind: 'turn',
        id: 'turn-user',
        threadId: 'thread-1',
        role: 'user',
        body: 'REQUEST',
        sequence: 0,
        createdAt: 2,
        updatedAt: 2,
      },
      ...Array.from({ length: 10 }, (_unused, index) => ({
        kind: 'turn' as const,
        id: `turn-${index}`,
        threadId: 'thread-1',
        role: 'assistant' as const,
        body: `chatter ${index}`,
        sequence: index + 1,
        createdAt: index + 3,
        updatedAt: index + 3,
      })),
    ]

    const pack = buildAgentContextPack(document, {
      threadId: 'thread-1',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      fingerprint: 'fingerprint-1',
      recentTurnLimit: 3,
    })

    expect(pack.recentTurns).toHaveLength(3)
    expect(pack.recentTurns.map((turn) => turn.body)).toContain('REQUEST')
  })

  it('projects cloud persistence metadata without accepting content fields', () => {
    const metadata = projectAgentCloudMetadata({
      threadId: 'thread-1',
      runId: 'run-1',
      status: 'succeeded',
      snapshotId: 'snapshot-1',
      snapshotHash: 'hash-1',
      fingerprint: 'fingerprint-1',
    })

    expect(metadata).toEqual(
      expect.objectContaining({
        contentStorage: 'forbidden',
        contentFields: [],
      }),
    )
    expect(JSON.stringify(metadata)).not.toContain('prompt')
    expect(JSON.stringify(metadata)).not.toContain('modelInput')
    expect(JSON.stringify(metadata)).not.toContain('handoffBody')
  })
})
