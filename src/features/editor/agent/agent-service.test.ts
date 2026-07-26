import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCloudAgentProfileId: vi.fn(),
  getCurrentCloudSnapshotId: vi.fn(),
  getProjectState: vi.fn(),
  isCloudMcpConfigured: vi.fn(),
  readCloudSnapshotComposite: vi.fn(),
}))

vi.mock('@/features/editor/deps/projects', () => ({
  useProjectStore: {
    getState: mocks.getProjectState,
  },
}))
vi.mock('./cloud-agent-config-store', () => ({
  getCloudAgentProfileId: mocks.getCloudAgentProfileId,
}))
vi.mock('@/shared/state/cloud-mcp-config-store', () => ({
  isCloudMcpConfigured: mocks.isCloudMcpConfigured,
}))
vi.mock('./cloud-bridge-snapshots', () => ({
  getCurrentCloudSnapshotId: mocks.getCurrentCloudSnapshotId,
  readCloudSnapshotComposite: mocks.readCloudSnapshotComposite,
}))

import {
  approveLocalAgentRun,
  assertLocalAgentConfigured,
  readLocalAgentMessages,
  runLocalAgent,
} from './agent-service'

const originalDesktop = window.freecutDesktop

function setLocalAgent(agent: unknown) {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: {
      localAgent: agent,
    },
  })
}

beforeEach(() => {
  mocks.getCloudAgentProfileId.mockReset()
  mocks.getCurrentCloudSnapshotId.mockReset()
  mocks.getProjectState.mockReset()
  mocks.isCloudMcpConfigured.mockReset()
  mocks.readCloudSnapshotComposite.mockReset()

  mocks.getCloudAgentProfileId.mockReturnValue('editing-director')
  mocks.getCurrentCloudSnapshotId.mockReturnValue('local:project-1:snapshot-1')
  mocks.getProjectState.mockReturnValue({
    currentProject: {
      id: 'project-1',
      name: 'Test project',
    },
  })
  mocks.isCloudMcpConfigured.mockReturnValue(true)
  mocks.readCloudSnapshotComposite.mockResolvedValue({
    fingerprints: { composite: 'fnv1a64:timeline-1' },
  })
})

afterEach(() => {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: originalDesktop,
  })
})

describe('Local Agent Host client', () => {
  it('starts a local run with a renderer snapshot and the configured profile', async () => {
    const run = vi.fn().mockResolvedValue({
      status: 'completed',
      runId: 'run-1',
      assistantText: '已读取时间线。',
    })
    setLocalAgent({
      run,
      approve: vi.fn(),
      cancel: vi.fn(),
      listRecords: vi.fn(),
    })

    await expect(runLocalAgent('读取时间线', { runId: 'run-1' })).resolves.toMatchObject({
      status: 'completed',
      runId: 'run-1',
    })

    expect(run).toHaveBeenCalledWith({
      runId: 'run-1',
      threadId: 'project:project-1',
      workspaceId: 'project:project-1',
      projectId: 'project-1',
      timelineId: 'project-1',
      profileId: 'editing-director',
      snapshotId: 'local:project-1:snapshot-1',
      fingerprint: 'fnv1a64:timeline-1',
      userMessage: '读取时间线',
      // Grounding text the model can't get any other way — Main has no access to
      // the timeline stores, so a run that leaves this out is a blind one.
      timelineContext: expect.stringContaining('Project:'),
    })
  })

  it('reads only user and assistant turns from the local Thread Store', async () => {
    const listRecords = vi.fn().mockResolvedValue({
      records: [
        { kind: 'turn', id: 'tool-1', role: 'tool', body: '{}', sequence: 1 },
        { kind: 'turn', id: 'assistant-1', role: 'assistant', body: '完成', sequence: 2 },
        { kind: 'turn', id: 'user-1', role: 'user', body: '测试', sequence: 0 },
      ],
    })
    setLocalAgent({
      run: vi.fn(),
      approve: vi.fn(),
      cancel: vi.fn(),
      listRecords,
    })

    await expect(readLocalAgentMessages('project-1')).resolves.toEqual([
      { id: 'user-1', role: 'user', content: '测试' },
      { id: 'assistant-1', role: 'assistant', content: '完成' },
    ])
    expect(listRecords).toHaveBeenCalledWith({
      threadId: 'project:project-1',
      kinds: ['turn'],
    })
  })

  it('rejects submission when the local Host is unavailable', () => {
    setLocalAgent(undefined)
    expect(() => assertLocalAgentConfigured()).toThrow('本地 Agent Host 未就绪')
  })

  it('approves a pending local run through the local Host', async () => {
    const approve = vi.fn().mockResolvedValue({
      status: 'completed',
      runId: 'run-1',
      assistantText: '已执行。',
    })
    setLocalAgent({
      run: vi.fn(),
      approve,
      cancel: vi.fn(),
      listRecords: vi.fn(),
    })

    await expect(approveLocalAgentRun('run-1')).resolves.toMatchObject({
      status: 'completed',
      runId: 'run-1',
    })
    expect(approve).toHaveBeenCalledWith('run-1')
  })
})
