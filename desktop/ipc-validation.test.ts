// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import {
  assertStructuredPayloadSize,
  parseAgentCloudMetadataInput,
  parseAgentPutRecordsInput,
  parseAgentSandboxWriteInput,
  parseAsrInput,
  parseBridgeRegistration,
  parseCloudBridgeRequest,
  parseHandle,
  parseLocalAgentRecordListInput,
  parseLocalAgentRunInput,
  parseTtsInput,
} from './ipc-validation'

describe('Desktop IPC validation', () => {
  it('accepts an opaque handle and rejects path traversal', () => {
    expect(
      parseHandle({
        token: 'token-1',
        path: ['projects', 'project.json'],
        name: 'project.json',
        kind: 'file',
      }),
    ).toEqual(
      expect.objectContaining({
        path: ['projects', 'project.json'],
      }),
    )
    expect(() =>
      parseHandle({
        token: 'token-1',
        path: ['..', 'secret.txt'],
        name: 'secret.txt',
        kind: 'file',
      }),
    ).toThrow('Invalid desktop path segment')
  })

  it('requires ASR media and bounds TTS input', () => {
    expect(() =>
      parseAsrInput({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      }),
    ).toThrow('requires a desktop handle or fallback bytes')
    expect(() => parseTtsInput({ text: '', rate: 1 })).toThrow('Too small')
  })

  it('rejects oversized Bridge registrations and structured results', () => {
    expect(() =>
      parseBridgeRegistration({
        clientId: 'renderer',
        projectId: 'p1',
        tools: Array.from({ length: 513 }, (_, index) => ({ name: `tool-${index}` })),
      }),
    ).toThrow('Too big')
    expect(() =>
      assertStructuredPayloadSize('x'.repeat(4 * 1024 * 1024 + 1), 'result'),
    ).toThrow('structured payload limit')
  })

  it('preserves categorized MCP metadata in Bridge registrations', () => {
    expect(
      parseBridgeRegistration({
        clientId: 'renderer',
        projectId: 'p1',
        tools: [
          {
            name: 'balance_color',
            _meta: {
              'freecut/category': {
                id: 'color',
                title: 'Color grading',
                group: 'creative',
              },
            },
          },
        ],
      }).tools[0],
    ).toMatchObject({
      name: 'balance_color',
      _meta: {
        'freecut/category': {
          id: 'color',
          title: 'Color grading',
          group: 'creative',
        },
      },
    })
  })

  it('accepts structured cloud ACK receipts and rejects tool result content', () => {
    const body = {
      deviceId: 'device-1',
      taskId: 'task-1',
      attempt: 2,
      results: [
        {
          sequence: 0,
          commandId: 'command-1',
          type: 'timeline.add_text',
          attempt: 2,
          status: 'succeeded',
          requestId: 'request-1',
          operationId: 'operation-1',
          changed: true,
          projectRevision: 'revision-2',
          changeSummary: 'Added one text item.',
          finalStatus: 'succeeded',
          error: null,
          warnings: [{ code: 'TEST_WARNING', message: 'warning' }],
          operationManifest: {
            contractId: 'freecut.timeline.commands.v2',
            commandId: 'command-1',
            commandType: 'timeline.add_text',
            tool: 'add_text',
            projectId: 'project-1',
            sequence: 0,
            attempt: 2,
            idempotencyKey: 'operation-1',
            argsFingerprint: 'fnv1a64:args',
            commitMode: 'timeline-save',
            expectedBeforeSnapshotId: 'snapshot-before',
            expectedBeforeFingerprint: 'fnv1a64:before',
            postReadAssertions: [{ path: 'timeline.textCount', operator: 'equals', expected: 1 }],
            impactFlags: ['semantic', 'motion'],
            requiresPostReadback: true,
          },
          phaseReceipts: [
            { phase: 'transport', status: 'succeeded' },
            { phase: 'postReadback', status: 'succeeded' },
          ],
          impactFlags: ['semantic', 'motion'],
          reconciliationStatus: 'VERIFIED_APPLIED',
          reconciliation: {
            observedAt: '2026-07-22T00:00:00.000Z',
            method: 'renderer-post-readback',
            status: 'applied',
            retryAttempted: false,
            newTaskCreated: false,
            newCommandCreated: false,
          },
          beforeSnapshotId: 'snapshot-before',
          afterSnapshotId: 'snapshot-after',
          beforeFingerprint: 'fnv1a64:before',
          afterFingerprint: 'fnv1a64:after',
          postReadback: {
            status: 'verified',
            snapshotId: 'snapshot-after',
            fingerprint: 'fnv1a64:after',
            assertions: [{ path: 'timeline.textCount', operator: 'equals', expected: 1 }],
          },
        },
      ],
    }

    expect(
      parseCloudBridgeRequest({
        requestId: 'request-1',
        baseUrl: 'https://mcp.123jianhao.com',
        path: '/api/bridge/ack',
        body,
      }).body,
    ).toMatchObject({
      attempt: 2,
      results: [
        expect.objectContaining({
          operationId: 'operation-1',
          reconciliationStatus: 'VERIFIED_APPLIED',
          beforeFingerprint: 'fnv1a64:before',
          afterFingerprint: 'fnv1a64:after',
        }),
      ],
    })

    expect(() =>
      parseCloudBridgeRequest({
        requestId: 'request-2',
        baseUrl: 'https://mcp.123jianhao.com',
        path: '/api/bridge/ack',
        body: {
          ...body,
          results: [{ ...body.results[0], data: { transcript: 'must stay local' } }],
        },
      }),
    ).toThrow('Unrecognized key')
  })

  it('accepts only the exact stateless Agent Turn cloud path', () => {
    expect(
      parseCloudBridgeRequest({
        requestId: 'agent-turn-1',
        baseUrl: 'https://mcp.123jianhao.com',
        path: '/api/v1/agent-turns',
        body: {},
      }).path,
    ).toBe('/api/v1/agent-turns')

    expect(() =>
      parseCloudBridgeRequest({
        requestId: 'agent-turn-2',
        baseUrl: 'https://mcp.123jianhao.com',
        path: '/api/v1/agent-turns/anything',
        body: {},
      }),
    ).toThrow()
  })

  it('accepts only the local Agent panel IPC contract', () => {
    const input = {
      runId: 'run-1',
      threadId: 'project:project-1',
      workspaceId: 'project:project-1',
      projectId: 'project-1',
      timelineId: 'project-1',
      profileId: 'editing-director',
      snapshotId: 'snapshot-1',
      fingerprint: 'fnv1a64:timeline',
      userMessage: '统一色调',
    }

    expect(parseLocalAgentRunInput(input)).toEqual(input)
    expect(
      parseLocalAgentRecordListInput({
        threadId: 'project:project-1',
        kinds: ['turn'],
      }),
    ).toEqual({
      threadId: 'project:project-1',
      kinds: ['turn'],
    })
    expect(() =>
      parseLocalAgentRunInput({
        ...input,
        holderId: 'agent-panel:run-1',
      }),
    ).toThrow('Unrecognized key')
    expect(() =>
      parseLocalAgentRecordListInput({
        threadId: 'project:project-1',
        kinds: ['run'],
      }),
    ).toThrow()
  })

  it('accepts strict Agent records and rejects cloud content or sandbox traversal', () => {
    expect(
      parseAgentPutRecordsInput({
        records: [
          {
            kind: 'thread',
            id: 'thread-1',
            threadId: 'thread-1',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ).toEqual(expect.objectContaining({ records: [expect.objectContaining({ kind: 'thread' })] }))

    expect(() =>
      parseAgentCloudMetadataInput({
        threadId: 'thread-1',
        runId: 'run-1',
        status: 'succeeded',
        prompt: 'must stay local',
      }),
    ).toThrow('Unrecognized key')
    expect(() =>
      parseAgentSandboxWriteInput({
        runId: 'run-1',
        path: ['..', 'outside.txt'],
        bytes: new Uint8Array([1]),
      }),
    ).toThrow('Invalid desktop path segment')
  })
})
