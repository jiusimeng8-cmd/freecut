import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const fixturePath = resolve(
  process.env.FREECUT_E2E_WORKSPACE ?? 'C:\\tmp\\freecut-local-e2e-fixture',
)
const sourceWorkspacePath = resolve(process.env.FREECUT_E2E_SOURCE_WORKSPACE ?? 'D:\\jianji')
const projectId = process.env.FREECUT_E2E_PROJECT_ID ?? 'local-e2e-fixture'
const cdpPort = Number(process.env.FREECUT_E2E_CDP_PORT ?? 9340)
const readyPath = resolve(
  process.env.FREECUT_E2E_READY_PATH ?? 'C:\\tmp\\freecut-local-e2e-ready.json',
)
const runId = `${Date.now()}-${process.pid}`
const userDataPath = resolve(
  process.env.FREECUT_E2E_USER_DATA ?? `C:\\tmp\\freecut-local-e2e-userdata-${runId}`,
)
const startupLogPath = resolve(
  process.env.FREECUT_E2E_LOG_PATH ?? `C:\\tmp\\freecut-local-e2e-${runId}.log`,
)
const cdpUrl = `http://127.0.0.1:${cdpPort}`
const startupTimeoutMs = Number(process.env.FREECUT_E2E_TIMEOUT_MS ?? 120_000)
let launchedProcessExitCode

