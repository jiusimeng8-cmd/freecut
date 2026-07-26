import { beforeEach, describe, expect, it, vi } from 'vitest'

type LocalAgentEventListener = (event: {
  runId: string
  threadId: string
  eventType: string
  toolName?: string
  createdAt: number
}) => void

const mocks = vi.hoisted(() => ({
  assertLocalAgentConfigured: vi.fn(),
  approveLocalAgentRun: vi.fn(),
  cancelLocalAgentRun: vi.fn(),
  readLocalAgentMessages: vi.fn(),
  runLocalAgent: vi.fn(),
  subscribeToLocalAgentEvents: vi.fn(),
}))

vi.mock('./agent-service', () => mocks)

import { useAgentStore } from './agent-store'

/** Event listeners the store has subscribed and not yet torn down. */
let listeners: LocalAgentEventListener[] = []

beforeEach(() => {
  mocks.assertLocalAgentConfigured.mockReset()
  mocks.approveLocalAgentRun.mockReset()
  mocks.cancelLocalAgentRun.mockReset()
  mocks.readLocalAgentMessages.mockReset()
  mocks.runLocalAgent.mockReset()
  mocks.subscribeToLocalAgentEvents.mockReset()
  listeners = []
  mocks.subscribeToLocalAgentEvents.mockImplementation((listener: LocalAgentEventListener) => {
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((entry) => entry !== listener)
    }
  })
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
    activity: null,
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

  it('narrates run progress from the event stream and stops listening when the run ends', async () => {
    let resolveRun!: (result: { status: 'completed' }) => void
    mocks.runLocalAgent.mockImplementation(
      () =>
        new Promise<{ status: 'completed' }>((resolve) => {
          resolveRun = resolve
        }),
    )
    useAgentStore.setState({ projectId: 'project-1' })

    const submission = useAgentStore.getState().submit('读取时间线')
    await vi.waitFor(() => expect(useAgentStore.getState().phase).toBe('running'))
    const runId = useAgentStore.getState().localRun!.runId

    listeners.forEach((listener) =>
      listener({
        runId,
        threadId: 'project:project-1',
        eventType: 'toolReceipt',
        toolName: 'read_timeline',
        createdAt: 1,
      }),
    )
    expect(useAgentStore.getState().activity).toBe('已完成 read_timeline')

    // A different run's events must not overwrite the line the user is watching.
    listeners.forEach((listener) =>
      listener({
        runId: 'some-other-run',
        threadId: 'project:project-1',
        eventType: 'toolReceipt',
        toolName: 'read_history',
        createdAt: 2,
      }),
    )
    expect(useAgentStore.getState().activity).toBe('已完成 read_timeline')

    resolveRun({ status: 'completed' })
    await submission

    expect(useAgentStore.getState().activity).toBeNull()
    expect(listeners).toHaveLength(0)
  })

  it('keeps the run cancellable across an approval so a resumed loop can still be stopped', async () => {
    let resolveApproval!: (result: { status: 'completed'; runId: string }) => void
    mocks.approveLocalAgentRun.mockImplementation(
      () =>
        new Promise<{ status: 'completed'; runId: string }>((resolve) => {
          resolveApproval = resolve
        }),
    )
    useAgentStore.setState({
      projectId: 'project-1',
      phase: 'waiting-approval',
      localRun: {
        runId: 'run-1',
        status: 'waiting_approval',
        approval: { id: 'call-1', name: 'freecut.timeline.split' },
      },
    })

    const approval = useAgentStore.getState().approve()
    await vi.waitFor(() => expect(useAgentStore.getState().phase).toBe('approving'))

    listeners.forEach((listener) =>
      listener({
        runId: 'run-1',
        threadId: 'project:project-1',
        eventType: 'approvalGranted',
        toolName: 'freecut.timeline.split',
        createdAt: 1,
      }),
    )
    expect(useAgentStore.getState().activity).toBe('正在执行 freecut.timeline.split…')

    // Approval no longer ends the run — it resumes the loop — so 停止 has to reach
    // the rounds that follow, and the late result must not revive the panel.
    useAgentStore.getState().cancel()
    expect(mocks.cancelLocalAgentRun).toHaveBeenCalledWith('run-1')
    resolveApproval({ status: 'completed', runId: 'run-1' })
    await approval

    expect(useAgentStore.getState()).toMatchObject({
      phase: 'idle',
      activity: null,
      localRun: { runId: 'run-1', status: 'cancelled' },
    })
    expect(listeners).toHaveLength(0)
  })

  it('returns to the approval card when a resumed run stops at the next write', async () => {
    mocks.approveLocalAgentRun.mockResolvedValue({
      status: 'waiting_approval',
      runId: 'run-1',
      approval: { id: 'call-2', name: 'freecut.timeline.delete' },
    })
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

    expect(useAgentStore.getState()).toMatchObject({
      phase: 'waiting-approval',
      localRun: {
        runId: 'run-1',
        status: 'waiting_approval',
        approval: { name: 'freecut.timeline.delete' },
      },
    })
  })
})
