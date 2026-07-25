import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentRuntimeService, type LocalDirectorTurnResult } from './agent-runtime'
import type { AgentJsonValue } from './agent-runtime/agent-thread-types'
import { BridgeError, BridgeService, startBridgeHttpServer } from './bridge'
import { isTrustedE2eAuthorization } from './e2e-authorization'
import {
  type DesktopBridgeCallResponse,
  DESKTOP_CREDENTIAL_KEYS,
  DESKTOP_CREDENTIAL_ORIGIN_KEYS,
  type DesktopHandleDescriptor,
  type DesktopLocalAgentRecordListResult,
  type DesktopLocalAgentRunResult,
  type DesktopUpdateStatus,
} from './desktop-types'
import { DESKTOP_IPC } from './ipc-channels'
import {
  assertStructuredPayloadSize,
  parseAgentCleanupInput,
  parseAgentCloudMetadataInput,
  parseAgentCompleteRunInput,
  parseAgentContextPackInput,
  parseAgentLeaseAcquireInput,
  parseAgentLeaseAssertInput,
  parseAgentLeaseReleaseInput,
  parseAgentLeaseRenewInput,
  parseAgentPutRecordsInput,
  parseAgentRecordListInput,
  parseAgentSandboxWriteInput,
  parseAgentStartRunInput,
  parseAsrInput,
  parseBridgeConfirmation,
  parseBridgeRequest,
  parseBridgeRegistration,
  parseBytes,
  parseCloudBridgeRequest,
  parseEntryName,
  parseHandle,
  parseHandleKind,
  parseHandleStoreEntry,
  parseId,
  parseLocalAgentRecordListInput,
  parseLocalAgentRunInput,
  parseSafeInteger,
  parseTtsInput,
  parseWriterId,
} from './ipc-validation'
import {
  prepareWindowsPrivateDataDirectory,
  restrictWindowsFile,
  WindowsTtsService,
} from './platform/windows'
import { createMediaProtocolResponse } from './media-protocol-response'
import {
  CredentialStore,
  CloudBridgeService,
  DashScopeAsrService,
  DiagnosticsService,
  type DesktopReleaseNotification,
  FfmpegService,
  LocalAgentHostService,
  TaskRepository,
  TranscriptionTaskService,
  UpdateNotificationService,
  type AgentTurnRequest,
} from './services'
import { DesktopHandleStore, FileSystemService, PathRegistry } from './workspace'

const APP_SCHEME = 'freecut'
const APP_HOST = 'app'
const APP_URL = `${APP_SCHEME}://${APP_HOST}/projects`
const MEDIA_SCHEME = 'freecut-media'
const MEDIA_HOST = 'file'
const SAFE_MODE_SWITCH = 'freecut-safe-mode'
const SOFTWARE_GPU_SWITCH = 'freecut-software-gpu'
const SOFTWARE_GPU_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
const UPDATE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]
const MAX_CREDENTIAL_VALUE_LENGTH = 64 * 1024
const AGENT_TURN_TIMEOUT_MS = 120_000
const LOCAL_AGENT_LEASE_TTL_MS = 130_000
const LOCAL_AGENT_HOLDER_ID = `desktop-main-${process.pid}`
const MANAGEABLE_CREDENTIAL_KEYS = new Set<string>(Object.values(DESKTOP_CREDENTIAL_KEYS))
const READABLE_CREDENTIAL_KEYS = new Set<string>([DESKTOP_CREDENTIAL_KEYS.cloudBridgeDeviceId])
type DesktopUpdateMode = 'disabled' | 'automatic' | 'notification'

const isE2eMode = process.env.FREECUT_E2E === '1'
const e2eProjectId = isE2eMode ? process.env.FREECUT_E2E_PROJECT_ID?.trim() : undefined
const e2eRequestedUserDataPath = isE2eMode
  ? process.env.FREECUT_E2E_USER_DATA?.trim()
  : undefined
if (isE2eMode) {
  if (!e2eRequestedUserDataPath || !isAbsolute(e2eRequestedUserDataPath)) {
    throw new Error('FREECUT_E2E_USER_DATA must be an absolute path in E2E mode.')
  }
  if (!e2eProjectId || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(e2eProjectId)) {
    throw new Error('FREECUT_E2E_PROJECT_ID is invalid in E2E mode.')
  }
  app.setPath('userData', resolve(e2eRequestedUserDataPath))
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])
app.setName('FreeCut')
const isSafeMode = app.commandLine.hasSwitch(SAFE_MODE_SWITCH)
const softwareGpuStatePath = join(app.getPath('userData'), 'gpu-mode.json')
const persistedSoftwareGpuMode = (() => {
  try {
    const state = JSON.parse(readFileSync(softwareGpuStatePath, 'utf8')) as {
      mode?: unknown
      appVersion?: unknown
      updatedAt?: unknown
    }
    return (
      state.mode === 'software' &&
      state.appVersion === app.getVersion() &&
      typeof state.updatedAt === 'number' &&
      Date.now() - state.updatedAt < SOFTWARE_GPU_STATE_MAX_AGE_MS
    )
  } catch {
    return false
  }
})()
const isSoftwareGpuMode =
  !isSafeMode && (app.commandLine.hasSwitch(SOFTWARE_GPU_SWITCH) || persistedSoftwareGpuMode)
if (isSafeMode) {
  app.disableHardwareAcceleration()
} else if (isSoftwareGpuMode) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader')
}

if (process.platform !== 'win32') {
  dialog.showErrorBox('FreeCut', 'This build of FreeCut Desktop supports Windows only.')
  app.quit()
}

const hasSingleInstanceLock = isE2eMode || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let rendererCrashCount = 0
let lastRendererCrashAt = 0
let rendererRecoveryDialogOpen = false
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null
let desktopUpdateStatus: DesktopUpdateStatus = {
  phase: app.isPackaged ? 'idle' : 'disabled',
  currentVersion: app.getVersion(),
  updatedAt: Date.now(),
}

function setDesktopUpdateStatus(
  status: Omit<DesktopUpdateStatus, 'currentVersion' | 'updatedAt'>,
): DesktopUpdateStatus {
  desktopUpdateStatus = {
    ...status,
    currentVersion: app.getVersion(),
    updatedAt: Date.now(),
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_IPC.updatesStatus, desktopUpdateStatus)
  }
  return desktopUpdateStatus
}

function updateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPathInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function contentHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self' blob: data:",
      "base-uri 'none'",
      "object-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: freecut-media: http: https:",
      "connect-src 'self' blob: freecut-media: http: https: ws: wss:",
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "form-action 'self'",
    ].join('; '),
  )
  headers.set('Cache-Control', 'no-cache')
  return headers
}

async function registerAppProtocol(): Promise<void> {
  const webRoot = resolve(app.getAppPath(), 'dist')
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== APP_HOST || request.method !== 'GET') {
      return new Response('Not found', { status: 404 })
    }

    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const requested = resolve(webRoot, pathname.replace(/^[/\\]+/, ''))
    if (!isPathInside(webRoot, requested)) {
      return new Response('Forbidden', { status: 403 })
    }

    const requestedStat = await stat(requested).catch(() => null)
    const assetPath =
      requestedStat?.isFile() === true
        ? requested
        : extname(pathname)
          ? null
          : join(webRoot, 'index.html')
    if (!assetPath) {
      return new Response('Not found', { status: 404 })
    }
    const response = await net.fetch(pathToFileURL(assetPath).toString())
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: contentHeaders(response),
    })
  })
}

async function registerMediaProtocol(registry: PathRegistry): Promise<void> {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== MEDIA_HOST || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not found', { status: 404 })
    }

    let parts: string[]
    try {
      parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const [token, ...path] = parts
    if (!token) return new Response('Bad request', { status: 400 })

    const filePath = registry.resolve({
      token,
      path,
      name: path.at(-1) ?? '',
      kind: 'file',
    })
    const metadata = await stat(filePath).catch(() => null)
    if (!metadata?.isFile()) return new Response('Not found', { status: 404 })

    return createMediaProtocolResponse(request, filePath, metadata)
  })
}

