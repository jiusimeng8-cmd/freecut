/* eslint-disable react-refresh/only-export-components */

import { useEffect } from 'react'
import {
  acknowledgeCloudBridgeTask,
  getCloudBridgeDeviceId,
  pollCloudBridge,
  selectCloudBridgeReceipt,
  type CloudBridgeTask,
  type CloudBridgeCommandResult,
} from '@/features/editor/agent/cloud-bridge-client'
import {
  CLOUD_COMMAND_CONTRACT_ID,
  CLOUD_COMMAND_VERSION,
  listCloudCommandCapabilities,
} from '@/features/editor/agent/cloud-command-contract'
import {
  getCloudMcpConfig,
  isCloudMcpConfigured,
  useCloudMcpConfigStore,
} from '@/shared/state/cloud-mcp-config-store'
import {
  describeCloudCommand,
  executeCloudCommand,
  type CloudBridgeCommand,
} from '@/features/editor/agent/cloud-command-runner'
import {
  captureCloudSnapshot,
  getCurrentCloudSnapshotId,
} from '@/features/editor/agent/cloud-bridge-snapshots'
import { getCloudTaskProtocolError } from '@/features/editor/agent/cloud-task-protocol'
import { callMcpTool, listMcpTools, type McpCallResult } from '@/features/editor/agent/tools'
import { normalizeToolResult } from '@/features/editor/agent/tools/mcp'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineSettingsStore } from '@/features/editor/deps/timeline-contract'
import { useTimelineStore } from '@/features/editor/deps/timeline-contract'

const API_PREFIX = '/__freecut_dev_workspace/bridge'
let desktopBridgeGeneration = 0
interface BridgeCall {
  requestId: string
  name: string
  args: unknown
  projectId?: string
  allowDestructive: boolean
  allowHandoff: boolean
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timeout = window.setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error ?? response.statusText)
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return requireOk(
    await fetch(`${API_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    }),
  )
}

function bridgeFailure(requestId: string, code: string, message: string): McpCallResult {
  const structuredContent = normalizeToolResult(
    {
      ok: false,
      message,
      changed: false,
      error: { code, message },
    },
    { requestId },
  )
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    structuredContent,
  }
}

function getToolFailure(result: McpCallResult): { code: string; message: string } | null {
  if (!result.isError) {
    const structured = result.structuredContent
    if (
      !structured ||
      typeof structured !== 'object' ||
      !('ok' in structured) ||
      structured.ok !== false
    ) {
      return null
    }
  }

  const structured = result.structuredContent
  if (structured && typeof structured === 'object' && 'error' in structured) {
    const error = structured.error
    if (error && typeof error === 'object' && 'message' in error) {
      return {
        code: 'TOOL_EXECUTION_FAILED',
        message: String(error.message),
      }
    }
  }
  return {
    code: 'TOOL_EXECUTION_FAILED',
    message: result.content[0]?.text ?? '本地命令执行失败。',
  }
}

async function getClientVersion(): Promise<string> {
  return (await window.freecutDesktop?.app.getVersion()) ?? 'web'
}

async function acknowledgeWithRetry(
  config: ReturnType<typeof getCloudMcpConfig>,
  input: {
    deviceId: string
    taskId: string
    attempt: number
    results: CloudBridgeCommandResult[]
  },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await acknowledgeCloudBridgeTask(config, input, signal)
      return
    } catch (error) {
      if ((error as { code?: string }).code === 'BRIDGE_AUTH_FAILED') return
      await delay(1_000, signal)
    }
  }
}

async function cloudCommandRequestId(
  taskId: string,
  sequence: number,
  attempt: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${taskId}:${sequence}:${attempt}`),
  )
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
  return `cloud:${hex}`
}

