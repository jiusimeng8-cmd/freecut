import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { CloudBridgeTask } from '@/features/editor/agent/cloud-bridge-client'
import type { McpCallResult } from '@/features/editor/agent/tools'
import {
  acknowledgeCloudBridgeTask,
  selectCloudBridgeReceipt,
} from '@/features/editor/agent/cloud-bridge-client'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_COMMAND_VERSION,
} from '@/features/editor/agent/cloud-command-contract'
import { captureCloudSnapshot } from '@/features/editor/agent/cloud-bridge-snapshots'
import { useTimelineStore } from '@/features/editor/deps/timeline-contract'
import { executeCloudTask } from './freecut-bridge-runner'

const runnerMocks = vi.hoisted(() => ({
  currentSnapshotId: 'snapshot-1',
  executeCloudCommand: vi.fn(),
}))

vi.mock('@/features/editor/agent/cloud-bridge-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/editor/agent/cloud-bridge-client')>()
  return {
    ...actual,
    acknowledgeCloudBridgeTask: vi.fn(),
  }
})

vi.mock('@/features/editor/agent/cloud-command-runner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/editor/agent/cloud-command-runner')>()
  return {
    ...actual,
    executeCloudCommand: runnerMocks.executeCloudCommand,
  }
})

vi.mock('@/features/editor/agent/cloud-bridge-snapshots', () => ({
  captureCloudSnapshot: vi.fn(() => {
    runnerMocks.currentSnapshotId =
      runnerMocks.currentSnapshotId === 'snapshot-1' ? 'snapshot-2' : 'snapshot-3'
    return runnerMocks.currentSnapshotId
  }),
  getCurrentCloudSnapshotId: vi.fn(() => runnerMocks.currentSnapshotId),
}))

const originalDesktop = window.freecutDesktop

beforeEach(() => {
  vi.clearAllMocks()
  runnerMocks.currentSnapshotId = 'snapshot-1'
  runnerMocks.executeCloudCommand.mockImplementation(async (_projectId, command) => {
    if (
      command.expectedBeforeSnapshotId &&
      command.expectedBeforeSnapshotId !== runnerMocks.currentSnapshotId
    ) {
      return {
        content: [
          {
            type: 'text',
            text: 'The command precondition does not match the current Renderer snapshot.',
          },
        ],
        isError: true,
        structuredContent: {
          ok: false,
          message: 'The command precondition does not match the current Renderer snapshot.',
          changed: false,
          error: {
            code: 'SNAPSHOT_CONFLICT',
            message: 'The command precondition does not match the current Renderer snapshot.',
          },
        },
      }
    }
    runnerMocks.currentSnapshotId = 'snapshot-after'
    return {
      content: [{ type: 'text', text: 'Read completed.' }],
      isError: false,
      structuredContent: {
        ok: true,
        message: 'Read completed.',
        changed: false,
        finalStatus: 'succeeded',
        beforeSnapshotId: 'snapshot-internal-before',
        afterSnapshotId: runnerMocks.currentSnapshotId,
      },
    }
  })
  vi.mocked(acknowledgeCloudBridgeTask).mockResolvedValue({
    taskId: 'task-1',
    status: 'succeeded',
    retryable: false,
  })
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: {
    bridge: {
      call: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Read completed.' }],
        isError: false,
        structuredContent: {
          ok: true,
          message: 'Read completed.',
          changed: false,
          finalStatus: 'succeeded',
        },
      })),
      cancel: vi.fn(),
    },
    } as unknown as typeof window.freecutDesktop,
  })
})

afterEach(() => {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: originalDesktop,
  })
  vi.restoreAllMocks()
})

function readOnlyTask(): CloudBridgeTask {
  return {
    id: 'task-read-only',
    projectId: 'project-1',
    projectName: 'Fixture',
    status: 'claimed',
    commandVersion: CLOUD_COMMAND_VERSION,
    commandContractId: CLOUD_COMMAND_CONTRACT_ID,
    attempt: 1,
    commands: [
      {
        sequence: 0,
        commandId: 'command-read-project',
        type: 'timeline.read_project',
        params: {},
      },
      {
        sequence: 1,
        commandId: 'command-read-timeline',
        type: 'timeline.read_timeline',
        params: {},
      },
    ],
  }
}

function writeTask(): CloudBridgeTask {
  return {
    ...readOnlyTask(),
    id: 'task-write',
    commands: [
      {
        sequence: 0,
        commandId: 'command-add-text',
        type: 'timeline.add_text',
        params: {
          text: 'Keyword',
          atSeconds: 1,
          durationSeconds: 2,
        },
      },
    ],
  }
}