function mediaFileUrl(handle: DesktopHandleDescriptor): string {
  const path = [handle.token, ...handle.path].map((part) => encodeURIComponent(part)).join('/')
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${path}`
}

function getDevelopmentUrl(): string | null {
  if (app.isPackaged) return null
  const configured = process.env.FREECUT_DESKTOP_DEV_URL?.trim()
  const url = new URL(configured || 'http://127.0.0.1:5173')
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  ) {
    throw new Error('FREECUT_DESKTOP_DEV_URL must use loopback HTTP.')
  }
  if (url.pathname === '/') url.pathname = '/projects'
  return url.toString()
}

function getDesktopPackageMetadata(): {
  releaseChannel: string
  updateMode: string
  updateManifestUrl: string
} {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as {
      freecutReleaseChannel?: unknown
      freecutUpdateMode?: unknown
      freecutUpdateManifestUrl?: unknown
    }
    return {
      releaseChannel:
        typeof packageJson.freecutReleaseChannel === 'string'
          ? packageJson.freecutReleaseChannel
          : 'unknown',
      updateMode:
        typeof packageJson.freecutUpdateMode === 'string'
          ? packageJson.freecutUpdateMode
          : 'automatic',
      updateManifestUrl:
        typeof packageJson.freecutUpdateManifestUrl === 'string'
          ? packageJson.freecutUpdateManifestUrl
          : '',
    }
  } catch {
    return {
      releaseChannel: 'unknown',
      updateMode: 'disabled',
      updateManifestUrl: '',
    }
  }
}

function trustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST) return true
    const developmentUrl = getDevelopmentUrl()
    return developmentUrl ? url.origin === new URL(developmentUrl).origin : false
  } catch {
    return false
  }
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  const senderFrame = event.senderFrame
  if (
    !window ||
    window !== mainWindow ||
    !senderFrame ||
    senderFrame !== event.sender.mainFrame ||
    !trustedRendererUrl(senderFrame.url)
  ) {
    throw new Error('Desktop IPC request came from an untrusted renderer.')
  }
  return window
}

function sanitizeFilters(
  filters: Array<{ name: string; extensions: string[] }> | undefined,
): Electron.FileFilter[] | undefined {
  if (!filters) return undefined
  const result = filters.slice(0, 20).flatMap((filter) => {
    const name = String(filter.name ?? '')
      .trim()
      .slice(0, 80)
    const extensions = Array.isArray(filter.extensions)
      ? filter.extensions
          .slice(0, 30)
          .map((extension) => String(extension).trim().replace(/^\./, ''))
          .filter((extension) => /^[a-z0-9][a-z0-9._+-]{0,31}$/i.test(extension))
      : []
    return name && extensions.length > 0 ? [{ name, extensions }] : []
  })
  return result.length > 0 ? result : undefined
}

function validateCredentialKey(key: string, allowed: ReadonlySet<string>): string {
  const normalized = typeof key === 'string' ? key.trim() : ''
  if (!allowed.has(normalized)) {
    throw new Error('Invalid credential key.')
  }
  return normalized
}

function credentialOriginKey(key: string): string | null {
  if (key === DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey) {
    return DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey
  }
  return null
}

function normalizeCredentialOrigin(value: string): string {
  const url = new URL(value.trim())
  const isLocalHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Credential-bound services must use HTTPS.')
  }
  return url.origin
}

function validateClientId(clientId: string): string {
  const normalized = clientId.trim()
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(normalized)) {
    throw new Error('Invalid Bridge clientId.')
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields.`)
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function isAgentJsonValue(value: unknown): value is AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isAgentJsonValue)
  return isRecord(value) && Object.values(value).every(isAgentJsonValue)
}

function parseAgentTurnResponse(
  value: unknown,
  request: AgentTurnRequest,
): LocalDirectorTurnResult {
  if (!isRecord(value)) throw new Error('Agent Turn response is invalid.')
  requireExactKeys(
    value,
    ['turnId', 'outcome', 'assistantText', 'toolCalls', 'usage', 'routing'],
    'Agent Turn response',
  )
  if (value.turnId !== request.turnId) throw new Error('Agent Turn response turnId does not match.')
  if (value.outcome !== 'tool_calls' && value.outcome !== 'final') {
    throw new Error('Agent Turn response outcome is invalid.')
  }
  const assistantText = requireString(value.assistantText, 'Agent Turn assistantText', 4_000)
  if (!Array.isArray(value.toolCalls) || value.toolCalls.length > 8) {
    throw new Error('Agent Turn response toolCalls are invalid.')
  }
  const toolNames = new Set(request.tools.map((tool) => tool.name))
  const toolCalls = value.toolCalls.map((rawCall) => {
    if (!isRecord(rawCall)) throw new Error('Agent Turn toolCall is invalid.')
    requireExactKeys(rawCall, ['id', 'name', 'arguments'], 'Agent Turn toolCall')
    const id = requireString(rawCall.id, 'Agent Turn toolCall id', 160)
    const name = requireString(rawCall.name, 'Agent Turn toolCall name', 160)
    if (!toolNames.has(name) || !isRecord(rawCall.arguments) || !isAgentJsonValue(rawCall.arguments)) {
      throw new Error('Agent Turn toolCall is invalid.')
    }
    return { id, name, arguments: rawCall.arguments }
  })
  if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
    throw new Error('Agent Turn response has duplicate tool call IDs.')
  }
  if (value.outcome === 'tool_calls' && toolCalls.length === 0) {
    throw new Error('Agent Turn response tool_calls is empty.')
  }
  if (value.outcome === 'final' && toolCalls.length > 0) {
    throw new Error('Agent Turn response final contains tool calls.')
  }

  if (!isRecord(value.usage)) throw new Error('Agent Turn usage is invalid.')
  requireExactKeys(value.usage, ['inputUnits', 'outputUnits', 'charged'], 'Agent Turn usage')
  if (
    !Number.isSafeInteger(value.usage.inputUnits) ||
    (value.usage.inputUnits as number) < 0 ||
    !Number.isSafeInteger(value.usage.outputUnits) ||
    (value.usage.outputUnits as number) < 0 ||
    typeof value.usage.charged !== 'boolean'
  ) {
    throw new Error('Agent Turn usage is invalid.')
  }
  if (!isRecord(value.routing)) throw new Error('Agent Turn routing is invalid.')
  requireExactKeys(
    value.routing,
    ['profileId', 'providerId', 'modelId', 'channelId', 'protocol'],
    'Agent Turn routing',
  )
  if (
    value.routing.profileId !== request.profileId ||
    !requireString(value.routing.providerId, 'Agent Turn routing providerId', 160) ||
    !requireString(value.routing.modelId, 'Agent Turn routing modelId', 512) ||
    !requireString(value.routing.channelId, 'Agent Turn routing channelId', 160) ||
    !requireString(value.routing.protocol, 'Agent Turn routing protocol', 128)
  ) {
    throw new Error('Agent Turn routing is invalid.')
  }

  if (value.outcome === 'final') {
    return { outcome: 'final', assistantText }
  }
  return { outcome: 'tool_calls', assistantText, toolCalls }
}

