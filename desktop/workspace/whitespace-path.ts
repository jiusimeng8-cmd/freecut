import { opendir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Windows paths are case-insensitive, so a name that differs only in case
 * already resolves. Whitespace is the gap: a model transcribing a path can drop
 * the space in `新建文件夹 (3)`, and a path that wrapped across lines arrives
 * with an embedded newline. Both produce ENOENT on a folder that plainly exists.
 */
function normalizeWhitespace(name: string): string {
  // JavaScript's `\s` covers the ideographic space (U+3000) and NBSP (U+00A0),
  // which matter here because both are easy to produce with a Chinese IME.
  return name.replace(/\s+/gu, '')
}

/** Bounds the scan so a huge directory cannot stall the main process. */
const MAX_ENTRIES_SCANNED = 5_000

/**
 * Finds a sibling of `path` whose name is identical once whitespace is removed.
 *
 * Deliberately an exact match on the normalized name rather than a fuzzy or
 * prefix match: the path originates from the model, so a looser comparison
 * would turn this into a filesystem enumeration primitive. Requiring exact
 * equality means the caller already knew the full name and learns nothing it
 * did not supply.
 *
 * Returns `null` when the parent is unreadable, nothing matches, or more than
 * one entry matches — an ambiguous correction is not a correction.
 */
export async function findWhitespaceVariantPath(path: string): Promise<string | null> {
  const wanted = normalizeWhitespace(basename(path))
  // An all-whitespace or empty basename would match far too much.
  if (!wanted) return null
  const parent = dirname(path)
  if (parent === path) return null

  let directory
  try {
    directory = await opendir(parent)
  } catch {
    return null
  }

  let match: string | null = null
  let scanned = 0
  try {
    for await (const entry of directory) {
      if (++scanned > MAX_ENTRIES_SCANNED) return null
      if (normalizeWhitespace(entry.name) !== wanted) continue
      // A second match means the intent is genuinely unclear, so correcting
      // would be a guess at which file the user meant.
      if (match) return null
      match = entry.name
    }
  } catch {
    return null
  }

  return match === null ? null : join(parent, match)
}

/**
 * Returns the path to use, preferring the requested one and falling back to a
 * whitespace-variant sibling only when the request does not exist.
 */
export async function resolveExistingPath(
  path: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  if (await exists(path)) return path
  const variant = await findWhitespaceVariantPath(path)
  if (variant && variant !== path && (await exists(variant))) return variant
  return null
}
