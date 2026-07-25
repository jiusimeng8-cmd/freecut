import type {
  AgentCleanupInput,
  AgentCleanupResult,
  AgentCloudMetadataInput,
  AgentCloudMetadataProjection,
  AgentCompleteRunInput,
  AgentContextPack,
  AgentContextPackInput,
  AgentLeaseAcquireInput,
  AgentLeaseAcquireResult,
  AgentLeaseAssertInput,
  AgentLeaseReleaseInput,
  AgentLeaseRenewInput,
  AgentPutRecordsInput,
  AgentPutRecordsResult,
  AgentRecordListInput,
  AgentRecordListResult,
  AgentRuntimeInfo,
  AgentRuntimeRecord,
  AgentSandboxStatus,
  AgentSandboxWriteInput,
  AgentStartRunInput,
  AgentStartRunResult,
  AgentTimelineLease,
} from './agent-runtime'

export type {
  AgentCleanupInput,
  AgentCleanupResult,
  AgentCloudMetadataInput,
  AgentCloudMetadataProjection,
  AgentCompleteRunInput,
  AgentContextPack,
  AgentContextPackInput,
  AgentLeaseAcquireInput,
  AgentLeaseAcquireResult,
  AgentLeaseAssertInput,
  AgentLeaseReleaseInput,
  AgentLeaseRenewInput,
  AgentPutRecordsInput,
  AgentPutRecordsResult,
  AgentRecordListInput,
  AgentRecordListResult,
  AgentRuntimeInfo,
  AgentRuntimeRecord,
  AgentRuntimeRecordKind,
  AgentSandboxStatus,
  AgentSandboxWriteInput,
  AgentStartRunInput,
  AgentStartRunResult,
  AgentTimelineLease,
} from './agent-runtime'

export const DESKTOP_CREDENTIAL_KEYS = {
  cloudBridgeBusinessKey: 'cloud-bridge.business-key',
  cloudBridgeDeviceId: 'cloud-bridge.device-id',
} as const

export const DESKTOP_CREDENTIAL_ORIGIN_KEYS = {
  cloudBridgeBusinessKey: 'cloud-bridge.origin',
} as const

export interface DesktopEntryDescriptor {
  name: string
  kind: 'file' | 'directory'
}

export interface DesktopFileDescriptor {
  token: string
  name: string
  size: number
  lastModified: number
  mimeType: string
}

export interface DesktopGeneratedFileResult {
  taskId: string
  handle: DesktopHandleDescriptor
  file: DesktopFileDescriptor
}

export interface DesktopHandleDescriptor {
  token: string
  path: string[]
  name: string
  kind: 'file' | 'directory'
}

export interface DesktopWorkspaceDescriptor {
  id: string
  name: string
}

export interface DesktopBridgeToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  _meta?: {
    'freecut/category'?: {
      id: string
      title: string
      group: string
    }
  }
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    requiresProject?: boolean
    handoffRequired?: boolean
  }
}

export interface DesktopBridgeCall {
  requestId: string
  name: string
  args: unknown
  projectId?: string
  allowDestructive: boolean
  allowHandoff: boolean
  createdAt: number
}

export interface DesktopBridgeRequest {
  requestId: string
  name: string
  args: unknown
  projectId?: string
  allowDestructive?: boolean
  timeoutMs?: number
}

export type DesktopBridgeFailureStatus = 'failed' | 'cancelled' | 'uncertain'

export type DesktopBridgeCallResponse =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: {
        code: string
        message: string
        finalStatus: DesktopBridgeFailureStatus
      }
    }

export interface DesktopBridgeConfirmationRequest {
  requestId: string
  name: string
  projectId?: string
  destructive: boolean
  handoff: boolean
}

export interface DesktopAsrTranscriptionInput {
  fileName: string
  mimeType: string
  handle?: DesktopHandleDescriptor
  bytes?: Uint8Array
}

export type DesktopTaskKind =
  | 'export'
  | 'ffmpeg'
  | 'tts'
  | 'transcription'
  | 'proxy'
  | 'analysis'
  | 'bridge'

export type DesktopTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export interface DesktopTaskSummary {
  id: string
  kind: DesktopTaskKind
  projectId?: string
  status: DesktopTaskStatus
  progress?: number
  createdAt: number
  updatedAt: number
  error?: string
  fileName?: string
  canResume: boolean
  canRetry: boolean
  canCancel: boolean
  remoteMayContinue: boolean
}

export interface DesktopTaskExecutionResult {
  taskId: string
  result: unknown
}

