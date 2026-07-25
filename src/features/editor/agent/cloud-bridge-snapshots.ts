import {
  captureSnapshot,
  useCompositionNavigationStore,
  useItemsStore,
  useKeyframesStore,
  useSequencesStore,
  useTimelineCommandStore,
  useTimelineSettingsStore,
  useTimelineStore,
  useTransitionsStore,
} from '@/features/editor/deps/timeline-contract'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import { useEditorStore } from '@/shared/state/editor'
import { useSelectionStore } from '@/shared/state/selection'
import { usePlaybackStore } from '@/shared/state/playback'

type LocalTimelineSnapshot = ReturnType<typeof captureSnapshot>

const MAX_SNAPSHOTS = 32
const SNAPSHOT_DB_NAME = 'freecut-cloud-bridge'
const SNAPSHOT_STORE_NAME = 'snapshots'
const CURRENT_SNAPSHOT_STORAGE_KEY = 'freecut:cloud-bridge-current-snapshots'
const snapshots = new Map<string, LocalTimelineSnapshot>()
const currentSnapshotByProject = new Map<string, string>()
const compositeSnapshots = new Map<string, CloudCompositeSnapshot>()
const pendingSnapshotWrites = new Map<string, Promise<void>>()

export const CLOUD_COMPOSITE_SNAPSHOT_SCHEMA = 'freecut.renderer.composite-snapshot.v1' as const
export const CLOUD_COMPOSITE_FINGERPRINT_VERSION = 1 as const

export interface CloudCompositeSnapshot {
  schema: typeof CLOUD_COMPOSITE_SNAPSHOT_SCHEMA
  fingerprintVersion: typeof CLOUD_COMPOSITE_FINGERPRINT_VERSION
  projectId: string | null
  projectRevision: string | number | null
  capturedAt: number
  hash: string
  timeline: {
    fps: number
    durationFrames: number
    trackCount: number
    itemCount: number
    textCount: number
    inPoint: number | null
    outPoint: number | null
    tracks: Array<{
      id: string
      kind: TimelineTrack['kind'] | null
      order: number
      locked: boolean
      syncLock: boolean
      visible: boolean
      muted: boolean
      solo: boolean
      volume: number | null
      itemIds: string[]
    }>
    items: Array<{
      id: string
      type: TimelineItem['type']
      trackId: string
      from: number
      durationInFrames: number
      endFrame: number
      mediaId: string | null
      originId: string | null
      linkedGroupId: string | null
      sourceStart: number | null
      sourceEnd: number | null
      sourceDuration: number | null
      sourceFps: number | null
      speed: number
      isReversed: boolean
      embeddedAudioMuted: boolean | null
      role: string | null
      effectCount: number
      motionModifierCount: number
      keyframeCount: number
      captionSource: string | null
      captionCueCount: number
      audio: {
        volume: number | null
        fadeIn: number
        fadeOut: number
      } | null
    }>
    transitionCount: number
    keyframeCount: number
    markerCount: number
    compositionIds: string[]
    topLevelSequenceIds: string[]
  }
  captions: {
    sourceCount: number
    sources: Array<{
      itemId: string
      sourceType: string
      mediaId: string | null
      enabled: boolean | null
      cueCount: number
      firstFrame: number
      lastFrame: number
    }>
  }
  assets: {
    mediaCount: number
    readiness: Array<{
      id: string
      transcriptStatus: string
      broken: string | null
      importing: boolean
      proxy: string | null
      interpolation: string | null
      upscale: string | null
    }>
  }
  runtime: {
    dirty: boolean
    loading: boolean
    activeSequenceId: string | null
    undoDepth: number
    redoDepth: number
    currentFrame: number
    selectedItemIds: string[]
    linkedSelectionEnabled: boolean
  }
  history: {
    undoCount: number
    redoCount: number
    undoLabel: string | null
    redoLabel: string | null
  }
  fingerprints: {
    timeline: string
    captions: string
    assets: string
    composite: string
  }
}