async function executeCloudTaskCommand(
  projectId: string,
  taskId: string,
  attempt: number,
  command: CloudBridgeCommand,
  signal: AbortSignal,
): Promise<McpCallResult> {
  const desktop = window.freecutDesktop
  if (!desktop) return executeCloudCommand(projectId, command)

  const step = describeCloudCommand(command)
  const requestId = await cloudCommandRequestId(
    taskId,
    command.sequence,
    Math.max(1, command.attempt ?? attempt),
  )
  if (step.tool === 'timeline.restore_snapshot') {
    const confirmed = await desktop.bridge.confirm({
      requestId,
      name: step.tool,
      projectId,
      destructive: step.destructive,
      handoff: step.handoff,
    })
    if (!confirmed) {
      throw Object.assign(new Error('用户未批准恢复云端快照。'), {
        code: 'CONFIRMATION_DENIED',
      })
    }
    return executeCloudCommand(projectId, command)
  }

  const cancel = () => {
    void desktop.bridge.cancel(requestId)
  }
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return (await desktop.bridge.call({
      requestId,
      name: step.tool,
      args: step.args,
      projectId,
      allowDestructive: step.destructive,
    })) as McpCallResult
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function executeCloudTask(
  config: ReturnType<typeof getCloudMcpConfig>,
  deviceId: string,
  projectId: string,
  task: CloudBridgeTask,
  signal: AbortSignal,
): Promise<void> {
  const taskAttempt = Math.max(1, task.attempt ?? 1)
  const protocolError = getCloudTaskProtocolError(task, projectId)
  if (protocolError) {
    await acknowledgeWithRetry(
      config,
      {
        deviceId,
        taskId: task.id,
        attempt: taskAttempt,
        results: task.commands.map((command) => ({
          sequence: command.sequence,
          commandId: command.commandId ?? `${task.id}:${command.sequence}`,
          type: command.type,
          attempt: Math.max(1, command.attempt ?? taskAttempt),
          status: 'failed',
          errorCode: protocolError.code,
          errorMessage: protocolError.message,
          retryable: false,
        })),
      },
      signal,
    )
    return
  }

  const results: CloudBridgeCommandResult[] = []
  let failed = false

  for (const command of [...task.commands].sort((left, right) => left.sequence - right.sequence)) {
    if (signal.aborted) return
    const attempt = Math.max(1, command.attempt ?? taskAttempt)
    const commandId = command.commandId ?? `${task.id}:${command.sequence}`
    let beforeSnapshotId: string | undefined

    try {
      const usesDesktopBridge = Boolean(window.freecutDesktop)
      const currentSnapshotId = getCurrentCloudSnapshotId(projectId)
      if (
        command.expectedBeforeSnapshotId &&
        command.expectedBeforeSnapshotId !== currentSnapshotId
      ) {
        beforeSnapshotId = currentSnapshotId
        throw Object.assign(
          new Error(
            `命令要求从快照 ${command.expectedBeforeSnapshotId} 执行，当前快照为 ${currentSnapshotId}。`,
          ),
          { code: 'SNAPSHOT_CONFLICT' },
        )
      }
      beforeSnapshotId = usesDesktopBridge
        ? captureCloudSnapshot(projectId)
        : currentSnapshotId
      const result = await executeCloudTaskCommand(projectId, task.id, attempt, command, signal)
      const failure = getToolFailure(result)
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code })

      const afterSnapshotId = usesDesktopBridge
        ? captureCloudSnapshot(projectId)
        : getCurrentCloudSnapshotId(projectId)
      const receipt = selectCloudBridgeReceipt(result)
      results.push({
        ...receipt,
        sequence: command.sequence,
        commandId,
        type: command.type,
        attempt,
        status: 'succeeded',
        beforeSnapshotId:
          command.expectedBeforeSnapshotId ?? receipt.beforeSnapshotId ?? beforeSnapshotId,
        afterSnapshotId: receipt.afterSnapshotId ?? afterSnapshotId,
      })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'COMMAND_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      const afterSnapshotId = beforeSnapshotId
        ? window.freecutDesktop
          ? captureCloudSnapshot(projectId)
          : getCurrentCloudSnapshotId(projectId)
        : undefined
      results.push({
        sequence: command.sequence,
        commandId,
        type: command.type,
        attempt,
        status: 'failed',
        beforeSnapshotId,
        afterSnapshotId,
        errorCode: code,
        errorMessage: message,
        retryable: ![
          'CONFIRMATION_DENIED',
          'PROJECT_MISMATCH',
          'SNAPSHOT_CONFLICT',
          'UNSUPPORTED_COMMAND_CONTRACT',
          'UNSUPPORTED_COMMAND_VERSION',
        ].includes(code),
      })
      failed = true

      for (const remaining of task.commands.filter(
        (candidate) =>
          candidate.sequence > command.sequence &&
          !results.some((result) => result.sequence === candidate.sequence),
      )) {
        results.push({
          sequence: remaining.sequence,
          commandId: remaining.commandId ?? `${task.id}:${remaining.sequence}`,
          type: remaining.type,
          attempt: Math.max(1, remaining.attempt ?? taskAttempt),
          status: 'failed',
          errorCode: 'PREVIOUS_COMMAND_FAILED',
          errorMessage: '前一条时间线命令失败，后续命令未执行。',
          retryable: true,
        })
      }
      break
    }
  }

  const hasWriteCommand = task.commands.some((command) => {
    const capability = listCloudCommandCapabilities().find(
      (candidate) => candidate.type === command.type,
    )
    return capability?.readOnly === false
  })

  if (!failed && hasWriteCommand) {
    try {
      await useTimelineStore.getState().saveTimeline(projectId)
    } catch (error) {
      const last = results.at(-1)
      if (last) {
        last.status = 'failed'
        last.errorCode = 'SAVE_FAILED'
        last.errorMessage = error instanceof Error ? error.message : String(error)
        last.retryable = true
      }
    }
  }

  await acknowledgeWithRetry(
    config,
    {
      deviceId,
      taskId: task.id,
      attempt: taskAttempt,
      results: results.sort((left, right) => left.sequence - right.sequence),
    },
    signal,
  )
}