function installPermissionPolicy(): void {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
  let microphoneApproved = false
  let clipboardReadApproved = false
  let microphoneApproval: Promise<boolean> | null = null
  let clipboardReadApproval: Promise<boolean> | null = null
  const requestApproval = (
    kind: 'microphone' | 'clipboard',
    title: string,
    message: string,
  ): Promise<boolean> => {
    const current = kind === 'microphone' ? microphoneApproval : clipboardReadApproval
    if (current) return current
    const pending = (async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title,
        message,
        buttons: ['拒绝', '允许'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      const approved = result.response === 1
      if (kind === 'microphone') microphoneApproved = approved
      else clipboardReadApproved = approved
      return approved
    })()
    if (kind === 'microphone') microphoneApproval = pending
    else clipboardReadApproval = pending
    return pending
  }
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      webContents === mainWindow?.webContents &&
      details.isMainFrame &&
      trustedRendererUrl(requestingOrigin) &&
      (permission === 'media'
        ? details.mediaType === 'audio' && microphoneApproved
        : permission === 'clipboard-read'
          ? clipboardReadApproved
          : allowed.has(permission)),
  )
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
      const trusted =
        webContents === mainWindow?.webContents &&
        details.isMainFrame &&
        trustedRendererUrl(webContents.getURL())
      if (!trusted) {
        callback(false)
        return
      }
      if (permission === 'media') {
        if (mediaTypes?.length !== 1 || mediaTypes[0] !== 'audio') {
          callback(false)
          return
        }
        void requestApproval(
          'microphone',
          '允许帧剪使用麦克风？',
          '录制配音时，帧剪需要读取所选麦克风。',
        ).then(callback)
        return
      }
      if (permission === 'clipboard-read') {
        void requestApproval(
          'clipboard',
          '允许帧剪读取剪贴板？',
          '从剪贴板导入项目数据时，帧剪需要读取当前剪贴板文本。',
        ).then(callback)
        return
      }
      callback(allowed.has(permission))
    },
  )
}

function installNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (trustedRendererUrl(url)) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
  })
}

function relaunchInSafeMode(): void {
  const args = process.argv
    .slice(1)
    .filter(
      (argument) => argument !== `--${SAFE_MODE_SWITCH}` && argument !== `--${SOFTWARE_GPU_SWITCH}`,
    )
  args.push(`--${SAFE_MODE_SWITCH}`)
  app.relaunch({ args })
  const forceExit = setTimeout(() => process.exit(0), 1_000)
  forceExit.unref()
  app.quit()
}

async function relaunchInSoftwareGpuMode(): Promise<void> {
  await mkdir(dirname(softwareGpuStatePath), { recursive: true })
  await writeFile(
    softwareGpuStatePath,
    JSON.stringify(
      {
        mode: 'software',
        appVersion: app.getVersion(),
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
  )
  const args = process.argv
    .slice(1)
    .filter(
      (argument) => argument !== `--${SAFE_MODE_SWITCH}` && argument !== `--${SOFTWARE_GPU_SWITCH}`,
    )
  args.push(`--${SOFTWARE_GPU_SWITCH}`)
  app.relaunch({ args })
  const forceExit = setTimeout(() => process.exit(0), 1_000)
  forceExit.unref()
  app.quit()
  await new Promise<void>(() => undefined)
}

type RendererGpuProbeResult = {
  mode?: 'hardware' | 'software' | 'safe'
  navigatorGpu: boolean
  adapter: boolean
  device: boolean
  pixel: number[] | null
  adapterInfo: {
    vendor: string
    architecture: string
    device: string
    description: string
  } | null
  attempts?: number
  elapsedMs?: number
  error?: string
}

let rendererGpuProbe: RendererGpuProbeResult | null = null

async function probeRendererGpu(window: BrowserWindow): Promise<RendererGpuProbeResult> {
  const probe = window.webContents.executeJavaScript(`
    (async () => {
      const result = {
        navigatorGpu: Boolean(navigator.gpu),
        adapter: false,
        device: false,
        pixel: null,
        adapterInfo: null,
        attempts: 0,
        elapsedMs: 0,
        error: undefined,
      };
      const startedAt = performance.now();
      try {
        let adapter = null;
        while (navigator.gpu && performance.now() - startedAt < 2_000) {
          result.attempts += 1;
          adapter = await navigator.gpu.requestAdapter();
          if (adapter) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        result.adapter = Boolean(adapter);
        if (adapter) {
          result.adapterInfo = adapter.info
            ? {
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
              }
            : null;
          const device = await adapter.requestDevice();
          result.device = true;
          const buffer = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          device.queue.writeBuffer(buffer, 0, new Uint8Array([17, 34, 51, 68]));
          await buffer.mapAsync(GPUMapMode.READ);
          result.pixel = Array.from(new Uint8Array(buffer.getMappedRange()));
          buffer.unmap();
          buffer.destroy();
          device.destroy();
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      result.elapsedMs = Math.round(performance.now() - startedAt);
      return result;
    })()
  `)
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('GPU probe timed out.')), 5_000)
    timer.unref()
  })
  return Promise.race([probe, timeout]) as Promise<RendererGpuProbeResult>
}

async function ensureRendererGpu(
  window: BrowserWindow,
  log: (message: string) => void,
): Promise<void> {
  const result = await probeRendererGpu(window)
  const mode = isSoftwareGpuMode ? 'software' : isSafeMode ? 'safe' : 'hardware'
  rendererGpuProbe = { ...result, mode }
  const usable =
    result.navigatorGpu &&
    result.adapter &&
    result.device &&
    Array.isArray(result.pixel) &&
    result.pixel.length === 4
  log(
    `gpu probe mode=${mode} ` +
      `usable=${usable} navigatorGpu=${result.navigatorGpu} adapter=${result.adapter} ` +
      `device=${result.device} pixel=${result.pixel?.join(',') ?? ''} ` +
      `vendor=${result.adapterInfo?.vendor ?? ''} architecture=${result.adapterInfo?.architecture ?? ''} ` +
      `attempts=${result.attempts ?? 0} elapsedMs=${result.elapsedMs ?? 0} ` +
      `error=${result.error ?? ''}`,
  )
  if (usable) {
    if (!isSoftwareGpuMode && !isSafeMode) {
      await rm(softwareGpuStatePath, { force: true })
    }
    return
  }
  if (isSoftwareGpuMode || isSafeMode) return
  log('gpu probe failed: relaunching in software GPU mode')
  await relaunchInSoftwareGpuMode()
}

async function showRendererRecovery(
  window: BrowserWindow,
  log: (message: string) => void,
): Promise<void> {
  if (rendererRecoveryDialogOpen || window.isDestroyed() || isQuitting) return
  rendererRecoveryDialogOpen = true
  try {
    const buttons = isSafeMode
      ? ['重新加载', '打开日志目录', '退出帧剪']
      : ['安全模式重启', '重新加载', '打开日志目录', '退出帧剪']
    const response = await dialog.showMessageBox(window, {
      type: 'error',
      title: '帧剪编辑器连续崩溃',
      message: isSafeMode ? '编辑器在安全模式下仍然无法稳定运行。' : '编辑器已在短时间内连续崩溃。',
      detail: isSafeMode
        ? '你可以重新加载，或打开日志目录后退出。'
        : '建议以安全模式重启。安全模式会禁用硬件加速，项目文件不会被删除。',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    })
    if (window.isDestroyed() || isQuitting) return
    if (!isSafeMode && response.response === 0) {
      log('renderer recovery: relaunching in safe mode')
      relaunchInSafeMode()
      return
    }
    const reloadIndex = isSafeMode ? 0 : 1
    const logsIndex = isSafeMode ? 1 : 2
    if (response.response === reloadIndex) {
      rendererCrashCount = 0
      await window.loadURL(getDevelopmentUrl() ?? APP_URL)
      return
    }
    if (response.response === logsIndex) {
      await shell.openPath(app.getPath('logs'))
      return
    }
    app.quit()
  } finally {
    rendererRecoveryDialogOpen = false
  }
}

async function createWindow(
  preloadPath: string,
  log: (message: string) => void,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#111214',
    title: 'FreeCut',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  })
  mainWindow = window
  installNavigationPolicy(window)
  window.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
    const now = Date.now()
    rendererCrashCount = now - lastRendererCrashAt < 30_000 ? rendererCrashCount + 1 : 1
    lastRendererCrashAt = now
    if (!isQuitting && rendererCrashCount <= 2 && !window.isDestroyed()) {
      window.webContents.reload()
      return
    }
    void showRendererRecovery(window, log)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`renderer load failed: code=${code} url=${url} ${description}`)
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  const developmentUrl = getDevelopmentUrl()
  const initialUrl = e2eProjectId
    ? developmentUrl
      ? new URL(`/editor/${encodeURIComponent(e2eProjectId)}`, developmentUrl).toString()
      : `${APP_SCHEME}://${APP_HOST}/editor/${encodeURIComponent(e2eProjectId)}`
    : (developmentUrl ?? APP_URL)
  await window.loadURL(initialUrl)
  return window
}