describe('FreeCut Bridge Runner receipt projection', () => {
  it('forwards the standard receipt fields without tool result content', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: 'private tool message' }],
      isError: false,
      structuredContent: {
        ok: true,
        message: 'private tool message',
        data: { transcript: 'must stay local' },
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
          { phase: 'commit', status: 'succeeded' },
          { phase: 'postReadback', status: 'succeeded' },
          { phase: 'reconciliation', status: 'succeeded' },
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
    }

    const receipt = selectCloudBridgeReceipt(result)

    expect(receipt).toMatchObject({
      requestId: 'request-1',
      operationId: 'operation-1',
      changed: true,
      projectRevision: 'revision-2',
      changeSummary: 'Added one text item.',
      finalStatus: 'succeeded',
      operationManifest: {
        idempotencyKey: 'operation-1',
        impactFlags: ['semantic', 'motion'],
      },
      phaseReceipts: [
        { phase: 'transport', status: 'succeeded' },
        { phase: 'commit', status: 'succeeded' },
        { phase: 'postReadback', status: 'succeeded' },
        { phase: 'reconciliation', status: 'succeeded' },
      ],
      impactFlags: ['semantic', 'motion'],
      reconciliationStatus: 'VERIFIED_APPLIED',
      reconciliation: { status: 'applied' },
      beforeSnapshotId: 'snapshot-before',
      afterSnapshotId: 'snapshot-after',
      beforeFingerprint: 'fnv1a64:before',
      afterFingerprint: 'fnv1a64:after',
      postReadback: {
        status: 'verified',
        snapshotId: 'snapshot-after',
      },
    })
    expect(receipt).not.toHaveProperty('message')
    expect(receipt).not.toHaveProperty('data')
  })
})

describe('FreeCut Bridge Runner cloud task persistence', () => {
  it('does not rotate the web snapshot before checking the command precondition', async () => {
    Object.defineProperty(window, 'freecutDesktop', {
      configurable: true,
      value: undefined,
    })
    const task = readOnlyTask()
    task.commands = [
      {
        ...task.commands[0]!,
        expectedBeforeSnapshotId: 'snapshot-1',
      },
    ]
    const controller = new AbortController()

    await executeCloudTask(
      { baseUrl: 'https://mcp.example.test', businessKey: 'test-key' },
      'device-1',
      'project-1',
      task,
      controller.signal,
    )

    expect(captureCloudSnapshot).not.toHaveBeenCalled()
    expect(acknowledgeCloudBridgeTask).toHaveBeenCalledWith(
      { baseUrl: 'https://mcp.example.test', businessKey: 'test-key' },
      expect.objectContaining({
        taskId: 'task-read-only',
        attempt: 1,
        results: [
          expect.objectContaining({
            commandId: 'command-read-project',
            status: 'succeeded',
            beforeSnapshotId: 'snapshot-1',
            afterSnapshotId: 'snapshot-after',
          }),
        ],
      }),
      controller.signal,
    )
  })

  it('acknowledges a read-only task without saving the timeline', async () => {
    const saveTimeline = vi
      .spyOn(useTimelineStore.getState(), 'saveTimeline')
      .mockResolvedValue(undefined)
    const controller = new AbortController()

    await executeCloudTask(
      { baseUrl: 'https://mcp.example.test', businessKey: 'test-key' },
      'device-1',
      'project-1',
      readOnlyTask(),
      controller.signal,
    )

    expect(saveTimeline).not.toHaveBeenCalled()
    expect(acknowledgeCloudBridgeTask).toHaveBeenCalledOnce()
    expect(acknowledgeCloudBridgeTask).toHaveBeenCalledWith(
      { baseUrl: 'https://mcp.example.test', businessKey: 'test-key' },
      expect.objectContaining({
        deviceId: 'device-1',
        taskId: 'task-read-only',
        attempt: 1,
        results: [
          expect.objectContaining({
            sequence: 0,
            commandId: 'command-read-project',
            status: 'succeeded',
          }),
          expect.objectContaining({
            sequence: 1,
            commandId: 'command-read-timeline',
            status: 'succeeded',
          }),
        ],
      }),
      controller.signal,
    )
  })

  it('still saves the timeline before acknowledging a write task', async () => {
    const saveTimeline = vi
      .spyOn(useTimelineStore.getState(), 'saveTimeline')
      .mockResolvedValue(undefined)
    const controller = new AbortController()

    await executeCloudTask(
      { baseUrl: 'https://mcp.example.test', businessKey: 'test-key' },
      'device-1',
      'project-1',
      writeTask(),
      controller.signal,
    )

    expect(saveTimeline).toHaveBeenCalledOnce()
    expect(saveTimeline).toHaveBeenCalledWith('project-1')
    expect(acknowledgeCloudBridgeTask).toHaveBeenCalledOnce()
  })
})
