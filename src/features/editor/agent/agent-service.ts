import { useProjectStore } from '@/features/editor/deps/projects'
import { isCloudMcpConfigured } from '@/shared/state/cloud-mcp-config-store'
import {
  getCurrentCloudSnapshotId,
  readCloudSnapshotComposite,
} from './cloud-bridge-snapshots'
import { getCloudAgentProfileId } from './cloud-agent-config-store'
import type { ChatMessage } from './agent-store'

export type LocalAgentRunStatus =
  | 'completed'
  | 'waiting_approval'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  | 'lease_held'

export interface LocalAgentApproval {
  id: string
  name: string
  arguments?: unknown
}

export interface LocalAgentRunResult {
  status: LocalAgentRunStatus
  runId?: string
  assistantText?: string
  errorCode?: string
  approval?: LocalAgentApproval
}

interface LocalAgentRecord {
  kind: string
  id: string
  threadId: string
  role?: 'user' | 'assistant' | 'system' | 'tool'
  body?: string
  sequence?: number
}

interface LocalAgentHostApi {
  run(input: {
    runId: string
    threadId: string
    workspaceId: string
    projectId: string
    timelineId: string
    profileId: string
    snapshotId: string
    fingerprint: string
    userMessage: string
  }): Promise<LocalAgentRunResult>
  approve(runId: string): Promise<LocalAgentRunResult>
  cancel(runId: string): Promise<boolean>
  listRecords(input: {
    threadId: string
    kinds: string[]
  }): Promise<{ records: LocalAgentRecord[] }>
}

type DesktopWithLocalAgentHost = NonNullable<Window['freecutDesktop']> & {
  localAgent?: LocalAgentHostApi
}

function localAgentThreadId(projectId: string): string {
  return `project:${projectId}`
}

function localAgentHost(): LocalAgentHostApi | undefined {
  return (window.freecutDesktop as DesktopWithLocalAgentHost | undefined)?.localAgent
}

export function assertLocalAgentConfigured(): void {
  if (!isCloudMcpConfigured()) {
    throw new Error('请先配置剪好 MCP Key。')
  }
  if (!localAgentHost()) {
    throw new Error('本地 Agent Host 未就绪，请从剪好桌面应用启动项目。')
  }
}

export async function readLocalAgentMessages(projectId: string): Promise<ChatMessage[]> {
  const host = localAgentHost()
  if (!host) return []

  const { records } = await host.listRecords({
    threadId: localAgentThreadId(projectId),
    kinds: ['turn'],
  })
  return records
    .filter(
      (record): record is LocalAgentRecord & {
        role: 'user' | 'assistant'
        body: string
        sequence: number
      } =>
        record.kind === 'turn' &&
        (record.role === 'user' || record.role === 'assistant') &&
        typeof record.body === 'string' &&
        typeof record.sequence === 'number',
    )
    .sort((left, right) => left.sequence - right.sequence)
    .map((record) => ({
      id: record.id,
      role: record.role,
      content: record.body,
    }))
}

export async function runLocalAgent(
  userText: string,
  options: {
    projectId?: string | null
    runId: string
  },
): Promise<LocalAgentRunResult> {
  assertLocalAgentConfigured()

  const project = useProjectStore.getState().currentProject
  const projectId = options.projectId ?? project?.id ?? null
  if (!projectId) {
    throw new Error('请先打开一个 FreeCut 项目。')
  }

  const snapshotId = getCurrentCloudSnapshotId(projectId)
  const snapshot = await readCloudSnapshotComposite(snapshotId)
  if (!snapshot) {
    throw new Error('无法创建本地时间线快照。')
  }

  const host = localAgentHost()
  if (!host) {
    throw new Error('本地 Agent Host 未就绪，请从剪好桌面应用启动项目。')
  }

  return host.run({
    runId: options.runId,
    threadId: localAgentThreadId(projectId),
    workspaceId: localAgentThreadId(projectId),
    projectId,
    timelineId: projectId,
    profileId: getCloudAgentProfileId(),
    snapshotId,
    fingerprint: snapshot.fingerprints.composite,
    userMessage: userText,
  })
}

export async function cancelLocalAgentRun(runId: string): Promise<void> {
  const host = localAgentHost()
  if (!host) return
  await host.cancel(runId)
}

export async function approveLocalAgentRun(runId: string): Promise<LocalAgentRunResult> {
  const host = localAgentHost()
  if (!host) {
    throw new Error('本地 Agent Host 未就绪，请从剪好桌面应用启动项目。')
  }
  return host.approve(runId)
}
