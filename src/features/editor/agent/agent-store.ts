import { create } from 'zustand'
import {
  assertLocalAgentConfigured,
  approveLocalAgentRun,
  cancelLocalAgentRun,
  readLocalAgentMessages,
  runLocalAgent,
  type LocalAgentRunResult,
} from './agent-service'

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'
export type AgentPhase = 'idle' | 'running' | 'waiting-approval' | 'approving'
export type PlanStepStatus = 'pending' | 'running' | 'done' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/**
 * Kept as a public type until the agent feature barrel is narrowed. The new
 * local Host never creates or executes this browser-side plan.
 */
export interface PlanStepState {
  tool: string
  summary: string
  status: PlanStepStatus
  handoff?: boolean
  result?: string
}

export interface AgentRunState extends Omit<LocalAgentRunResult, 'status'> {
  runId: string
  status: LocalAgentRunResult['status'] | 'running'
}

interface AgentState {
  projectId: string | null
  modelStatus: ModelStatus
  loadError: string | null
  messages: ChatMessage[]
  phase: AgentPhase
  localRun: AgentRunState | null

  prepareAgent: () => Promise<void>
  loadProjectConversation: (projectId: string) => Promise<void>
  resetConnection: () => void
  submit: (text: string) => Promise<void>
  approve: () => Promise<void>
  cancel: () => void
  clearChat: () => void
}

let activeRunId: string | null = null

function newId(): string {
  return crypto.randomUUID()
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : '本地 Agent 发生未知错误。'
}

function resultMessage(result: LocalAgentRunResult): string {
  switch (result.status) {
    case 'failed':
      return result.assistantText ?? `请求失败：${result.errorCode ?? 'LOCAL_AGENT_FAILED'}`
    case 'cancelled':
      return '请求已取消。'
    case 'uncertain':
      return '执行状态不确定，时间线可能已被修改，请先检查当前项目。'
    case 'lease_held':
      return '当前时间线正由另一项本地 Agent 任务处理。'
    default:
      return ''
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  projectId: null,
  modelStatus: 'idle',
  loadError: null,
  messages: [],
  phase: 'idle',
  localRun: null,

  loadProjectConversation: async (projectId) => {
    if (get().projectId === projectId) return
    activeRunId = null
    set({
      projectId,
      messages: [],
      phase: 'idle',
      localRun: null,
      loadError: null,
    })

    const messages = await readLocalAgentMessages(projectId)
    if (get().projectId === projectId) {
      set({ messages })
    }
  },

  prepareAgent: async () => {
    set({ modelStatus: 'loading', loadError: null })
    try {
      assertLocalAgentConfigured()
      set({ modelStatus: 'ready' })
    } catch (error) {
      const message = failureMessage(error)
      set({ modelStatus: 'error', loadError: message })
      throw error
    }
  },

  resetConnection: () => set({ modelStatus: 'idle', loadError: null }),

  submit: async (text) => {
    const trimmed = text.trim()
    if (!trimmed || get().phase !== 'idle') return

    try {
      await get().prepareAgent()
    } catch {
      return
    }

    const projectId = get().projectId
    const runId = newId()
    activeRunId = runId
    set((state) => ({
      messages: [...state.messages, { id: newId(), role: 'user', content: trimmed }],
      phase: 'running',
      localRun: { runId, status: 'running' },
      loadError: null,
    }))

    try {
      const result = await runLocalAgent(trimmed, { projectId, runId })
      if (activeRunId !== runId) return

      const localRun: AgentRunState = { ...result, runId: result.runId ?? runId }
      const statusMessage = resultMessage(result)
      const messages = projectId ? await readLocalAgentMessages(projectId) : get().messages
      if (activeRunId !== runId) return

      set({
        messages:
          statusMessage && !messages.some((message) => message.content === statusMessage)
            ? [...messages, { id: newId(), role: 'assistant', content: statusMessage }]
            : messages,
        phase: result.status === 'waiting_approval' ? 'waiting-approval' : 'idle',
        localRun,
      })
    } catch (error) {
      if (activeRunId !== runId) return
      const message = `请求失败：${failureMessage(error)}`
      set((state) => ({
        messages: [...state.messages, { id: newId(), role: 'assistant', content: message }],
        phase: 'idle',
        localRun: {
          runId,
          status: 'failed',
          errorCode: 'LOCAL_AGENT_IPC_FAILED',
        },
      }))
    } finally {
      if (activeRunId === runId && get().phase !== 'waiting-approval') {
        activeRunId = null
      }
    }
  },

  cancel: () => {
    const runId = activeRunId ?? get().localRun?.runId
    activeRunId = null
    if (runId) {
      void cancelLocalAgentRun(runId)
    }
    set((state) => ({
      phase: 'idle',
      localRun: runId
        ? { runId, status: 'cancelled' }
        : state.localRun,
    }))
  },

  approve: async () => {
    const runId = get().localRun?.runId
    if (!runId || get().phase !== 'waiting-approval') return
    set({ phase: 'approving' })
    try {
      const result = await approveLocalAgentRun(runId)
      const projectId = get().projectId
      const messages = projectId ? await readLocalAgentMessages(projectId) : get().messages
      const statusMessage = resultMessage(result)
      set({
        messages:
          statusMessage && !messages.some((message) => message.content === statusMessage)
            ? [...messages, { id: newId(), role: 'assistant', content: statusMessage }]
            : messages,
        phase: 'idle',
        localRun: { ...result, runId: result.runId ?? runId },
      })
    } catch (error) {
      const message = `请求失败：${failureMessage(error)}`
      set((state) => ({
        messages: [...state.messages, { id: newId(), role: 'assistant', content: message }],
        phase: 'idle',
        localRun: { runId, status: 'failed', errorCode: 'LOCAL_AGENT_APPROVAL_FAILED' },
      }))
    } finally {
      activeRunId = null
    }
  },

  clearChat: () => {
    activeRunId = null
    set({ messages: [], localRun: null, phase: 'idle' })
  },
}))
