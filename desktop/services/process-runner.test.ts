// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { runProcess } from './process-runner'

describe('runProcess', () => {
  it('waits for stdout to close before resolving', async () => {
    const outputBytes = 512 * 1024
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(${outputBytes}, 97))`],
      timeoutMs: 10_000,
      maxOutputBytes: outputBytes + 1,
    })

    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout)).toBe(outputBytes)
  })
})