function CloudFreeCutBridgeRunner({
  projectId,
  projectName,
  isTimelineLoading,
}: {
  projectId: string | null
  projectName: string
  isTimelineLoading: boolean
}) {
  const baseUrl = useCloudMcpConfigStore((state) => state.baseUrl)
  const businessKey = useCloudMcpConfigStore((state) => state.businessKey)

  useEffect(() => {
    const config = { baseUrl, businessKey }
    if (!isCloudMcpConfigured(config) || !projectId || isTimelineLoading) return

    const controller = new AbortController()
    const { signal } = controller
    let stopped = false

    const run = async () => {
      const [deviceId, clientVersion] = await Promise.all([
        getCloudBridgeDeviceId(),
        getClientVersion(),
      ])

      while (!signal.aborted && !stopped) {
        try {
          const currentSnapshotId = getCurrentCloudSnapshotId(projectId)
          const payload = await pollCloudBridge(
            config,
            {
              deviceId,
              name: '帧剪客户端',
              platform: window.freecutDesktop?.app.isDesktop ? 'windows' : 'web',
              clientVersion,
              commandVersion: CLOUD_COMMAND_VERSION,
              commandContractId: CLOUD_COMMAND_CONTRACT_ID,
              commandCapabilities: listCloudCommandCapabilities(),
              currentProjectId: projectId,
              currentProjectName: projectName || undefined,
              currentSnapshotId,
            },
            signal,
          )

          if (payload.task) {
            await executeCloudTask(config, deviceId, projectId, payload.task, signal)
            await delay(100, signal)
          } else {
            await delay(2_000, signal)
          }
        } catch (error) {
          if (signal.aborted || (error as { code?: string }).code === 'BRIDGE_AUTH_FAILED') {
            return
          }
          await delay(3_000, signal)
        }
      }
    }

    void run()
    return () => {
      stopped = true
      controller.abort()
    }
  }, [baseUrl, businessKey, isTimelineLoading, projectId, projectName])

  return null
}