interface PersistedSnapshot {
  id: string
  projectId: string
  snapshot: LocalTimelineSnapshot
  composite?: CloudCompositeSnapshot
  createdAt: number
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

function fingerprint(value: unknown): string {
  let hash = 14695981039346656037n
  const prime = 1099511628211n
  const mask = 0xffffffffffffffffn
  for (const codePoint of stableSerialize(value)) {
    hash ^= BigInt(codePoint.codePointAt(0) ?? 0)
    hash = (hash * prime) & mask
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

export function fingerprintCloudValue(value: unknown): string {
  return fingerprint(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function itemRole(item: TimelineItem): string | null {
  const record = item as TimelineItem & { audioRole?: string; role?: string }
  if (item.type === 'text' && item.textRole) return item.textRole
  if (item.type === 'audio') return record.audioRole ?? record.role ?? 'audio'
  return record.role ?? null
}

function semanticItemFingerprintInput(item: TimelineItem): Record<string, unknown> {
  const {
    src: _src,
    audioSrc: _audioSrc,
    thumbnailUrl: _thumbnailUrl,
    waveformData: _waveformData,
    reverseConformSrc: _reverseConformSrc,
    reverseConformPath: _reverseConformPath,
    reverseConformPreviewSrc: _reverseConformPreviewSrc,
    reverseConformPreviewPath: _reverseConformPreviewPath,
    textLayoutDrafts: _textLayoutDrafts,
    label: _label,
    ...semantic
  } = item as TimelineItem & {
    src?: string
    audioSrc?: string
    thumbnailUrl?: string
    waveformData?: number[]
    reverseConformSrc?: string
    reverseConformPath?: string
    reverseConformPreviewSrc?: string
    reverseConformPreviewPath?: string
    textLayoutDrafts?: unknown
  }
  return semantic as Record<string, unknown>
}

function captionProjection(item: TimelineItem): {
  sourceType: string
  mediaId: string | null
  enabled: boolean | null
  cueCount: number
  firstFrame: number
  lastFrame: number
} | null {
  if (item.type === 'subtitle') {
    const source = item.source
    return {
      sourceType: source.type,
      mediaId: 'mediaId' in source ? source.mediaId : null,
      enabled: true,
      cueCount: item.cues.length,
      firstFrame: item.from,
      lastFrame: item.from + item.durationInFrames,
    }
  }
  if (item.type === 'text' && (item.textRole === 'caption' || item.captionSource)) {
    return {
      sourceType: item.captionSource?.type ?? 'text-caption',
      mediaId: item.captionSource?.mediaId ?? null,
      enabled: true,
      cueCount: 1,
      firstFrame: item.from,
      lastFrame: item.from + item.durationInFrames,
    }
  }
  if ((item.type === 'video' || item.type === 'audio') && item.transcriptCaptions) {
    return {
      sourceType: item.transcriptCaptions.type,
      mediaId: item.transcriptCaptions.mediaId,
      enabled: item.transcriptCaptions.enabled,
      cueCount: item.transcriptCaptions.cues.length,
      firstFrame: item.from,
      lastFrame: item.from + item.durationInFrames,
    }
  }
  return null
}

function projectTimelineProjection(): {
  timeline: CloudCompositeSnapshot['timeline']
  captions: CloudCompositeSnapshot['captions']
  privateTimelineFingerprint: unknown
  privateCaptionFingerprint: unknown
} {
  const itemsState = useItemsStore.getState()
  const settings = useTimelineSettingsStore.getState()
  const compositions = useSequencesStore.getState()
  const transitions = useTransitionsStore.getState()
  const keyframes = useKeyframesStore.getState()
  const timelineStore = useTimelineStore.getState()
  const allItems = [...itemsState.items].sort((left, right) => left.id.localeCompare(right.id))
  const tracks = [...itemsState.tracks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((track) => ({
      id: track.id,
      kind: track.kind ?? null,
      order: track.order,
      locked: track.locked,
      syncLock: track.syncLock ?? true,
      visible: track.visible,
      muted: track.muted,
      solo: track.solo,
      volume: numberOrNull(track.volume),
      itemIds: allItems.filter((item) => item.trackId === track.id).map((item) => item.id),
    }))
  const items = allItems.map((item) => {
    const caption = captionProjection(item)
    return {
      id: item.id,
      type: item.type,
      trackId: item.trackId,
      from: item.from,
      durationInFrames: item.durationInFrames,
      endFrame: item.from + item.durationInFrames,
      mediaId: stringOrNull(item.mediaId),
      originId: stringOrNull(item.originId),
      linkedGroupId: stringOrNull(item.linkedGroupId),
      sourceStart: numberOrNull(item.sourceStart),
      sourceEnd: numberOrNull(item.sourceEnd),
      sourceDuration: numberOrNull(item.sourceDuration),
      sourceFps: numberOrNull(item.sourceFps),
      speed: item.speed ?? 1,
      isReversed: item.isReversed ?? false,
      embeddedAudioMuted: item.type === 'video' ? (item.embeddedAudioMuted ?? false) : null,
      role: itemRole(item),
      effectCount: item.effects?.length ?? 0,
      motionModifierCount: item.motionModifiers?.length ?? 0,
      keyframeCount: 0,
      captionSource: caption?.sourceType ?? null,
      captionCueCount: caption?.cueCount ?? 0,
      audio:
        item.type === 'video' || item.type === 'audio'
          ? {
              volume: numberOrNull(item.volume),
              fadeIn: item.audioFadeIn ?? 0,
              fadeOut: item.audioFadeOut ?? 0,
            }
          : null,
    }
  })
  const keyframeCountByItem = new Map<string, number>()
  for (const keyframe of keyframes.keyframes) {
    keyframeCountByItem.set(
      keyframe.itemId,
      keyframe.properties.reduce((count, property) => count + property.keyframes.length, 0),
    )
  }
  for (const item of items) {
    item.keyframeCount = keyframeCountByItem.get(item.id) ?? 0
  }
  const captions = allItems
    .map((item) => {
      const projection = captionProjection(item)
      return projection ? { itemId: item.id, ...projection } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
  const timeline = {
    fps: settings.fps,
    durationFrames: allItems.reduce(
      (max, item) => Math.max(max, item.from + item.durationInFrames),
      0,
    ),
    trackCount: tracks.length,
    itemCount: items.length,
    textCount: items.filter((item) => item.type === 'text').length,
    inPoint: timelineStore.inPoint ?? null,
    outPoint: timelineStore.outPoint ?? null,
    tracks,
    items,
    transitionCount: transitions.transitions.length,
    keyframeCount: [...keyframeCountByItem.values()].reduce(
      (count, itemCount) => count + itemCount,
      0,
    ),
    markerCount: timelineStore.markers.length,
    compositionIds: [],
    topLevelSequenceIds: [...compositions.topLevelSequenceIds].sort(),
  } satisfies CloudCompositeSnapshot['timeline']
  return {
    timeline,
    captions: {
      sourceCount: captions.length,
      sources: captions,
    },
    privateTimelineFingerprint: {
      timeline,
      items: allItems.map(semanticItemFingerprintInput),
      transitions: transitions.transitions,
      keyframes: keyframes.keyframes,
      markers: timelineStore.markers.map(({ id, frame, color }) => ({ id, frame, color })),
      compositions: captureSnapshot().compositions.map((composition) => ({
        ...composition,
        name: undefined,
        items: composition.items.map(semanticItemFingerprintInput),
        tracks: composition.tracks.map(({ name: _name, ...track }) => track),
      })),
      busAudioEq: usePlaybackStore.getState().busAudioEq,
      masterBusDb: usePlaybackStore.getState().masterBusDb,
    },
    privateCaptionFingerprint: allItems
      .filter((item) => captionProjection(item))
      .map((item) => {
        const projection = captionProjection(item)!
        return {
          id: item.id,
          text:
            item.type === 'subtitle'
              ? item.cues.map((cue) => [cue.id, cue.startSeconds, cue.endSeconds, cue.text])
              : item.type === 'text'
                ? item.text
                : item.type === 'video' || item.type === 'audio'
                  ? item.transcriptCaptions?.cues.map((cue) => [
                      cue.id,
                      cue.startSeconds,
                      cue.endSeconds,
                      cue.text,
                    ])
                  : null,
          projection,
        }
      }),
  }
}

function projectAssetProjection(): {
  assets: CloudCompositeSnapshot['assets']
  privateAssetFingerprint: unknown
} {
  const store = useMediaLibraryStore.getState()
  const importing = new Set(store.importingIds)
  const readiness = store.mediaItems
    .map((media) => ({
      id: media.id,
      transcriptStatus: store.transcriptStatus.get(media.id) ?? 'unknown',
      broken: store.brokenMediaInfo.get(media.id)?.errorType ?? null,
      importing: importing.has(media.id),
      proxy: store.proxyStatus.get(media.id) ?? null,
      interpolation: store.interpolationStatus.get(media.id) ?? null,
      upscale: store.upscaleStatus.get(media.id) ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    assets: { mediaCount: readiness.length, readiness },
    privateAssetFingerprint: {
      readiness,
      metadata: store.mediaItems
        .map((media) => ({
          id: media.id,
          duration: media.duration,
          width: media.width,
          height: media.height,
          fps: media.fps,
          codec: media.codec,
          audioCodec: media.audioCodec,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  }
}

export function captureCloudCompositeSnapshot(projectId?: string | null): CloudCompositeSnapshot {
  const project = useProjectStore.getState().currentProject
  const timelineProjection = projectTimelineProjection()
  const assetProjection = projectAssetProjection()
  const commandHistory = useTimelineCommandStore.getState()
  const navigation = useCompositionNavigationStore.getState()
  const settings = useTimelineSettingsStore.getState()
  const playback = usePlaybackStore.getState()
  const editor = useEditorStore.getState()
  const selection = useSelectionStore.getState()
  const resolvedProjectId = projectId ?? project?.id ?? null
  const semanticRuntime = {
    activeSequenceId: navigation.activeCompositionId ?? null,
    undoDepth: commandHistory.undoStack.length,
    redoDepth: commandHistory.redoStack.length,
  }
  const timelineFingerprint = fingerprint(timelineProjection.privateTimelineFingerprint)
  const captionsFingerprint = fingerprint(timelineProjection.privateCaptionFingerprint)
  const assetsFingerprint = fingerprint(assetProjection.privateAssetFingerprint)
  const compositeFingerprint = fingerprint({
    timeline: timelineFingerprint,
    captions: captionsFingerprint,
    assets: assetsFingerprint,
    runtime: semanticRuntime,
  })
  return {
    schema: CLOUD_COMPOSITE_SNAPSHOT_SCHEMA,
    fingerprintVersion: CLOUD_COMPOSITE_FINGERPRINT_VERSION,
    projectId: resolvedProjectId,
    projectRevision: project?.updatedAt ?? null,
    capturedAt: Date.now(),
    hash: compositeFingerprint,
    timeline: timelineProjection.timeline,
    captions: timelineProjection.captions,
    assets: assetProjection.assets,
    runtime: {
      dirty: settings.isDirty,
      loading: settings.isTimelineLoading,
      activeSequenceId: semanticRuntime.activeSequenceId,
      undoDepth: semanticRuntime.undoDepth,
      redoDepth: semanticRuntime.redoDepth,
      currentFrame: playback.currentFrame,
      selectedItemIds: [...selection.selectedItemIds].sort(),
      linkedSelectionEnabled: editor.linkedSelectionEnabled,
    },
    history: {
      undoCount: commandHistory.undoStack.length,
      redoCount: commandHistory.redoStack.length,
      undoLabel: commandHistory.getUndoLabel(),
      redoLabel: commandHistory.getRedoLabel(),
    },
    fingerprints: {
      timeline: timelineFingerprint,
      captions: captionsFingerprint,
      assets: assetsFingerprint,
      composite: compositeFingerprint,
    },
  }
}

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openSnapshotDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开快照存储。'))
  })
}

function readCurrentSnapshotIds(): void {
  const stored = localStorage.getItem(CURRENT_SNAPSHOT_STORAGE_KEY)
  if (!stored) return

  const parsed = JSON.parse(stored) as Record<string, string>
  for (const [projectId, snapshotId] of Object.entries(parsed)) {
    if (snapshotId) currentSnapshotByProject.set(projectId, snapshotId)
  }
}

function persistCurrentSnapshotIds(): void {
  localStorage.setItem(
    CURRENT_SNAPSHOT_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(currentSnapshotByProject.entries())),
  )
}

async function persistSnapshot(
  id: string,
  projectId: string,
  snapshot: LocalTimelineSnapshot,
  composite: CloudCompositeSnapshot,
) {
  const entry: PersistedSnapshot = {
    id,
    projectId,
    snapshot,
    composite,
    createdAt: Date.now(),
  }

  if (canUseIndexedDb()) {
    try {
      const db = await openSnapshotDb()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(SNAPSHOT_STORE_NAME, 'readwrite')
        transaction.objectStore(SNAPSHOT_STORE_NAME).put(entry)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('无法保存快照。'))
      })
      db.close()
      return
    } catch {
      // Fall through to the small local-storage fallback below.
    }
  }

  localStorage.setItem(`freecut:cloud-bridge-snapshot:${id}`, JSON.stringify(entry))
}

async function loadPersistedSnapshotEntry(snapshotId: string): Promise<PersistedSnapshot | null> {
  if (canUseIndexedDb()) {
    try {
      const db = await openSnapshotDb()
      const entry = await new Promise<PersistedSnapshot | undefined>((resolve, reject) => {
        const request = db
          .transaction(SNAPSHOT_STORE_NAME, 'readonly')
          .objectStore(SNAPSHOT_STORE_NAME)
          .get(snapshotId)
        request.onsuccess = () => resolve(request.result as PersistedSnapshot | undefined)
        request.onerror = () => reject(request.error ?? new Error('无法读取快照。'))
      })
      db.close()
      if (entry?.snapshot) return entry
    } catch {
      // Try the fallback below.
    }
  }

  const stored = localStorage.getItem(`freecut:cloud-bridge-snapshot:${snapshotId}`)
  if (!stored) return null
  return JSON.parse(stored) as PersistedSnapshot
}

async function deletePersistedSnapshot(snapshotId: string): Promise<void> {
  if (canUseIndexedDb()) {
    try {
      const db = await openSnapshotDb()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(SNAPSHOT_STORE_NAME, 'readwrite')
        transaction.objectStore(SNAPSHOT_STORE_NAME).delete(snapshotId)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('无法删除快照。'))
      })
      db.close()
    } catch {
      // The fallback cleanup still runs.
    }
  }

  localStorage.removeItem(`freecut:cloud-bridge-snapshot:${snapshotId}`)
}

function pruneSnapshots(): void {
  while (snapshots.size > MAX_SNAPSHOTS) {
    const protectedIds = new Set(currentSnapshotByProject.values())
    const oldest = [...snapshots.keys()].find((snapshotId) => !protectedIds.has(snapshotId))
    if (!oldest) return
    snapshots.delete(oldest)
    compositeSnapshots.delete(oldest)
    pendingSnapshotWrites.delete(oldest)
    void deletePersistedSnapshot(oldest)
  }
}

if (typeof window !== 'undefined') {
  readCurrentSnapshotIds()
}

export function captureCloudSnapshot(projectId: string): string {
  const snapshotId = `local:${projectId}:${crypto.randomUUID()}`
  const snapshot = captureSnapshot()
  const composite = captureCloudCompositeSnapshot(projectId)
  snapshots.set(snapshotId, snapshot)
  compositeSnapshots.set(snapshotId, composite)
  currentSnapshotByProject.set(projectId, snapshotId)
  persistCurrentSnapshotIds()
  const pending = persistSnapshot(snapshotId, projectId, snapshot, composite).finally(() => {
    pendingSnapshotWrites.delete(snapshotId)
  })
  pendingSnapshotWrites.set(snapshotId, pending)
  pruneSnapshots()
  return snapshotId
}

export function getCurrentCloudSnapshotId(projectId: string): string {
  const currentId = currentSnapshotByProject.get(projectId)
  const currentComposite = currentId ? compositeSnapshots.get(currentId) : undefined
  const liveComposite = captureCloudCompositeSnapshot(projectId)
  if (
    currentId &&
    currentComposite?.fingerprints.composite === liveComposite.fingerprints.composite
  ) {
    return currentId
  }
  return captureCloudSnapshot(projectId)
}

export async function waitForCloudSnapshotPersistence(snapshotId: string): Promise<void> {
  await pendingSnapshotWrites.get(snapshotId)
}

export async function readCloudSnapshotComposite(
  snapshotId: string,
): Promise<CloudCompositeSnapshot | null> {
  const current = compositeSnapshots.get(snapshotId)
  if (current) return current
  const entry = await loadPersistedSnapshotEntry(snapshotId)
  if (!entry?.composite) return null
  compositeSnapshots.set(snapshotId, entry.composite)
  return entry.composite
}
