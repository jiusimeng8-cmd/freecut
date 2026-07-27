import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { AgentChatPanel } from './agent-chat-panel'
import { useCloudAgentConfigStore } from '../agent/cloud-agent-config-store'

const agentState = vi.hoisted(() => ({
  messages: [],
  phase: 'waiting-approval',
  modelStatus: 'ready',
  loadError: null,
  localRun: {
    runId: 'run-1',
    status: 'waiting_approval',
    approval: { id: 'call-1', name: 'freecut.timeline.split' },
  },
  activity: null,
  submit: vi.fn(),
  approve: vi.fn(),
  cancel: vi.fn(),
  clearChat: vi.fn(),
  loadProjectConversation: vi.fn(),
  resetConnection: vi.fn(),
}))

vi.mock('../agent', () => ({
  useAgentStore: (selector: (state: typeof agentState) => unknown) => selector(agentState),
}))

vi.mock('@/features/editor/deps/projects', () => ({
  useProjectStore: (selector: (state: { currentProject: null }) => unknown) =>
    selector({ currentProject: null }),
}))

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn()
  agentState.approve.mockReset()
  useCloudAgentConfigStore.setState({ autoApprove: false })
})

describe('AgentChatPanel auto approval', () => {
  it('approves a pending write when auto approval is enabled', async () => {
    useCloudAgentConfigStore.setState({ autoApprove: true })

    render(<AgentChatPanel />)

    await waitFor(() => expect(agentState.approve).toHaveBeenCalledTimes(1))
  })

  it('keeps a pending write for manual approval when auto approval is disabled', () => {
    render(<AgentChatPanel />)

    expect(agentState.approve).not.toHaveBeenCalled()
  })
})
