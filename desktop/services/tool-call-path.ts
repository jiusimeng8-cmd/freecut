import { isAbsolute } from 'node:path'

/**
 * Extracts the local filesystem path a tool call will touch, so the approval
 * card can name it and the approved dispatch can pre-authorize it.
 *
 * The value originates from the model, so this is deliberately narrow: only a
 * top-level `path` string that is already absolute is recognised. Anything
 * else returns `null` and the write proceeds under the unchanged
 * path-authorization prompt.
 */
export function extractToolCallPath(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const value = (args as Record<string, unknown>).path
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  return isAbsolute(trimmed) ? trimmed : null
}
