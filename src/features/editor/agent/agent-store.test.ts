import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertLocalAgentConfigured: vi.fn(),
  approveLocalAgentRun: vi.fn(),
  cancelLocalAgentRun: vi.fn(),
  readLocalAgentMessages: vi.fn(),
  runLocalAgent: vi.fn(),
}))

vi.mock('./agent-service', () => mocks)

import { useAgentStore } from './agent-store'

beforeEach(() => {
  mocks.assertLocalAgentConfigured.mockReset()
  mocks.approveLocalAgentRun.mockReset()
  mocks.cancelLocalAgentRun.mockReset()
  mocks.readLocalAgentMessages.mockReset()
  mocks.runLocalAgent.mockReset()
  mocks.readLocalAgentMessages.mockResolvedValue([])
  mocks.runLocalAgent.mockResolvedValue({
    status: 'completed',
    assistantText: '已完成。',
  })
  mocks.approveLocalAgentRun.mockResolvedValue({
    status: 'completed',
    runId: 'run-1',
    assistantText: '已执行。',
  })
  useAgentStore.setState({
    projectId: null,
    modelStatus: 'idle',
    loadError: null,
    messages: [],
    phase: 'idle',
    localRun: null,
  })
})

describe('useAgentStore local Agent Host flow', () => {
  it('submits through the local Host and reloads the durable local conversation', async () => {
    mocks.readLocalAgentMessages.mockResolvedValue([
      { id: 'user-1', role: 'user', content: '读取时间线' },
      { id: 'assistant-1', role: 'assistant', content: '已读取时间线。' },
    ])
    useAgentStore.setState({ projectId: 'project-1' })

    await useAgentStore.getState().submit('读取时间线')

    expect(mocks.runLocalAgent).toHaveBeenCalledWith(
      '读取时间线',
      expect.objectContaining({ projectId: 'project-1', runId: expect.any(String) }),
    )
    expect(mocks.readLocalAgentMessages).toHaveBeenCalledWith('project-1')
    expect(useAgentStore.getState()).toMatchObject({
      phase: 'idle',
      localRun: { status: 'completed' },
      messages: [
        { id: 'user-1', role: 'user', content: '读取时间线' },
        { id: 'assistant-1', role: 'assistant', content: '已读取时间线。' },
      ],
    })
  })

  it('keeps a write request in the local approval state', async () => {
    mocks.runLocalAgent.mockResolvedValue({
      status: 'waiting_approval',
      runId: 'run-1',
      approval: { id: 'call-1', name: 'freecut.timeline.split' },
    })
    useAgentStore.setState({ projectId: 'project-1' })

    await useAgentStore.getState().submit('在播放头切开')

    expect(useAgentStore.getState()).toMatchObject({
      phase: 'waiting-approval',
      localRun: {
        runId: 'run-1',
        status: 'waiting_approval',
        approval: { name: 'freecut.timeline.split' },
      },
    })
  })

  it('keeps local failures explicit without falling back to a cloud task', async () => {
    mocks.runLocalAgent.mockResolvedValue({
      status: 'failed',
      runId: 'run-1',
      errorCode: 'LOCAL_DIRECTOR_TURN_FAILED',
      assistantText: '本地审批已过期，请重新提交该操作。',
    })
    useAgentStore.setState({ projectId: 'project-1' })

    await useAgentStore.getState().submit('测试')

    expect(useAgentStore.getState().phase).toBe('idle')
    expect(useAgentStore.getState().messages.at(-1)?.content).toBe(
      '本地审批已过期，请重新提交该操作。',
    )
    expect(mocks.runLocalAgent).toHaveBeenCalledTimes(1)
  })

  it('cancels the active local run by its run id', async () => {
    let resolveRun!: (result: { status: 'cancelled'; runId: string }) => void
    mocks.runLocalAgent.mockImplementation(
      () =>
        new Promise<{ status: 'cancelled'; runId: string }>((resolve) => {
          resolveRun = resolve
        }),
    )
    useAgentStore.setState({ projectId: 'project-1' })

    const submission = useAgentStore.getState().submit('测试')
    await vi.waitFor(() => expect(useAgentStore.getState().phase).toBe('running'))
    const runId = useAgentStore.getState().localRun?.runId
    useAgentStore.getState().cancel()
    resolveRun({ status: 'cancelled', runId: runId! })
    await submission

    expect(mocks.cancelLocalAgentRun).toHaveBeenCalledWith(runId)
    expect(useAgentStore.getState().phase).toBe('idle')
    expect(useAgentStore.getState().localRun).toMatchObject({
      runId,
      status: 'cancelled',
    })
  })

  it('executes a locally approved write without creating a cloud task', async () => {
    mocks.readLocalAgentMessages.mockResolvedValue([
      { id: 'user-1', role: 'user', content: '切开片段' },
      { id: 'assistant-1', role: 'assistant', content: '已执行 freecut.timeline.split。' },
    ])
    useAgentStore.setState({
      projectId: 'project-1',
      phase: 'waiting-approval',
      localRun: {
        runId: 'run-1',
        status: 'waiting_approval',
        approval: { id: 'call-1', name: 'freecut.timeline.split' },
      },
    })

    await useAgentStore.getState().approve()

    expect(mocks.approveLocalAgentRun).toHaveBeenCalledWith('run-1')
    expect(useAgentStore.getState()).toMatchObject({
      phase: 'idle',
      localRun: { runId: 'run-1', status: 'completed' },
      messages: [
        { id: 'user-1', role: 'user', content: '切开片段' },
        { id: 'assistant-1', role: 'assistant', content: '已执行 freecut.timeline.split。' },
      ],
    })
  })

  it('loads conversations from the local Thread Store instead of localStorage', async () => {
    const messages = [{ id: 'message-1', role: 'user' as const, content: '剪掉静音' }]
    mocks.readLocalAgentMessages.mockResolvedValue(messages)

    await useAgentStore.getState().loadProjectConversation('project-a')

    expect(useAgentStore.getState().messages).toEqual(messages)
    expect(localStorage.getItem('freecut:agent-history:project-a')).toBeNull()
  })
})
