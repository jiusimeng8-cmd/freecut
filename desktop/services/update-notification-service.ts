import { z } from 'zod'

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_MANIFEST_BYTES = 64 * 1024

function httpsUrl(value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
}

const releaseManifestSchema = z
  .object({
    version: z.string().regex(VERSION_PATTERN),
    downloadUrl: z.string().url().refine(httpsUrl),
    notes: z.string().max(2_000).optional(),
  })
  .strict()

export interface DesktopReleaseNotification {
  version: string
  downloadUrl: string
  notes?: string
}

export type ReleaseManifestFetcher = (url: string) => Promise<Response>

function versionParts(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error(`Invalid FreeCut version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

export class UpdateNotificationService {
  readonly manifestUrl: string

  constructor(
    manifestUrl: string,
    private readonly currentVersion: string,
    private readonly fetchManifest: ReleaseManifestFetcher,
  ) {
    if (!httpsUrl(manifestUrl)) {
      throw new Error('FreeCut update manifest URL must use HTTPS without embedded credentials.')
    }
    versionParts(currentVersion)
    this.manifestUrl = new URL(manifestUrl).href
  }

  async check(): Promise<DesktopReleaseNotification | null> {
    const response = await this.fetchManifest(this.manifestUrl)
    if (!response.ok) {
      throw new Error(`FreeCut update manifest returned HTTP ${response.status}.`)
    }
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new Error('FreeCut update manifest exceeds 64 KiB.')
    }
    const manifest = releaseManifestSchema.parse(JSON.parse(body))
    return compareReleaseVersions(manifest.version, this.currentVersion) > 0 ? manifest : null
  }
}
