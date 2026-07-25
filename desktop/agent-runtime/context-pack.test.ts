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