function assertFixtureResetPath(path) {
  const expected = resolve('C:\\tmp\\freecut-local-e2e-fixture')
  if (path.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Refusing to reset unexpected fixture path: ${path}`)
  }
}

function assertValidPort(value) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`Invalid FREECUT_E2E_CDP_PORT: ${value}`)
  }
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const path = resolve(candidate)
    if (await access(path).then(() => true).catch(() => false)) return path
  }
  throw new Error(
    [
      'No FreeCut Electron executable is available.',
      'Set FREECUT_E2E_EXECUTABLE or build a win-unpacked Desktop package.',
    ].join(' '),
  )
}

async function replaceProjectIdInJsonFiles(directory, sourceProjectId) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await replaceProjectIdInJsonFiles(path, sourceProjectId)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const source = await readFile(path, 'utf8')
    if (!source.includes(sourceProjectId)) continue
    await writeFile(path, source.split(sourceProjectId).join(projectId), 'utf8')
  }
}

async function prepareFixture() {
  assertFixtureResetPath(fixturePath)
  await rm(fixturePath, { recursive: true, force: true })
  await cp(sourceWorkspacePath, fixturePath, { recursive: true })

  const indexPath = join(fixturePath, 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const sourceProject = index.projects?.[0]
  if (!sourceProject?.id) {
    throw new Error(`Source workspace has no project: ${sourceWorkspacePath}`)
  }

  const sourceProjectPath = join(fixturePath, 'projects', sourceProject.id)
  const fixtureProjectPath = join(fixturePath, 'projects', projectId)
  if (sourceProject.id !== projectId) {
    await rename(sourceProjectPath, fixtureProjectPath)
  }
  await replaceProjectIdInJsonFiles(fixtureProjectPath, sourceProject.id)

  const projectJsonPath = join(fixtureProjectPath, 'project.json')
  const project = JSON.parse(await readFile(projectJsonPath, 'utf8'))
  const now = Date.now()
  project.id = projectId
  project.name = 'Local E2E Fixture'
  project.updatedAt = now
  await writeFile(projectJsonPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8')

  index.updatedAt = now
  index.projects = [{ id: projectId, name: project.name, updatedAt: now }]
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

async function prepareUserData() {
  const privatePath = join(userDataPath, 'private')
  await mkdir(privatePath, { recursive: true })
  const pickedAt = Date.now()
  await writeFile(
    join(privatePath, 'handles.json'),
    `${JSON.stringify(
      [
        {
          kind: 'workspace',
          id: 'local-e2e-workspace',
          absolutePath: fixturePath,
          handleKind: 'directory',
          pickedAt,
        },
        {
          kind: 'workspace',
          id: 'current',
          absolutePath: fixturePath,
          handleKind: 'directory',
          pickedAt,
          activeWorkspaceId: 'local-e2e-workspace',
        },
      ],
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(2_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${body || response.statusText}`)
  }
  return body ? JSON.parse(body) : null
}

async function waitUntil(label, operation) {
  const deadline = Date.now() + startupTimeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (launchedProcessExitCode !== undefined) {
      throw new Error(`Electron exited with code ${launchedProcessExitCode} while waiting for ${label}.`)
    }
    try {
      const result = await operation()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  )
}

async function pageTarget() {
  const targets = await fetchJson(`${cdpUrl}/json/list`)
  return (
    targets.find(
      (target) =>
        target.type === 'page' &&
        typeof target.url === 'string' &&
        target.url.includes(`/editor/${projectId}`),
    ) ?? null
  )
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })

  const result = await new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => rejectResult(new Error('CDP Runtime.evaluate timed out')), 10_000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timeout)
      if (message.error) rejectResult(new Error(JSON.stringify(message.error)))
      else resolveResult(message.result)
    })
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
  socket.close()
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'CDP error',
    )
  }
  return result.result?.value
}

async function openFixtureEditor() {
  return waitUntil('fixture editor route', async () => {
    const current = await pageTarget()
    if (!current?.url.includes(`/editor/${projectId}`)) return null
    const state = await evaluate(
      current,
      `JSON.stringify({ href: location.href, readyState: document.readyState, text: document.body?.innerText?.slice(0, 500) || "" })`,
    )
    const parsed = JSON.parse(state)
    return parsed.readyState === 'complete' && parsed.href.includes(`/editor/${projectId}`)
      ? current
      : null
  })
}

async function waitForBridge() {
  const bridgeInfoPath = join(userDataPath, 'bridge.json')
  const bridge = await waitUntil('bridge.json', async () => {
    const source = await readFile(bridgeInfoPath, 'utf8').catch(() => '')
    return source ? JSON.parse(source) : null
  })
  const headers = { Authorization: `Bearer ${bridge.token}` }
  const status = await waitUntil('connected Renderer Bridge', async () => {
    const value = await fetchJson(`${bridge.url}/v1/status`, { headers })
    return value.connected === true && value.renderer?.projectId === projectId ? value : null
  })
  const toolsResponse = await fetchJson(`${bridge.url}/v1/tools`, { headers })
  const tools = Array.isArray(toolsResponse.tools) ? toolsResponse.tools : []
  if (!tools.some((tool) => tool.name === 'read_project')) {
    throw new Error('Connected Renderer did not register read_project.')
  }

  const requestId = `local-e2e-read-project-${Date.now()}`
  const call = await fetchJson(`${bridge.url}/v1/call`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      name: 'read_project',
      args: {},
      projectId,
      allowDestructive: false,
      timeoutMs: 15_000,
    }),
  })
  const serializedResult = JSON.stringify(call.result)
  if (call.result?.isError || !serializedResult.includes(projectId)) {
    throw new Error(`read_project did not return ${projectId}.`)
  }
  return {
    bridge,
    bridgeInfoPath,
    status,
    toolCount: tools.length,
    requestId,
  }
}

assertValidPort(cdpPort)

const executablePath = await firstExistingPath([
  process.env.FREECUT_E2E_EXECUTABLE,
  'C:\\tmp\\freecut-local-e2e-app\\win-unpacked\\FreeCut Local E2E.exe',
  'C:\\tmp\\freecut-electron-qa-20260719\\win-unpacked\\FreeCut QA.exe',
  join(root, 'release-dev', 'win-unpacked', 'FreeCut Development.exe'),
  join(root, 'release', 'win-unpacked', 'FreeCut.exe'),
])

await fetchJson(`${cdpUrl}/json/version`).then(
  () => {
    throw new Error(`CDP port ${cdpPort} is already in use.`)
  },
  () => undefined,
)

await rm(readyPath, { force: true })
await prepareFixture()
await prepareUserData()
await mkdir(resolve(startupLogPath, '..'), { recursive: true })
const logHandle = await open(startupLogPath, 'a')
let child

try {
  child = spawn(
    executablePath,
    [
      `--user-data-dir=${userDataPath}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
    ],
    {
      cwd: fixturePath,
      detached: true,
      env: {
        ...process.env,
        FREECUT_E2E: '1',
        FREECUT_E2E_PROJECT_ID: projectId,
        FREECUT_E2E_USER_DATA: userDataPath,
        FREECUT_E2E_WORKSPACE: fixturePath,
      },
      shell: false,
      windowsHide: false,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    },
  )
  await logHandle.close()

  child.once('exit', (code) => {
    launchedProcessExitCode = code
  })

  await waitUntil('Electron process', async () => {
    return stat(startupLogPath).then(() => true)
  })
  await openFixtureEditor()
  const bridgeState = await waitForBridge()

  const ready = {
    version: 1,
    readyAt: new Date().toISOString(),
    pid: child.pid,
    cdpUrl,
    bridgeUrl: bridgeState.bridge.url,
    bridgeInfoPath: bridgeState.bridgeInfoPath,
    projectId,
    toolCount: bridgeState.toolCount,
    startupLogPath,
    executablePath,
    workspacePath: fixturePath,
    userDataPath,
    readProjectRequestId: bridgeState.requestId,
    clientVersion: bridgeState.bridge.appVersion,
  }
  const pendingReadyPath = `${readyPath}.${runId}.tmp`
  await writeFile(pendingReadyPath, `${JSON.stringify(ready, null, 2)}\n`, 'utf8')
  await rename(pendingReadyPath, readyPath)
  child.unref()
  process.stdout.write(`${JSON.stringify({ readyPath, ...ready }, null, 2)}\n`)
} catch (error) {
  await logHandle.close().catch(() => undefined)
  child?.kill()
  throw error
}