export interface DesktopCloudBridgeRequest {
  requestId: string
  baseUrl: string
  method?: 'GET' | 'POST'
  timeoutMs?: number
  path:
    | '/api/v1/agents/run'
    | '/api/v1/agent-runs'
    | '/api/v1/agent-turns'
    | `/api/v1/agent-runs/${string}`
    | `/api/v1/agent-runs/${string}/cancel`
    | '/api/bridge/poll'
    | '/api/bridge/ack'
  body: unknown
}

export interface DesktopLocalAgentRunInput {
  runId: string
  threadId: string
  workspaceId: string
  projectId: string
  timelineId: string
  profileId: string
  snapshotId: string
  fingerprint: string
  userMessage: string
}

export interface DesktopLocalAgentRunResult {
  status: 'completed' | 'waiting_approval' | 'failed' | 'cancelled' | 'uncertain' | 'lease_held'
  runId?: string
  assistantText?: string
  errorCode?: string
  approval?: {
    id: string
    name: string
    arguments?: unknown
  }
}

export interface DesktopLocalAgentRecordListInput {
  threadId: string
  kinds: Array<'turn'>
}

export interface DesktopLocalAgentRecord {
  kind: 'turn'
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  body: string
  sequence: number
}

export interface DesktopLocalAgentRecordListResult {
  records: DesktopLocalAgentRecord[]
}

export type DesktopUpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'installing'
  | 'error'

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase
  currentVersion: string
  availableVersion?: string
  delivery?: 'automatic' | 'external'
  progressPercent?: number
  bytesPerSecond?: number
  transferredBytes?: number
  totalBytes?: number
  error?: string
  updatedAt: number
}

export interface DesktopDiagnosticsSnapshot {
  generatedAt: string
  system: {
    appVersion: string
    platform: string
    architecture: string
    osVersion: string
    electron?: string
    chrome?: string
    node?: string
    ffmpeg: {
      ffmpeg: string
      ffprobe: string
    }
    gpuFeatureStatus: unknown
    gpuProbe?: unknown
    safeMode: boolean
  }
  tasks: Array<Record<string, unknown>>
  logs: {
    current: string | null
    rotated: string | null
    maxBytesPerFile: number
    redacted: true
  }
  crashes: {
    discovered: number
    included: []
    skipped: Array<{ name: string; size: number; reason: string }>
  }
}

