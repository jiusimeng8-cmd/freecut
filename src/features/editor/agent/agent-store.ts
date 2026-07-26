import { create } from 'zustand'
import {
  assertLocalAgentConfigured,
  approveLocalAgentRun,
  cancelLocalAgentRun,
  readLocalAgentMessages,
  runLocalAgent,
  subscribeToLocalAgentEvents,
  type LocalAgentEvent,
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
  /** What the run is doing right now, from the Main-side event stream. */
  activity: string | null

  prepareAgent: () => Promise<void>
  loadProjectConversation: (projectId: string) => Promise<void>
  resetConnection: () => void
  submit: (text: string) => Promise<void>
  approve: () => Promise<void>
  cancel: () => void
  clearChat: () => void
}

let activeRunId: string | null = null

type SetAgentState = (partial: Partial<AgentState>) => void

function newId(): string {
  return crypto.randomUUID()
}

/**
 * Turns a durable event into one line of Chinese status text.
 *
 * Events with no useful progress meaning return null so the last real activity
 * stays on screen — a line that blanks and reappears reads worse than one that
 * simply lags.
 */
function activityText(event: LocalAgentEvent): string | null {
  switch (event.eventType) {
    case 'localAgentHostStarted':
      return '正在准备本地工具…'
    case 'toolReceipt':
      return event.toolName ? `已完成 ${event.toolName}` : '已完成一次工具调用'
    case 'approvalRequested':
      return event.toolName ? `等待审批：${event.toolName}` : '等待审批'
    case 'approvalGranted':
      return event.toolName ? `正在执行 ${event.toolName}…` : '正在执行已审批的操作…'
    case 'localAgentWriteCompleted':
      return '正在根据执行结果继续…'
    case 'directorFinal':
    case 'directorFailed':
    case 'directorCancelled':
    case 'localAgentCancelled':
      return null
    default:
      return null
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : '本地 Agent 发生未知错误。'
}

/**
 * Mirrors one run's progress into `activity`. Returns an unsubscribe.
 *
 * Subscribed per run rather than once at module load: the line only means
 * anything while a run is in flight, and filtering on runId keeps a stale run's
 * late events from writing over the run the user is actually watching.
 */
function subscribeToRun(runId: string, set: SetAgentState): () => void {
  return subscribeToLocalAgentEvents((event) => {
    if (event.runId !== runId || activeRunId !== runId) return
    const text = activityText(event)
    if (text) set({ activity: text })
  })
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
  activity: null,

  loadProjectConversation: async (projectId) => {
    if (get().projectId === projectId) return
    activeRunId = null
    set({
      projectId,
      messages: [],
      phase: 'idle',
      localRun: null,
      activity: null,
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
      activity: null,
      loadError: null,
    }))

    const unsubscribe = subscribeToRun(runId, set)
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
        activity: null,
      })
    } catch (error) {
      if (activeRunId !== runId) return
      const message = `请求失败：${failureMessage(error)}`
      set((state) => ({
        messages: [...state.messages, { id: newId(), role: 'assistant', content: message }],
        phase: 'idle',
        activity: null,
        localRun: {
          runId,
          status: 'failed',
          errorCode: 'LOCAL_AGENT_IPC_FAILED',
        },
      }))
    } finally {
      unsubscribe()
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
      activity: null,
      localRun: runId
        ? { runId, status: 'cancelled' }
        : state.localRun,
    }))
  },

  approve: async () => {
    const runId = get().localRun?.runId
    if (!runId || get().phase !== 'waiting-approval') return
    // Reclaimed before the call: an approved write now resumes the loop instead
    // of ending the run, so the rounds that follow still belong to this run and
    // a later 停止 has to be able to reach them.
    activeRunId = runId
    set({ phase: 'approving', activity: null })
    const unsubscribe = subscribeToRun(runId, set)
    try {
      const result = await approveLocalAgentRun(runId)
      if (activeRunId !== runId) return
      const projectId = get().projectId
      const messages = projectId ? await readLocalAgentMessages(projectId) : get().messages
      if (activeRunId !== runId) return
      const statusMessage = resultMessage(result)
      set({
        messages:
          statusMessage && !messages.some((message) => message.content === statusMessage)
            ? [...messages, { id: newId(), role: 'assistant', content: statusMessage }]
            : messages,
        // A resumed run can stop at the next write, so the panel goes back to the
        // approval card rather than assuming one approval finished the task.
        phase: result.status === 'waiting_approval' ? 'waiting-approval' : 'idle',
        localRun: { ...result, runId: result.runId ?? runId },
        activity: null,
      })
    } catch (error) {
      if (activeRunId !== runId) return
      const message = `请求失败：${failureMessage(error)}`
      set((state) => ({
        messages: [...state.messages, { id: newId(), role: 'assistant', content: message }],
        phase: 'idle',
        activity: null,
        localRun: { runId, status: 'failed', errorCode: 'LOCAL_AGENT_APPROVAL_FAILED' },
      }))
    } finally {
      unsubscribe()
      if (activeRunId === runId && get().phase !== 'waiting-approval') {
        activeRunId = null
      }
    }
  },

  clearChat: () => {
    activeRunId = null
    set({ messages: [], localRun: null, phase: 'idle', activity: null })
  },
}))