function LocalFreeCutBridgeRunner({
  projectId,
  isTimelineLoading,
}: {
  projectId: string | null
  isTimelineLoading: boolean
}) {
  useEffect(() => {
    const desktop = window.freecutDesktop
    if ((!desktop && !import.meta.env.DEV) || (projectId !== null && isTimelineLoading)) return
    const controller = new AbortController()
    const { signal } = controller
    const clientId = crypto.randomUUID()
    const tools = listMcpTools()
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]))

    const postResult = async (requestId: string, result: McpCallResult) => {
      while (!signal.aborted) {
        try {
          await postJson('/result', { clientId, requestId, result }, signal)
          return
        } catch {
          await delay(500, signal)
        }
      }
    }

    const executeCall = async (call: BridgeCall): Promise<McpCallResult> => {
      if (call.projectId && call.projectId !== projectId) {
        return bridgeFailure(
          call.requestId,
          'PROJECT_MISMATCH',
          projectId
            ? `Bridge call targets project ${call.projectId}, but ${projectId} is open.`
            : `Bridge call targets project ${call.projectId}, but no project is open.`,
        )
      }
      const descriptor = toolByName.get(call.name)
      if (!descriptor) {
        return bridgeFailure(
          call.requestId,
          'TOOL_NOT_FOUND',
          `Unknown FreeCut tool: ${call.name}`,
        )
      }
      if (descriptor.annotations.requiresProject) {
        if (!projectId) {
          return bridgeFailure(
            call.requestId,
            'PROJECT_REQUIRED',
            `Tool ${call.name} requires an open, fully loaded FreeCut project.`,
          )
        }
        if (!call.projectId) {
          return bridgeFailure(
            call.requestId,
            'PROJECT_ID_REQUIRED',
            `Tool ${call.name} requires the current projectId (${projectId}) on the Bridge call.`,
          )
        }
      }
      if (descriptor.annotations.destructiveHint && !call.allowDestructive) {
        return bridgeFailure(
          call.requestId,
          'CONFIRMATION_REQUIRED',
          `Tool ${call.name} is destructive and requires allowDestructive=true.`,
        )
      }
      if (descriptor.annotations.handoffRequired && !call.allowHandoff) {
        return bridgeFailure(
          call.requestId,
          'CONFIRMATION_REQUIRED',
          `Tool ${call.name} requires local user handoff confirmation.`,
        )
      }
      try {
        return await callMcpTool(call.name, call.args, { requestId: call.requestId })
      } catch (error) {
        return bridgeFailure(
          call.requestId,
          'TOOL_EXECUTION_FAILED',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    if (desktop) {
      const generation = ++desktopBridgeGeneration
      const cancelledCalls = new Set<string>()
      let queue = Promise.resolve()
      const unregisterCancelListener = desktop.bridge.onCancel((requestId) => {
        cancelledCalls.add(requestId)
      })
      const unregisterCallListener = desktop.bridge.onCall((call) => {
        queue = queue
          .then(async () => {
            if (signal.aborted || desktopBridgeGeneration !== generation) return
            if (cancelledCalls.delete(call.requestId)) return
            const started = await desktop.bridge.start(clientId, call.requestId)
            if (
              !started ||
              signal.aborted ||
              desktopBridgeGeneration !== generation ||
              cancelledCalls.delete(call.requestId)
            ) {
              return
            }
            const result = await executeCall(call)
            if (!signal.aborted && desktopBridgeGeneration === generation) {
              await desktop.bridge.complete(clientId, call.requestId, result)
            }
          })
          .catch(() => undefined)
      })
      const register = () => desktop.bridge.register({ clientId, projectId, tools })
      void register().catch(() => undefined)
      const heartbeat = window.setInterval(() => void register().catch(() => undefined), 15_000)

      return () => {
        controller.abort()
        window.clearInterval(heartbeat)
        unregisterCallListener()
        unregisterCancelListener()
        window.setTimeout(() => {
          if (desktopBridgeGeneration === generation) {
            void desktop.bridge.unregister(clientId)
          }
        }, 0)
      }
    }

    const executeCallWithHeartbeat = async (call: BridgeCall): Promise<McpCallResult> => {
      const heartbeat = window.setInterval(() => {
        void postJson('/register', { clientId, projectId, tools }, signal).catch(() => undefined)
      }, 15_000)
      try {
        return await executeCall(call)
      } finally {
        window.clearInterval(heartbeat)
      }
    }

    const run = async () => {
      while (!signal.aborted) {
        try {
          await postJson('/register', { clientId, projectId, tools }, signal)
        } catch {
          await delay(1_000, signal)
          continue
        }

        while (!signal.aborted) {
          try {
            const response = await fetch(
              `${API_PREFIX}/poll?clientId=${encodeURIComponent(clientId)}`,
              {
                cache: 'no-store',
                signal,
              },
            )
            if (response.status === 204) continue
            await requireOk(response)
            const call = (await response.json()) as BridgeCall
            await postResult(call.requestId, await executeCallWithHeartbeat(call))
          } catch {
            if (!signal.aborted) await delay(1_000, signal)
            break
          }
        }
      }
    }

    void run()
    return () => {
      controller.abort()
      void fetch(`${API_PREFIX}/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
        keepalive: true,
      }).catch(() => undefined)
    }
  }, [isTimelineLoading, projectId])

  return null
}

export function FreeCutBridgeRunner({ projectId }: { projectId: string | null }) {
  const isTimelineLoading = useTimelineSettingsStore((state) => state.isTimelineLoading)
  const projectName = useProjectStore((state) => state.currentProject?.name ?? '')

  return (
    <>
      <CloudFreeCutBridgeRunner
        projectId={projectId}
        projectName={projectName}
        isTimelineLoading={isTimelineLoading}
      />
      <LocalFreeCutBridgeRunner projectId={projectId} isTimelineLoading={isTimelineLoading} />
    </>
  )
}