export interface FreeCutDesktopApi {
  app: {
    isDesktop: true
    getVersion(): Promise<string>
    getPlatform(): Promise<'win32'>
  }
  dialog: {
    pickWorkspace(): Promise<DesktopHandleDescriptor | null>
    pickFiles(options?: {
      multiple?: boolean
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<DesktopHandleDescriptor[]>
    saveFile(options?: {
      suggestedName?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<DesktopHandleDescriptor | null>
  }
  fileSystem: {
    listEntries(handle: DesktopHandleDescriptor): Promise<DesktopEntryDescriptor[]>
    ensureDirectory(handle: DesktopHandleDescriptor): Promise<void>
    ensureFile(handle: DesktopHandleDescriptor): Promise<void>
    readFile(handle: DesktopHandleDescriptor): Promise<{
      bytes: Uint8Array
      name: string
      lastModified: number
      mimeType: string
    }>
    readRange(handle: DesktopHandleDescriptor, start: number, end: number): Promise<Uint8Array>
    writeFile(handle: DesktopHandleDescriptor, bytes: Uint8Array): Promise<void>
    openWritable(handle: DesktopHandleDescriptor, keepExistingData?: boolean): Promise<string>
    writeWritable(writerId: string, bytes: Uint8Array, position?: number): Promise<void>
    seekWritable(writerId: string, position: number): Promise<void>
    truncateWritable(writerId: string, size: number): Promise<void>
    closeWritable(writerId: string): Promise<void>
    abortWritable(writerId: string): Promise<void>
    removeEntry(parent: DesktopHandleDescriptor, name: string, recursive?: boolean): Promise<void>
    moveEntry(
      source: DesktopHandleDescriptor,
      destinationParent: DesktopHandleDescriptor,
      newName: string,
    ): Promise<void>
  }
  handles: {
    get(
      kind: 'workspace' | 'media' | 'project-folder',
      id: string,
    ): Promise<DesktopHandleDescriptor | null>
    list(kind: 'workspace' | 'media' | 'project-folder'): Promise<
      Array<{
        id: string
        handle: DesktopHandleDescriptor
        pickedAt: number
        lastSeenPath?: string
        lastSeenSize?: number
        lastSeenMtime?: number
        activeWorkspaceId?: string
      }>
    >
    save(input: {
      kind: 'workspace' | 'media' | 'project-folder'
      id: string
      handle: DesktopHandleDescriptor
      pickedAt: number
      lastSeenPath?: string
      lastSeenSize?: number
      lastSeenMtime?: number
      activeWorkspaceId?: string
    }): Promise<void>
    delete(kind: 'workspace' | 'media' | 'project-folder', id: string): Promise<void>
  }
  media: {
    stat(handle: DesktopHandleDescriptor): Promise<DesktopFileDescriptor>
    getFileUrl(handle: DesktopHandleDescriptor): Promise<string>
    openLocalPath(
      path: string,
      options?: { recursive?: boolean },
    ): Promise<DesktopHandleDescriptor[]>
  }
  bridge: {
    register(input: {
      clientId: string
      projectId: string | null
      tools: DesktopBridgeToolDescriptor[]
    }): Promise<void>
    unregister(clientId: string): Promise<void>
    start(clientId: string, requestId: string): Promise<boolean>
    complete(clientId: string, requestId: string, result: unknown): Promise<void>
    call(input: DesktopBridgeRequest): Promise<unknown>
    cancel(requestId: string): Promise<{
      requestId: string
      cancelled: boolean
      state: 'not-found' | 'queued' | 'running'
    }>
    confirm(input: DesktopBridgeConfirmationRequest): Promise<boolean>
    onCall(listener: (call: DesktopBridgeCall) => void): () => void
    onCancel(listener: (requestId: string) => void): () => void
  }
  cloudBridge: {
    request<T = unknown>(input: DesktopCloudBridgeRequest): Promise<T>
    cancel(requestId: string): Promise<boolean>
  }
  localAgent: {
    run(input: DesktopLocalAgentRunInput): Promise<DesktopLocalAgentRunResult>
    approve(runId: string): Promise<DesktopLocalAgentRunResult>
    cancel(runId: string): Promise<boolean>
    listRecords(input: DesktopLocalAgentRecordListInput): Promise<DesktopLocalAgentRecordListResult>
  }
  ffmpeg: {
    probe(handle: DesktopHandleDescriptor): Promise<unknown>
  }
  asr: {
    transcribe(input: DesktopAsrTranscriptionInput): Promise<DesktopTaskExecutionResult>
  }
  tasks: {
    list(): Promise<DesktopTaskSummary[]>
    resume(taskId: string): Promise<DesktopTaskExecutionResult>
    retry(taskId: string, input: DesktopAsrTranscriptionInput): Promise<DesktopTaskExecutionResult>
    cancel(taskId: string): Promise<DesktopTaskSummary>
  }
  tts: {
    listVoices(): Promise<Array<{ id: string; name: string; language?: string }>>
    synthesize(input: {
      text: string
      voiceId?: string
      rate?: number
      volume?: number
    }): Promise<DesktopGeneratedFileResult>
  }
  credentials: {
    get(key: string): Promise<string | null>
    has(key: string, baseUrl?: string): Promise<boolean>
    set(key: string, value: string, baseUrl?: string): Promise<void>
    delete(key: string): Promise<void>
  }
  agentRuntime: {
    getInfo(): Promise<AgentRuntimeInfo>
    listRecords(input?: AgentRecordListInput): Promise<AgentRecordListResult>
    putRecords(input: AgentPutRecordsInput): Promise<AgentPutRecordsResult>
    startRun(input: AgentStartRunInput): Promise<AgentStartRunResult>
    completeRun(input: AgentCompleteRunInput): Promise<AgentRuntimeRecord>
    buildContextPack(input: AgentContextPackInput): Promise<AgentContextPack>
    projectCloudMetadata(input: AgentCloudMetadataInput): Promise<AgentCloudMetadataProjection>
    acquireLease(input: AgentLeaseAcquireInput): Promise<AgentLeaseAcquireResult>
    renewLease(input: AgentLeaseRenewInput): Promise<AgentTimelineLease>
    releaseLease(input: AgentLeaseReleaseInput): Promise<boolean>
    assertLease(input: AgentLeaseAssertInput): Promise<AgentTimelineLease>
    writeSandbox(input: AgentSandboxWriteInput): Promise<number>
    sandboxStatus(runId: string): Promise<AgentSandboxStatus>
    cleanup(input: AgentCleanupInput): Promise<AgentCleanupResult>
  }
  updates: {
    getStatus(): Promise<DesktopUpdateStatus>
    check(): Promise<DesktopUpdateStatus>
    download(): Promise<DesktopUpdateStatus>
    install(): Promise<void>
    onStatus(listener: (status: DesktopUpdateStatus) => void): () => void
  }
  diagnostics: {
    log(input: { level: 'warn' | 'error'; message: string }): Promise<void>
    inspect(): Promise<DesktopDiagnosticsSnapshot>
    export(): Promise<string>
  }
}