function registerIpc(input: {
  fileSystem: FileSystemService
  handles: DesktopHandleStore
  bridge: BridgeService
  cloudBridge: CloudBridgeService
  ffmpeg: FfmpegService
  transcriptions: TranscriptionTaskService
  tts: WindowsTtsService
  credentials: CredentialStore
  diagnostics: DiagnosticsService
  tasks: TaskRepository
  agentRuntime: AgentRuntimeService
  localAgentHost: LocalAgentHostService
  updateMode: DesktopUpdateMode
  checkNotificationUpdate: () => Promise<DesktopUpdateStatus>
  openNotificationUpdate: () => Promise<void>
  log: (message: string) => void
}): void {
  let rendererLogWindowStartedAt = 0
  let rendererLogCount = 0
  const localAgentControllers = new Map<string, AbortController>()
  const handle = <T extends unknown[], R>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: T) => Promise<R> | R,
  ) => {
    ipcMain.handle(channel, (event, ...args: T) => {
      requireMainWindow(event)
      return listener(event, ...args)
    })
  }
  const resolveAsrInput = (rawValue: unknown) => {
    const value = parseAsrInput(rawValue)
    return {
      fileName: value.fileName,
      mimeType: value.mimeType,
      path: value.handle ? input.fileSystem.registry.resolve(value.handle) : undefined,
      bytes: value.handle ? undefined : value.bytes,
    }
  }

  handle(DESKTOP_IPC.appGetVersion, () => app.getVersion())
  handle(DESKTOP_IPC.dialogPickWorkspace, async (event) => {
    const result = await dialog.showOpenDialog(requireMainWindow(event), {
      title: 'Choose FreeCut workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled || !result.filePaths[0]
      ? null
      : input.fileSystem.registry.register(result.filePaths[0])
  })
  handle(
    DESKTOP_IPC.dialogPickFiles,
    async (
      event,
      options?: {
        multiple?: boolean
        filters?: Array<{ name: string; extensions: string[] }>
      },
    ) => {
      const properties: OpenDialogOptions['properties'] = ['openFile']
      if (options?.multiple) properties.push('multiSelections')
      const result = await dialog.showOpenDialog(requireMainWindow(event), {
        title: 'Choose media files',
        properties,
        filters: sanitizeFilters(options?.filters),
      })
      if (result.canceled) return []
      return Promise.all(result.filePaths.map((path) => input.fileSystem.registry.register(path)))
    },
  )
  handle(
    DESKTOP_IPC.dialogSaveFile,
    async (
      event,
      options?: {
        suggestedName?: string
        filters?: Array<{ name: string; extensions: string[] }>
      },
    ) => {
      const suggestedName = options?.suggestedName
        ? basename(options.suggestedName.replaceAll('\0', '')).slice(0, 180)
        : undefined
      const dialogOptions: SaveDialogOptions = {
        title: 'Save from FreeCut',
        defaultPath: suggestedName,
        filters: sanitizeFilters(options?.filters),
      }
      const result = await dialog.showSaveDialog(requireMainWindow(event), dialogOptions)
      if (result.canceled || !result.filePath) return null
      const file = await open(result.filePath, 'a')
      await file.close()
      return input.fileSystem.registry.register(result.filePath)
    },
  )

  handle(DESKTOP_IPC.fileSystemListEntries, (_event, descriptor: DesktopHandleDescriptor) =>
    input.fileSystem.listEntries(parseHandle(descriptor)),
  )
  handle(DESKTOP_IPC.fileSystemEnsureDirectory, (_event, descriptor: DesktopHandleDescriptor) =>
    input.fileSystem.ensureDirectory(parseHandle(descriptor)),
  )
  handle(DESKTOP_IPC.fileSystemEnsureFile, (_event, descriptor: DesktopHandleDescriptor) =>
    input.fileSystem.ensureFile(parseHandle(descriptor)),
  )
  handle(DESKTOP_IPC.fileSystemReadFile, (_event, descriptor: DesktopHandleDescriptor) =>
    input.fileSystem.readFile(parseHandle(descriptor)),
  )
  handle(
    DESKTOP_IPC.fileSystemReadRange,
    (_event, descriptor: DesktopHandleDescriptor, start: number, end: number) =>
      input.fileSystem.readRange(
        parseHandle(descriptor),
        parseSafeInteger(start, 'file range start'),
        parseSafeInteger(end, 'file range end'),
      ),
  )
  handle(
    DESKTOP_IPC.fileSystemWriteFile,
    (_event, descriptor: DesktopHandleDescriptor, bytes: Uint8Array) =>
      input.fileSystem.writeFile(parseHandle(descriptor), parseBytes(bytes, 'file write')),
  )
  handle(
    DESKTOP_IPC.fileSystemOpenWritable,
    (_event, descriptor: DesktopHandleDescriptor, keepExistingData?: boolean) => {
      if (keepExistingData !== undefined && typeof keepExistingData !== 'boolean') {
        throw new Error('Invalid keepExistingData value.')
      }
      return input.fileSystem.openWritable(parseHandle(descriptor), keepExistingData)
    },
  )
  handle(
    DESKTOP_IPC.fileSystemWriteWritable,
    (_event, writerId: string, bytes: Uint8Array, position?: number) =>
      input.fileSystem.writeWritable(
        parseWriterId(writerId),
        parseBytes(bytes, 'writable chunk'),
        position === undefined ? undefined : parseSafeInteger(position, 'writable position'),
      ),
  )
  handle(DESKTOP_IPC.fileSystemSeekWritable, (_event, writerId: string, position: number) =>
    input.fileSystem.seekWritable(
      parseWriterId(writerId),
      parseSafeInteger(position, 'writable position'),
    ),
  )
  handle(DESKTOP_IPC.fileSystemTruncateWritable, (_event, writerId: string, size: number) =>
    input.fileSystem.truncateWritable(
      parseWriterId(writerId),
      parseSafeInteger(size, 'writable size'),
    ),
  )
  handle(DESKTOP_IPC.fileSystemCloseWritable, (_event, writerId: string) =>
    input.fileSystem.closeWritable(parseWriterId(writerId)),
  )
  handle(DESKTOP_IPC.fileSystemAbortWritable, (_event, writerId: string) =>
    input.fileSystem.abortWritable(parseWriterId(writerId)),
  )
  handle(
    DESKTOP_IPC.fileSystemRemoveEntry,
    (_event, parent: DesktopHandleDescriptor, name: string, recursive?: boolean) => {
      if (recursive !== undefined && typeof recursive !== 'boolean') {
        throw new Error('Invalid recursive value.')
      }
      return input.fileSystem.removeEntry(parseHandle(parent), parseEntryName(name), recursive)
    },
  )
  handle(
    DESKTOP_IPC.fileSystemMoveEntry,
    (
      _event,
      source: DesktopHandleDescriptor,
      destinationParent: DesktopHandleDescriptor,
      newName: string,
    ) =>
      input.fileSystem.moveEntry(
        parseHandle(source),
        parseHandle(destinationParent),
        parseEntryName(newName),
      ),
  )

  handle(DESKTOP_IPC.handlesGet, (_event, kind: unknown, id: unknown) =>
    input.handles.get(parseHandleKind(kind), parseId(id, 'desktop handle id')),
  )
  handle(DESKTOP_IPC.handlesList, (_event, kind: unknown) =>
    input.handles.list(parseHandleKind(kind)),
  )
  handle(DESKTOP_IPC.handlesSave, (_event, value: unknown) =>
    input.handles.save(parseHandleStoreEntry(value)),
  )
  handle(DESKTOP_IPC.handlesDelete, (_event, kind: unknown, id: unknown) =>
    input.handles.delete(parseHandleKind(kind), parseId(id, 'desktop handle id')),
  )
  handle(DESKTOP_IPC.mediaStat, (_event, descriptor: DesktopHandleDescriptor) =>
    input.fileSystem.stat(parseHandle(descriptor)),
  )
  handle(DESKTOP_IPC.mediaGetFileUrl, async (_event, descriptor: DesktopHandleDescriptor) => {
    const handle = parseHandle(descriptor)
    const metadata = await input.fileSystem.stat(handle)
    if (metadata.mimeType === 'inode/directory') throw new Error('Handle is not a file.')
    return mediaFileUrl(handle)
  })
  handle(
    DESKTOP_IPC.mediaOpenLocalPath,
    async (event, path: string, options?: { recursive?: boolean }) => {
      if (typeof path !== 'string' || path.length > 32_768 || !isAbsolute(path)) {
        throw new Error('Local media path must be absolute.')
      }
      const requestedPath = resolve(path)
      await stat(requestedPath)
      if (!(await input.fileSystem.registry.isAuthorized(requestedPath))) {
        const confirmation = await dialog.showMessageBox(requireMainWindow(event), {
          type: 'warning',
          title: 'Allow local file access?',
          message: 'FreeCut wants to access this local path.',
          detail: requestedPath,
          buttons: ['Cancel', 'Allow for this session'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        if (confirmation.response !== 1) {
          throw new Error('Local path access was not approved.')
        }
      }
      return input.fileSystem.registerLocalFiles(requestedPath, options?.recursive === true)
    },
  )

  handle(DESKTOP_IPC.bridgeRegister, (_event, value: unknown) => {
    const registration = parseBridgeRegistration(value)
    assertStructuredPayloadSize(registration, 'Bridge registration')
    input.bridge.registerRenderer({
      clientId: validateClientId(registration.clientId),
      projectId: registration.projectId,
      tools: registration.tools,
    })
  })
  handle(DESKTOP_IPC.bridgeUnregister, (_event, clientId: string) =>
    input.bridge.unregisterRenderer(validateClientId(parseId(clientId, 'Bridge clientId'))),
  )
  handle(DESKTOP_IPC.bridgeStart, (_event, clientId: string, requestId: string) =>
    input.bridge.start(
      validateClientId(parseId(clientId, 'Bridge clientId')),
      parseId(requestId, 'Bridge requestId'),
    ),
  )
  handle(
    DESKTOP_IPC.bridgeComplete,
    (_event, clientId: string, requestId: string, result: unknown) => {
      assertStructuredPayloadSize(result, 'Bridge result')
      return input.bridge.complete(
        validateClientId(parseId(clientId, 'Bridge clientId')),
        parseId(requestId, 'Bridge requestId'),
        result,
      )
    },
  )
  handle(DESKTOP_IPC.bridgeCall, (_event, value: unknown) =>
    (async (): Promise<DesktopBridgeCallResponse> => {
      try {
        return {
          ok: true,
          result: await input.bridge.call(parseBridgeRequest(value)),
        }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof BridgeError ? error.code : 'BRIDGE_CALL_FAILED',
            message: error instanceof Error ? error.message : String(error),
            finalStatus: error instanceof BridgeError ? error.finalStatus : 'failed',
          },
        }
      }
    })(),
  )
  handle(DESKTOP_IPC.bridgeCancelCall, (_event, requestId: string) =>
    input.bridge.cancel(parseId(requestId, 'Bridge requestId')),
  )
  handle(DESKTOP_IPC.bridgeConfirm, (_event, value: unknown) => {
    const confirmation = parseBridgeConfirmation(value)
    return input.bridge.confirm({
      ...confirmation,
      projectId: confirmation.projectId ?? null,
    })
  })
  handle(DESKTOP_IPC.cloudBridgeRequest, (_event, value: unknown) =>
    input.cloudBridge.request(parseCloudBridgeRequest(value)),
  )
  handle(DESKTOP_IPC.cloudBridgeCancel, (_event, requestId: string) =>
    input.cloudBridge.cancel(parseId(requestId, 'cloud Bridge requestId')),
  )
  handle(DESKTOP_IPC.localAgentRun, async (_event, value: unknown) => {
    const run = parseLocalAgentRunInput(value)
    if (localAgentControllers.has(run.runId)) {
      throw new Error('Local Agent run is already active.')
    }
    const controller = new AbortController()
    localAgentControllers.set(run.runId, controller)
    try {
      const result = await input.localAgentHost.run({
        runId: run.runId,
        profileId: run.profileId,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        timelineId: run.timelineId,
        snapshotId: run.snapshotId,
        fingerprint: run.fingerprint,
        holderId: LOCAL_AGENT_HOLDER_ID,
        leaseTtlMs: LOCAL_AGENT_LEASE_TTL_MS,
        userMessage: run.userMessage,
        signal: controller.signal,
      })
      if (result.status === 'completed') {
        return {
          status: result.status,
          runId: result.run.id,
          assistantText: result.assistantText,
        } satisfies DesktopLocalAgentRunResult
      }
      if (result.status === 'waiting_approval') {
        return {
          status: result.status,
          runId: result.runId,
          approval: result.approval,
        } satisfies DesktopLocalAgentRunResult
      }
      if (result.status === 'lease_held') {
        return {
          status: result.status,
          runId: run.runId,
          errorCode: 'LOCAL_AGENT_LEASE_HELD',
        } satisfies DesktopLocalAgentRunResult
      }
      return {
        status: result.status,
        runId: result.run.id,
        errorCode: result.errorCode,
      } satisfies DesktopLocalAgentRunResult
    } finally {
      localAgentControllers.delete(run.runId)
    }
  })
  handle(DESKTOP_IPC.localAgentApprove, async (_event, runId: unknown) => {
    const result = await input.localAgentHost.approve({
      runId: parseId(runId, 'Local Agent runId'),
      holderId: LOCAL_AGENT_HOLDER_ID,
      leaseTtlMs: LOCAL_AGENT_LEASE_TTL_MS,
    })
    return {
      status: result.status,
      runId: result.run.id,
      assistantText: result.assistantText,
      errorCode: result.errorCode,
    } satisfies DesktopLocalAgentRunResult
  })
  handle(DESKTOP_IPC.localAgentCancel, async (_event, runId: unknown) => {
    const parsedRunId = parseId(runId, 'Local Agent runId')
    const controller = localAgentControllers.get(parsedRunId)
    if (controller) {
      controller.abort()
      return true
    }
    await input.localAgentHost.cancel({
      runId: parsedRunId,
      holderId: LOCAL_AGENT_HOLDER_ID,
    })
    return true
  })
  handle(DESKTOP_IPC.localAgentListRecords, async (_event, value: unknown) => {
    const query = parseLocalAgentRecordListInput(value)
    const result = await input.agentRuntime.listRecords({
      threadId: query.threadId,
      kinds: ['turn'],
      limit: Number.MAX_SAFE_INTEGER,
    })
    return {
      records: result.records
        .filter((record) => record.kind === 'turn')
        .map((record) => ({
          kind: record.kind,
          id: record.id,
          threadId: record.threadId,
          role: record.role,
          body: record.body,
          sequence: record.sequence,
        })),
    } satisfies DesktopLocalAgentRecordListResult
  })

  handle(DESKTOP_IPC.ffmpegProbe, (_event, descriptor: DesktopHandleDescriptor) =>
    input.ffmpeg.probe(input.fileSystem.registry.resolve(parseHandle(descriptor))),
  )
  handle(DESKTOP_IPC.asrTranscribe, (_event, rawValue: unknown) =>
    input.transcriptions.transcribe(resolveAsrInput(rawValue)),
  )
  handle(DESKTOP_IPC.tasksList, () => input.transcriptions.list())
  handle(DESKTOP_IPC.tasksResume, (_event, taskId: unknown) =>
    input.transcriptions.resume(parseId(taskId, 'desktop task ID')),
  )
  handle(DESKTOP_IPC.tasksRetry, (_event, taskId: unknown, rawValue: unknown) =>
    input.transcriptions.retry(parseId(taskId, 'desktop task ID'), resolveAsrInput(rawValue)),
  )
  handle(DESKTOP_IPC.tasksCancel, (_event, taskId: unknown) =>
    input.transcriptions.cancel(parseId(taskId, 'desktop task ID')),
  )
  handle(DESKTOP_IPC.ttsListVoices, () => input.tts.listVoices())
  handle(DESKTOP_IPC.ttsSynthesize, async (_event, value: unknown) => {
    const ttsInput = parseTtsInput(value)
    const task = await input.tasks.create({
      kind: 'tts',
      data: {
        textLength: ttsInput.text.length,
        voiceId: ttsInput.voiceId ?? null,
      },
    })
    await input.tasks.update(task.id, { status: 'running' })
    try {
      const outputPath = await input.tts.synthesize(ttsInput)
      const descriptor = await input.fileSystem.registry.register(outputPath)
      const output = await input.fileSystem.stat(descriptor)
      await input.tasks.update(task.id, {
        status: 'completed',
        progress: 1,
        data: {
          textLength: ttsInput.text.length,
          voiceId: ttsInput.voiceId ?? null,
          outputName: output.name,
          outputSize: output.size,
        },
      })
      return { taskId: task.id, handle: descriptor, file: output }
    } catch (error) {
      await input.tasks.update(task.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })

  handle(DESKTOP_IPC.credentialsGet, (_event, key: string) =>
    input.credentials.get(validateCredentialKey(key, READABLE_CREDENTIAL_KEYS)),
  )
  handle(DESKTOP_IPC.credentialsHas, async (_event, key: string, baseUrl?: string) => {
    const normalizedKey = validateCredentialKey(key, MANAGEABLE_CREDENTIAL_KEYS)
    const originKey = credentialOriginKey(normalizedKey)
    if (!originKey) return input.credentials.has(normalizedKey)
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false
    const [hasCredential, boundOrigin] = await Promise.all([
      input.credentials.has(normalizedKey),
      input.credentials.get(originKey),
    ])
    return hasCredential && boundOrigin === normalizeCredentialOrigin(baseUrl)
  })
  handle(
    DESKTOP_IPC.credentialsSet,
    async (_event, key: string, value: string, baseUrl?: string) => {
      if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_VALUE_LENGTH) {
        throw new Error('Credential value exceeds the supported size.')
      }
      const normalizedKey = validateCredentialKey(key, MANAGEABLE_CREDENTIAL_KEYS)
      const originKey = credentialOriginKey(normalizedKey)
      if (!originKey) return input.credentials.set(normalizedKey, value)
      if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
        throw new Error('A service URL is required when saving this credential.')
      }
      return input.credentials.setMany({
        [normalizedKey]: value,
        [originKey]: normalizeCredentialOrigin(baseUrl),
      })
    },
  )
  handle(DESKTOP_IPC.credentialsDelete, (_event, key: string) => {
    const normalizedKey = validateCredentialKey(key, MANAGEABLE_CREDENTIAL_KEYS)
    const originKey = credentialOriginKey(normalizedKey)
    return originKey
      ? input.credentials.deleteMany([normalizedKey, originKey])
      : input.credentials.delete(normalizedKey)
  })

  handle(DESKTOP_IPC.agentRuntimeGetInfo, () => input.agentRuntime.getInfo())
  handle(DESKTOP_IPC.agentRuntimeListRecords, (_event, value: unknown) =>
    input.agentRuntime.listRecords(parseAgentRecordListInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimePutRecords, (_event, value: unknown) =>
    input.agentRuntime.putRecords(parseAgentPutRecordsInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeStartRun, (_event, value: unknown) =>
    input.agentRuntime.startRun(parseAgentStartRunInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeCompleteRun, (_event, value: unknown) =>
    input.agentRuntime.completeRun(parseAgentCompleteRunInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeBuildContextPack, (_event, value: unknown) =>
    input.agentRuntime.buildContextPack(parseAgentContextPackInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeProjectCloudMetadata, (_event, value: unknown) =>
    input.agentRuntime.projectCloudMetadata(parseAgentCloudMetadataInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeAcquireLease, (_event, value: unknown) =>
    input.agentRuntime.acquireLease(parseAgentLeaseAcquireInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeRenewLease, (_event, value: unknown) =>
    input.agentRuntime.renewLease(parseAgentLeaseRenewInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeReleaseLease, (_event, value: unknown) =>
    input.agentRuntime.releaseLease(parseAgentLeaseReleaseInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeAssertLease, (_event, value: unknown) =>
    input.agentRuntime.assertLease(parseAgentLeaseAssertInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeWriteSandbox, (_event, value: unknown) =>
    input.agentRuntime.writeSandbox(parseAgentSandboxWriteInput(value)),
  )
  handle(DESKTOP_IPC.agentRuntimeSandboxStatus, (_event, runId: unknown) =>
    input.agentRuntime.sandboxStatus(parseId(runId, 'Agent runId')),
  )
  handle(DESKTOP_IPC.agentRuntimeCleanup, (_event, value: unknown) =>
    input.agentRuntime.cleanup(parseAgentCleanupInput(value)),
  )

  handle(DESKTOP_IPC.updatesGetStatus, () => desktopUpdateStatus)
  handle(DESKTOP_IPC.updatesCheck, async () => {
    if (input.updateMode === 'disabled') return desktopUpdateStatus
    if (
      desktopUpdateStatus.phase === 'checking' ||
      desktopUpdateStatus.phase === 'downloading' ||
      desktopUpdateStatus.phase === 'installing'
    ) {
      return desktopUpdateStatus
    }
    if (input.updateMode === 'notification') {
      return input.checkNotificationUpdate()
    }
    try {
      await autoUpdater.checkForUpdates()
      return desktopUpdateStatus
    } catch (error) {
      setDesktopUpdateStatus({ phase: 'error', error: updateErrorMessage(error) })
      throw error
    }
  })
  handle(DESKTOP_IPC.updatesDownload, async () => {
    if (input.updateMode === 'disabled') return desktopUpdateStatus
    if (!desktopUpdateStatus.availableVersion) {
      throw new Error('No FreeCut update is available to download.')
    }
    if (input.updateMode === 'notification') {
      await input.openNotificationUpdate()
      return desktopUpdateStatus
    }
    try {
      await autoUpdater.downloadUpdate()
      return desktopUpdateStatus
    } catch (error) {
      setDesktopUpdateStatus({
        phase: 'error',
        availableVersion: desktopUpdateStatus.availableVersion,
        error: updateErrorMessage(error),
      })
      throw error
    }
  })
  handle(DESKTOP_IPC.updatesInstall, async (event) => {
    if (input.updateMode !== 'automatic') return
    if (desktopUpdateStatus.phase !== 'downloaded') {
      throw new Error('No downloaded FreeCut update is ready to install.')
    }
    const confirmation = await dialog.showMessageBox(requireMainWindow(event), {
      type: 'question',
      title: '安装帧剪更新？',
      message: '帧剪将关闭并安装已下载的更新。',
      detail: '请确认当前项目已经保存。',
      buttons: ['取消', '立即重启并安装'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (confirmation.response !== 1) {
      throw new Error('Update installation was cancelled.')
    }
    setDesktopUpdateStatus({
      phase: 'installing',
      availableVersion: desktopUpdateStatus.availableVersion,
      progressPercent: 100,
    })
    autoUpdater.quitAndInstall(true, true)
  })
  handle(DESKTOP_IPC.diagnosticsLog, (_event, value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid Renderer log entry.')
    const { level, message } = value as { level?: unknown; message?: unknown }
    if (
      (level !== 'warn' && level !== 'error') ||
      typeof message !== 'string' ||
      message.length > 16_384
    ) {
      throw new Error('Invalid Renderer log entry.')
    }
    const now = Date.now()
    if (now - rendererLogWindowStartedAt >= 60_000) {
      rendererLogWindowStartedAt = now
      rendererLogCount = 0
    }
    if (rendererLogCount >= 120) return
    rendererLogCount += 1
    input.log(`renderer ${level}: ${message.replaceAll('\0', '')}`)
  })
  handle(DESKTOP_IPC.diagnosticsInspect, () => input.diagnostics.inspect())
  handle(DESKTOP_IPC.diagnosticsExport, async (event) => {
    const result = await dialog.showOpenDialog(requireMainWindow(event), {
      title: 'Export FreeCut diagnostics',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return ''
    return input.diagnostics.export(result.filePaths[0])
  })
}

async function start(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId('com.freecut.desktop')
  app.setAppLogsPath()
  crashReporter.start({
    companyName: 'FreeCut',
    productName: 'FreeCut',
    uploadToServer: false,
    compress: true,
  })
  await registerAppProtocol()
  installPermissionPolicy()

  const userDataPath = app.getPath('userData')
  const e2eWorkspacePath = process.env.FREECUT_E2E_WORKSPACE?.trim()
  const e2eWorkspaceRoot = process.env.FREECUT_E2E_WORKSPACE_ROOT?.trim()
  const privateDataPath = await prepareWindowsPrivateDataDirectory(userDataPath)
  const logPath = join(app.getPath('logs'), 'main.log')
  await mkdir(dirname(logPath), { recursive: true })
  const rotatedLogPath = `${logPath}.1`
  const maxLogBytes = 5 * 1024 * 1024
  let logQueue: Promise<void> = Promise.resolve()
  const appendLogLine = async (line: string): Promise<void> => {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const metadata = await stat(logPath).catch(() => null)
    if (metadata && metadata.size + lineBytes > maxLogBytes) {
      await rm(rotatedLogPath, { force: true })
      await rename(logPath, rotatedLogPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    await appendFile(logPath, line)
  }
  const queueLogLine = (line: string): Promise<void> => {
    const next = logQueue.then(() => appendLogLine(line))
    logQueue = next.catch(() => undefined)
    return next
  }
  let consoleLoggingAvailable = !process.stderr.destroyed
  process.stderr.on('error', () => {
    consoleLoggingAvailable = false
  })
  const writeConsoleLine = (line: string): void => {
    if (!consoleLoggingAvailable || process.stderr.destroyed || !process.stderr.writable) return
    process.stderr.write(line)
  }
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}\n`
    writeConsoleLine(line)
    void queueLogLine(line).catch((error) => {
      writeConsoleLine(`FreeCut log write failed: ${String(error)}\n`)
    })
  }
  let handlingFatalError = false
  const exitAfterFatalError = (kind: string, reason: unknown) => {
    if (handlingFatalError || isQuitting) return
    handlingFatalError = true
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    const line = `${new Date().toISOString()} ${kind}: ${detail}\n`
    writeConsoleLine(line)
    const exitTimer = setTimeout(() => app.exit(1), 1_000)
    exitTimer.unref()
    void queueLogLine(line).finally(() => app.exit(1))
  }
  process.on('uncaughtException', (error) => exitAfterFatalError('uncaughtException', error))
  process.on('unhandledRejection', (reason) => exitAfterFatalError('unhandledRejection', reason))
  app.on('child-process-gone', (_event, details) => {
    log(
      `child process gone: type=${details.type} reason=${details.reason} ` +
        `exitCode=${details.exitCode} service=${details.serviceName ?? ''}`,
    )
  })

  const registry = new PathRegistry()
  await registerMediaProtocol(registry)
  const fileSystem = new FileSystemService(registry)
  const handles = new DesktopHandleStore(join(privateDataPath, 'handles.json'), registry)
  const developmentWorkspace = app.isPackaged ? '' : process.env.FREECUT_DEV_WORKSPACE?.trim()
  if (developmentWorkspace) {
    const handle = await registry.register(developmentWorkspace)
    if (handle.kind !== 'directory') {
      throw new Error('FREECUT_DEV_WORKSPACE must point to a directory.')
    }
    const pickedAt = Date.now()
    await handles.save({
      kind: 'workspace',
      id: 'development',
      handle,
      pickedAt,
    })
    await handles.save({
      kind: 'workspace',
      id: 'current',
      handle,
      pickedAt,
      activeWorkspaceId: 'development',
    })
  }
  const e2eWorkspaceHandle = isE2eMode ? await handles.get('workspace', 'current') : null
  const e2eActualWorkspaceRoot = e2eWorkspaceHandle
    ? registry.resolve(e2eWorkspaceHandle)
    : undefined
  const isTrustedE2eFixture = isTrustedE2eAuthorization({
    enabled: isE2eMode,
    projectId: e2eProjectId,
    configuredWorkspaceRoot: e2eWorkspaceRoot,
    requestedWorkspaceRoot: e2eWorkspacePath,
    actualWorkspaceRoot: e2eActualWorkspaceRoot,
    requestedUserDataPath: e2eRequestedUserDataPath,
    actualUserDataPath: userDataPath,
  })
  if (isE2eMode && !isTrustedE2eFixture) {
    throw new Error('FREECUT_E2E workspace, handle root, or userData path did not match.')
  }
  const tasks = new TaskRepository(join(privateDataPath, 'tasks.json'))
  await tasks.markInterrupted()
  const agentRuntime = new AgentRuntimeService(join(privateDataPath, 'agent-runtime'), {
    logsPath: logPath,
    log: (message) => log(`[FREECUT_AGENT_RUNTIME] ${message}`),
  })
  await agentRuntime.initialize()
  const bridge = new BridgeService(tasks, {
    confirmExecution: async ({ requestId, name, projectId, destructive, handoff }) => {
      if (isTrustedE2eFixture && projectId === e2eProjectId) {
        log(
          `[FREECUT_BRIDGE] confirm auto-approved requestId=${requestId} name=${name} ` +
            `projectId=${projectId ?? ''} destructive=${destructive} handoff=${handoff}`,
        )
        return true
      }
      if (!mainWindow || mainWindow.isDestroyed()) return false
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: destructive
          ? '允许外部工具执行破坏性修改？'
          : handoff
            ? '允许外部工具打开交互操作？'
            : '允许外部工具修改项目？',
        message: `外部工具请求执行 ${name}`,
        detail: [
          `项目：${projectId ?? '未打开'}`,
          `请求 ID：${requestId}`,
          handoff ? '此命令需要你在帧剪中继续确认或操作。' : '',
          '此授权仅对本次命令有效。',
        ]
          .filter(Boolean)
          .join('\n'),
        buttons: ['取消', '允许一次'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return confirmation.response === 1
    },
    log: (message) => log(`[FREECUT_BRIDGE] ${message}`),
  })
  const bridgeHttp = await startBridgeHttpServer(bridge)
  const bridgeInfoPath = join(userDataPath, 'bridge.json')
  await writeFile(
    bridgeInfoPath,
    JSON.stringify(
      {
        version: 1,
        pid: process.pid,
        appVersion: app.getVersion(),
        url: bridgeHttp.url,
        mcpUrl: bridgeHttp.mcpUrl,
        token: bridgeHttp.token,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  )
  await restrictWindowsFile(bridgeInfoPath)
  const ffmpeg = await FfmpegService.resolve(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    { allowEnvironment: !app.isPackaged },
  )
  const tts = new WindowsTtsService(join(userDataPath, 'generated', 'tts'))
  const credentials = new CredentialStore(join(privateDataPath, 'credentials.json'))
  const cloudBridge = new CloudBridgeService(credentials)
  const localAgentHost = new LocalAgentHostService({
    runtime: agentRuntime,
    bridge,
    transport: {
      run: async ({ request }, signal) => {
        if (signal.aborted) throw new Error('Local Agent run was cancelled.')
        const baseUrl = await credentials.get(
          DESKTOP_CREDENTIAL_ORIGIN_KEYS.cloudBridgeBusinessKey,
        )
        if (!baseUrl) {
          throw Object.assign(new Error('请先配置剪好 MCP Key。'), {
            code: 'LOCAL_AGENT_NOT_CONFIGURED',
          })
        }
        const requestId = crypto.randomUUID()
        const cancel = () => {
          void cloudBridge.cancel(requestId)
        }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          const response = await cloudBridge.request({
            requestId,
            baseUrl,
            method: 'POST',
            path: '/api/v1/agent-turns',
            timeoutMs: AGENT_TURN_TIMEOUT_MS,
            body: request,
          })
          return parseAgentTurnResponse(response, request)
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    },
  })
  const asr = new DashScopeAsrService(credentials)
  const transcriptions = new TranscriptionTaskService(tasks, asr)
  const diagnostics = new DiagnosticsService({
    appVersion: () => app.getVersion(),
    osVersion: () => release(),
    gpuFeatureStatus: () => app.getGPUFeatureStatus(),
    gpuProbe: () => rendererGpuProbe,
    safeMode: () => isSafeMode,
    crashDumpsPath: app.getPath('crashDumps'),
    logPath,
    ffmpeg,
    tasks,
  })

  const packageMetadata = getDesktopPackageMetadata()
  const releaseChannel = packageMetadata.releaseChannel
  const automaticUpdatesEnabled = app.isPackaged && releaseChannel === 'production'
  const notificationUpdates =
    app.isPackaged && packageMetadata.updateMode === 'notification'
      ? new UpdateNotificationService(
          packageMetadata.updateManifestUrl,
          app.getVersion(),
          (url) =>
            net.fetch(url, {
              method: 'GET',
              cache: 'no-store',
              signal: AbortSignal.timeout(15_000),
            }),
        )
      : null
  const updateMode: DesktopUpdateMode = notificationUpdates
    ? 'notification'
    : automaticUpdatesEnabled
      ? 'automatic'
      : 'disabled'
  let latestNotificationUpdate: DesktopReleaseNotification | null = null
  let lastPromptedNotificationVersion = ''
  const openNotificationUpdate = async () => {
    if (!latestNotificationUpdate) {
      throw new Error('No FreeCut download page is available.')
    }
    await shell.openExternal(latestNotificationUpdate.downloadUrl)
  }
  const checkNotificationUpdate = async (
    showPrompt = false,
  ): Promise<DesktopUpdateStatus> => {
    if (!notificationUpdates) return desktopUpdateStatus
    try {
      setDesktopUpdateStatus({ phase: 'checking' })
      latestNotificationUpdate = await notificationUpdates.check()
      if (!latestNotificationUpdate) {
        return setDesktopUpdateStatus({ phase: 'up-to-date' })
      }
      const status = setDesktopUpdateStatus({
        phase: 'available',
        availableVersion: latestNotificationUpdate.version,
        delivery: 'external',
      })
      if (
        showPrompt &&
        lastPromptedNotificationVersion !== latestNotificationUpdate.version &&
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        lastPromptedNotificationVersion = latestNotificationUpdate.version
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '帧剪有新版本',
          message: `发现帧剪 ${latestNotificationUpdate.version}`,
          detail:
            latestNotificationUpdate.notes?.trim() ||
            '将打开更新下载页面。安装新版本前请先保存当前项目。',
          buttons: ['稍后', '前往下载'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        })
        if (confirmation.response === 1) {
          await openNotificationUpdate()
        }
      }
      return status
    } catch (error) {
      setDesktopUpdateStatus({ phase: 'error', error: updateErrorMessage(error) })
      throw error
    }
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (...args: unknown[]) => log(`updater info: ${args.map(String).join(' ')}`),
    warn: (...args: unknown[]) => log(`updater warn: ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => log(`updater error: ${args.map(String).join(' ')}`),
    debug: (...args: unknown[]) => log(`updater debug: ${args.map(String).join(' ')}`),
  }
  setDesktopUpdateStatus({ phase: updateMode === 'disabled' ? 'disabled' : 'idle' })
  autoUpdater.on('checking-for-update', () => {
    setDesktopUpdateStatus({ phase: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    setDesktopUpdateStatus({
      phase: 'available',
      availableVersion: info.version,
      delivery: 'automatic',
    })
  })
  autoUpdater.on('update-not-available', () => {
    setDesktopUpdateStatus({ phase: 'up-to-date' })
  })
  autoUpdater.on('download-progress', (progress) => {
    setDesktopUpdateStatus({
      phase: 'downloading',
      availableVersion: desktopUpdateStatus.availableVersion,
      progressPercent: Math.max(0, Math.min(100, progress.percent)),
      bytesPerSecond: progress.bytesPerSecond,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setDesktopUpdateStatus({
      phase: 'downloaded',
      availableVersion: info.version,
      progressPercent: 100,
    })
  })
  autoUpdater.on('error', (error) => {
    setDesktopUpdateStatus({
      phase: 'error',
      availableVersion: desktopUpdateStatus.availableVersion,
      error: updateErrorMessage(error),
    })
  })
  let updateRetryAttempt = 0
  const scheduleUpdateCheck = (delayMs: number) => {
    if (updateMode === 'disabled' || isQuitting) return
    if (updateCheckTimer) clearTimeout(updateCheckTimer)
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null
      if (isQuitting) return
      const check =
        updateMode === 'notification'
          ? checkNotificationUpdate(true)
          : autoUpdater.checkForUpdates()
      void check
        .then(() => {
          updateRetryAttempt = 0
          scheduleUpdateCheck(UPDATE_CHECK_INTERVAL_MS)
        })
        .catch((error) => {
          log(`automatic update check failed: ${updateErrorMessage(error)}`)
          const retryDelay =
            UPDATE_RETRY_DELAYS_MS[Math.min(updateRetryAttempt, UPDATE_RETRY_DELAYS_MS.length - 1)]!
          updateRetryAttempt += 1
          scheduleUpdateCheck(retryDelay)
        })
    }, delayMs)
  }

  registerIpc({
    fileSystem,
    handles,
    bridge,
    cloudBridge,
    ffmpeg,
    transcriptions,
    tts,
    credentials,
    diagnostics,
    tasks,
    agentRuntime,
    localAgentHost,
    updateMode,
    checkNotificationUpdate,
    openNotificationUpdate,
    log,
  })
  const removeBridgeListener = bridge.onCall((call) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.bridgeCall, call)
    }
  })
  const removeBridgeCancelListener = bridge.onCancel((requestId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.bridgeCancelCall, requestId)
    }
  })

  mainWindow = await createWindow(join(__dirname, 'preload.cjs'), log)
  await ensureRendererGpu(mainWindow, log)
  if (!mainWindow.isDestroyed()) mainWindow.show()
  log(
    `started version=${app.getVersion()} channel=${releaseChannel} ` +
      `updateMode=${updateMode} safeMode=${isSafeMode} e2e=${isE2eMode} ` +
      `projectId=${e2eProjectId ?? ''} userData=${userDataPath} bridge=${bridgeHttp.url}`,
  )
  scheduleUpdateCheck(10_000)

  app.on('before-quit', () => {
    isQuitting = true
    if (updateCheckTimer) {
      clearTimeout(updateCheckTimer)
      updateCheckTimer = null
    }
    removeBridgeListener()
    removeBridgeCancelListener()
    bridge.dispose()
    cloudBridge.dispose()
    transcriptions.dispose()
    void agentRuntime.dispose().catch((error) =>
      log(`[FREECUT_AGENT_RUNTIME] dispose failed: ${String(error)}`),
    )
    void fileSystem.dispose()
    void bridgeHttp.close().catch((error) => log(`bridge close failed: ${String(error)}`))
    void rm(bridgeInfoPath, { force: true })
  })
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.on('window-all-closed', () => app.quit())

if (hasSingleInstanceLock && process.platform === 'win32') {
  void start().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    dialog.showErrorBox('FreeCut failed to start', message)
    app.exit(1)
  })
}
