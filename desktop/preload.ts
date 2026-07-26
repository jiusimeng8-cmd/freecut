import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopBridgeCallResponse,
  DesktopBridgeCall,
  DesktopHandleDescriptor,
  DesktopLocalAgentEvent,
  DesktopUpdateStatus,
  FreeCutDesktopApi,
} from './desktop-types'
import { DESKTOP_IPC } from './ipc-channels'
import { createBridgeFailureResult } from './bridge/bridge-call-result'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api: FreeCutDesktopApi = {
  app: {
    isDesktop: true,
    getVersion: () => invoke(DESKTOP_IPC.appGetVersion),
    getPlatform: () => Promise.resolve('win32'),
  },
  dialog: {
    pickWorkspace: () => invoke(DESKTOP_IPC.dialogPickWorkspace),
    pickFiles: (options) => invoke(DESKTOP_IPC.dialogPickFiles, options),
    saveFile: (options) => invoke(DESKTOP_IPC.dialogSaveFile, options),
  },
  fileSystem: {
    listEntries: (handle) => invoke(DESKTOP_IPC.fileSystemListEntries, handle),
    ensureDirectory: (handle) => invoke(DESKTOP_IPC.fileSystemEnsureDirectory, handle),
    ensureFile: (handle) => invoke(DESKTOP_IPC.fileSystemEnsureFile, handle),
    readFile: (handle) => invoke(DESKTOP_IPC.fileSystemReadFile, handle),
    readRange: (handle, start, end) => invoke(DESKTOP_IPC.fileSystemReadRange, handle, start, end),
    writeFile: (handle, bytes) => invoke(DESKTOP_IPC.fileSystemWriteFile, handle, bytes),
    openWritable: (handle, keepExistingData) =>
      invoke(DESKTOP_IPC.fileSystemOpenWritable, handle, keepExistingData),
    writeWritable: (writerId, bytes, position) =>
      invoke(DESKTOP_IPC.fileSystemWriteWritable, writerId, bytes, position),
    seekWritable: (writerId, position) =>
      invoke(DESKTOP_IPC.fileSystemSeekWritable, writerId, position),
    truncateWritable: (writerId, size) =>
      invoke(DESKTOP_IPC.fileSystemTruncateWritable, writerId, size),
    closeWritable: (writerId) => invoke(DESKTOP_IPC.fileSystemCloseWritable, writerId),
    abortWritable: (writerId) => invoke(DESKTOP_IPC.fileSystemAbortWritable, writerId),
    removeEntry: (parent, name, recursive) =>
      invoke(DESKTOP_IPC.fileSystemRemoveEntry, parent, name, recursive),
    moveEntry: (source, destinationParent, newName) =>
      invoke(DESKTOP_IPC.fileSystemMoveEntry, source, destinationParent, newName),
  },
  handles: {
    get: (kind, id) => invoke(DESKTOP_IPC.handlesGet, kind, id),
    list: (kind) => invoke(DESKTOP_IPC.handlesList, kind),
    save: (input) => invoke(DESKTOP_IPC.handlesSave, input),
    delete: (kind, id) => invoke(DESKTOP_IPC.handlesDelete, kind, id),
  },
  media: {
    stat: (handle) => invoke(DESKTOP_IPC.mediaStat, handle),
    getFileUrl: (handle) => invoke(DESKTOP_IPC.mediaGetFileUrl, handle),
    openLocalPath: (path, options) => invoke(DESKTOP_IPC.mediaOpenLocalPath, path, options),
  },
  bridge: {
    register: (input) => invoke(DESKTOP_IPC.bridgeRegister, input),
    unregister: (clientId) => invoke(DESKTOP_IPC.bridgeUnregister, clientId),
    start: (clientId, requestId) => invoke(DESKTOP_IPC.bridgeStart, clientId, requestId),
    complete: (clientId, requestId, result) =>
      invoke(DESKTOP_IPC.bridgeComplete, clientId, requestId, result),
    call: async (input) => {
      try {
        const response = await invoke<DesktopBridgeCallResponse>(DESKTOP_IPC.bridgeCall, input)
        return response.ok ? response.result : createBridgeFailureResult(input, response.error)
      } catch (error) {
        return createBridgeFailureResult(input, {
          code: 'BRIDGE_IPC_FAILED',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    cancel: (requestId) => invoke(DESKTOP_IPC.bridgeCancelCall, requestId),
    confirm: (input) => invoke(DESKTOP_IPC.bridgeConfirm, input),
    onCall: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, call: DesktopBridgeCall) => listener(call)
      ipcRenderer.on(DESKTOP_IPC.bridgeCall, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC.bridgeCall, handler)
    },
    onCancel: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, requestId: string) => listener(requestId)
      ipcRenderer.on(DESKTOP_IPC.bridgeCancelCall, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC.bridgeCancelCall, handler)
    },
  },
  cloudBridge: {
    request: (input) => invoke(DESKTOP_IPC.cloudBridgeRequest, input),
    cancel: (requestId) => invoke(DESKTOP_IPC.cloudBridgeCancel, requestId),
  },
  localAgent: {
    run: (input) => invoke(DESKTOP_IPC.localAgentRun, input),
    approve: (runId) => invoke(DESKTOP_IPC.localAgentApprove, runId),
    cancel: (runId) => invoke(DESKTOP_IPC.localAgentCancel, runId),
    listRecords: (input) => invoke(DESKTOP_IPC.localAgentListRecords, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: DesktopLocalAgentEvent) =>
        listener(value)
      ipcRenderer.on(DESKTOP_IPC.localAgentEvent, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC.localAgentEvent, handler)
    },
  },
  ffmpeg: {
    probe: (handle) => invoke(DESKTOP_IPC.ffmpegProbe, handle),
  },
  asr: {
    transcribe: (input) => invoke(DESKTOP_IPC.asrTranscribe, input),
  },
  tasks: {
    list: () => invoke(DESKTOP_IPC.tasksList),
    resume: (taskId) => invoke(DESKTOP_IPC.tasksResume, taskId),
    retry: (taskId, input) => invoke(DESKTOP_IPC.tasksRetry, taskId, input),
    cancel: (taskId) => invoke(DESKTOP_IPC.tasksCancel, taskId),
  },
  tts: {
    listVoices: () => invoke(DESKTOP_IPC.ttsListVoices),
    synthesize: (input) => invoke(DESKTOP_IPC.ttsSynthesize, input),
  },
  credentials: {
    get: (key) => invoke(DESKTOP_IPC.credentialsGet, key),
    has: (key, baseUrl) => invoke(DESKTOP_IPC.credentialsHas, key, baseUrl),
    set: (key, value, baseUrl) => invoke(DESKTOP_IPC.credentialsSet, key, value, baseUrl),
    delete: (key) => invoke(DESKTOP_IPC.credentialsDelete, key),
  },
  agentRuntime: {
    getInfo: () => invoke(DESKTOP_IPC.agentRuntimeGetInfo),
    listRecords: (input = {}) => invoke(DESKTOP_IPC.agentRuntimeListRecords, input),
    putRecords: (input) => invoke(DESKTOP_IPC.agentRuntimePutRecords, input),
    startRun: (input) => invoke(DESKTOP_IPC.agentRuntimeStartRun, input),
    completeRun: (input) => invoke(DESKTOP_IPC.agentRuntimeCompleteRun, input),
    buildContextPack: (input) => invoke(DESKTOP_IPC.agentRuntimeBuildContextPack, input),
    projectCloudMetadata: (input) =>
      invoke(DESKTOP_IPC.agentRuntimeProjectCloudMetadata, input),
    acquireLease: (input) => invoke(DESKTOP_IPC.agentRuntimeAcquireLease, input),
    renewLease: (input) => invoke(DESKTOP_IPC.agentRuntimeRenewLease, input),
    releaseLease: (input) => invoke(DESKTOP_IPC.agentRuntimeReleaseLease, input),
    assertLease: (input) => invoke(DESKTOP_IPC.agentRuntimeAssertLease, input),
    writeSandbox: (input) => invoke(DESKTOP_IPC.agentRuntimeWriteSandbox, input),
    sandboxStatus: (runId) => invoke(DESKTOP_IPC.agentRuntimeSandboxStatus, runId),
    cleanup: (input) => invoke(DESKTOP_IPC.agentRuntimeCleanup, input),
  },
  updates: {
    getStatus: () => invoke(DESKTOP_IPC.updatesGetStatus),
    check: () => invoke(DESKTOP_IPC.updatesCheck),
    download: () => invoke(DESKTOP_IPC.updatesDownload),
    install: () => invoke(DESKTOP_IPC.updatesInstall),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) =>
        listener(status)
      ipcRenderer.on(DESKTOP_IPC.updatesStatus, handler)
      return () => ipcRenderer.removeListener(DESKTOP_IPC.updatesStatus, handler)
    },
  },
  diagnostics: {
    log: (input) => invoke(DESKTOP_IPC.diagnosticsLog, input),
    inspect: () => invoke(DESKTOP_IPC.diagnosticsInspect),
    export: () => invoke(DESKTOP_IPC.diagnosticsExport),
  },
}

contextBridge.exposeInMainWorld('freecutDesktop', api)

export type { DesktopHandleDescriptor }
