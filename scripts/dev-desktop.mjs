import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { request } from 'node:http'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const desktopUrl = process.env.FREECUT_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173'
const configuredWorkspace = process.env.FREECUT_DEV_WORKSPACE?.trim()
const workspace = configuredWorkspace || resolve(root, 'tmp', 'desktop-dev-workspace')
if (!configuredWorkspace) mkdirSync(workspace, { recursive: true })

function start(command, args, env) {
  return spawn(command, args, {
    cwd: root,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  })
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await new Promise((resolveReady) => {
      const req = request(url, { method: 'HEAD' }, (response) => {
        response.resume()
        resolveReady((response.statusCode ?? 500) < 500)
      })
      req.on('error', () => resolveReady(false))
      req.setTimeout(1_000, () => {
        req.destroy()
        resolveReady(false)
      })
      req.end()
    })
    if (ready) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

const env = {
  ...process.env,
  FREECUT_DESKTOP_DEV_URL: desktopUrl,
  FREECUT_DEV_WORKSPACE: workspace,
}
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electronCommand = process.platform === 'win32' ? 'electron.cmd' : 'electron'
const vite = start(npmCommand, ['run', 'dev'], env)
let electron = null
let closing = false

async function close(code = 0) {
  if (closing) return
  closing = true
  electron?.kill()
  vite.kill()
  process.exitCode = code
}

vite.once('exit', (code) => {
  if (!closing) void close(code ?? 1)
})

try {
  await waitForServer(desktopUrl)
  await import('./build-desktop.mjs')
  electron = start(electronCommand, ['.'], env)
  electron.once('exit', (code) => {
    if (!closing) void close(code ?? 0)
  })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  await close(1)
}

process.on('SIGINT', () => void close(0))
process.on('SIGTERM', () => void close(0))
