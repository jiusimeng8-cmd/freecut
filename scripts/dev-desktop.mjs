import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const desktopUrl = process.env.FREECUT_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173'
const configuredWorkspace = process.env.FREECUT_DEV_WORKSPACE?.trim()
const workspace = configuredWorkspace || resolve(root, 'tmp', 'desktop-dev-workspace')
if (!configuredWorkspace) mkdirSync(workspace, { recursive: true })

function start(command, args, env, { shell = false, windowsHide = true } = {}) {
  return spawn(command, args, {
    cwd: root,
    env,
    shell,
    stdio: 'inherit',
    windowsHide,
  })
}

async function isServerUp(url) {
  return new Promise((resolveReady) => {
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
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isServerUp(url)) return
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
// The electron package exports the path to its own binary. Resolving it beats
// looking for `electron.cmd` on PATH: the .cmd shim is only there when
// node_modules/.bin is on PATH, and on Windows a .cmd cannot be spawned without
// a shell at all (Node refuses with EINVAL since 20.12).
const electronCommand = createRequire(import.meta.url)('electron')
// Reuse a dev server that is already serving this URL. Starting a second one
// only fails on the port and takes the whole launch down with it, which reads as
// "the desktop app is broken" when the real state is "it was already running".
const reusingServer = await isServerUp(desktopUrl)
if (reusingServer) {
  process.stdout.write(`Reusing the dev server already running at ${desktopUrl}\n`)
}
// npm is still a .cmd on Windows and still needs the shell. Args here are all
// hardcoded above, so there is nothing user-supplied to be mis-quoted.
const vite = reusingServer
  ? null
  : start(npmCommand, ['run', 'dev'], env, { shell: process.platform === 'win32' })
let electron = null
let closing = false

async function close(code = 0) {
  if (closing) return
  closing = true
  electron?.kill()
  // Not ours to stop if we did not start it.
  vite?.kill()
  process.exitCode = code
}

vite?.once('exit', (code) => {
  if (!closing) void close(code ?? 1)
})

try {
  await waitForServer(desktopUrl)
  await import('./build-desktop.mjs')
  electron = start(electronCommand, ['.'], env, {
    // windowsHide suppresses the console window a child would pop up, but for
    // Electron it also hides the app's own window whenever the launcher itself
    // has no console — the app then runs headless with no way to click it.
    windowsHide: false,
  })
  electron.once('exit', (code) => {
    if (!closing) void close(code ?? 0)
  })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  await close(1)
}

process.on('SIGINT', () => void close(0))
process.on('SIGTERM', () => void close(0))
