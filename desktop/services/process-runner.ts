import { spawn } from 'node:child_process'
import { join } from 'node:path'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

const SYSTEM32_DIRECTORY = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')

/**
 * Resolves a well-known Windows system executable to its absolute path under
 * `%SystemRoot%\System32` instead of relying on PATH resolution, which can be
 * shadowed by non-Windows tools of the same name (e.g. Git for Windows ships
 * a GNU `whoami` that rejects Windows-style flags like `/user`).
 */
export function resolveSystemExecutable(relativePath: string): string {
  return join(SYSTEM32_DIRECTORY, relativePath)
}

export async function runProcess(input: {
  executable: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}): Promise<ProcessResult> {
  const maxOutputBytes = input.maxOutputBytes ?? 8 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
      fn()
    }
    const abort = () => {
      child.kill()
      finish(() => reject(new DOMException('Process cancelled', 'AbortError')))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`Process timed out after ${input.timeoutMs ?? 300_000}ms.`)))
    }, input.timeoutMs ?? 300_000)

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        child.kill()
        finish(() => reject(new Error('Process output exceeded the configured limit.')))
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => {
      finish(() =>
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      )
    })

    if (input.signal?.aborted) {
      abort()
      return
    }
    input.signal?.addEventListener('abort', abort, { once: true })
  })
}
