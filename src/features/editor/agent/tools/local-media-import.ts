import { useMediaLibraryStore, resolveMediaUrl } from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import { useTimelineStore } from '@/features/editor/deps/timeline-store'
import {
  buildDroppedMediaEntriesFromImportedMedia,
  buildDroppedMediaTimelineItems,
  getDroppedMediaDurationInFrames,
  planTrackMediaDropPlacements,
  resolveSourceEditTrackTargets,
} from '@/features/editor/deps/timeline-utils'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import type { MediaMetadata } from '@/types/storage'

export interface ImportLocalMediaResult {
  importedCount: number
  placedCount: number
}

type ImportedMediaEntry = ReturnType<typeof buildDroppedMediaEntriesFromImportedMedia>[number]

interface PlaceImportedMediaEntryResult {
  items: TimelineItem[]
  tracks: TimelineTrack[]
  nextCursor: number
}

export async function importLocalMediaToLibrary(
  path: string,
  storageMode: 'copy' | 'link' = 'copy',
  recursive = false,
): Promise<MediaMetadata[]> {
  const handles = recursive
    ? await getDevLocalMediaHandles(path, { recursive: true })
    : await getDevLocalMediaHandles(path)
  if (handles.length === 0) {
    throw new Error('The local path contains no files.')
  }
  return useMediaLibraryStore.getState().importHandles(handles, { storageMode })
}

function resolveEntryTargets(params: {
  entry: ImportedMediaEntry
  tracks: TimelineTrack[]
  activeTrackId: string | null
}): {
  hasAudio: boolean
  targetTrackId: string
  tracks: TimelineTrack[]
} | null {
  const hasAudio = params.entry.mediaType === 'video' && !!params.entry.media.audioCodec
  const referenceTrack = params.tracks.find((track) => track.id === params.activeTrackId)
  const targets = resolveSourceEditTrackTargets({
    tracks: params.tracks,
    activeTrackId: params.activeTrackId,
    mediaType: params.entry.mediaType,
    hasAudio,
    patchVideo: true,
    patchAudio: true,
    preferredTrackHeight: referenceTrack?.height ?? 64,
  })
  if (!targets) return null

  const targetTrackId =
    params.entry.mediaType === 'audio' ? targets.audioTrackId : targets.videoTrackId
  return targetTrackId ? { hasAudio, targetTrackId, tracks: targets.tracks } : null
}

type PlannedPlacement = ReturnType<typeof planTrackMediaDropPlacements>['plannedItems'][number]

function resolvePlannedPlacements(planned: PlannedPlacement): {
  primary: PlannedPlacement['placements'][number]
  linkedAudio: PlannedPlacement['placements'][number] | undefined
} | null {
  const primary =
    planned.placements.find((placement) => placement.mediaType !== 'audio') ?? planned.placements[0]
  if (!primary) return null

  return {
    primary,
    linkedAudio: planned.placements.find(
      (placement) => placement.mediaType === 'audio' && placement.trackId !== primary.trackId,
    ),
  }
}

async function placeImportedMediaEntry(params: {
  entry: ImportedMediaEntry
  tracks: TimelineTrack[]
  items: TimelineItem[]
  activeTrackId: string | null
  cursor: number
  fps: number
  canvasWidth: number
  canvasHeight: number
}): Promise<PlaceImportedMediaEntryResult | null> {
  const { entry } = params
  const target = resolveEntryTargets({
    entry,
    tracks: params.tracks,
    activeTrackId: params.activeTrackId,
  })
  if (!target) return null

  const durationInFrames = getDroppedMediaDurationInFrames(entry.media, entry.mediaType, params.fps)
  const dropPlan = planTrackMediaDropPlacements({
    entries: [
      {
        payload: entry,
        label: entry.label,
        mediaType: entry.mediaType,
        durationInFrames,
        hasLinkedAudio: target.hasAudio,
      },
    ],
    dropFrame: params.cursor,
    tracks: target.tracks,
    existingItems: params.items,
    dropTargetTrackId: target.targetTrackId,
  })
  const planned = dropPlan.plannedItems[0]
  if (!planned) return null

  const blobUrl = await resolveMediaUrl(entry.mediaId)
  if (!blobUrl) return null

  const placements = resolvePlannedPlacements(planned)
  if (!placements) return null
  const items = buildDroppedMediaTimelineItems({
    media: entry.media,
    mediaId: entry.mediaId,
    mediaType: entry.mediaType,
    label: entry.label,
    timelineFps: params.fps,
    blobUrl,
    thumbnailUrl: null,
    canvasWidth: params.canvasWidth,
    canvasHeight: params.canvasHeight,
    placement: {
      primary: placements.primary,
      linkedAudio: placements.linkedAudio,
    },
    linkVideoAudio: planned.linkVideoAudio,
  })

  return {
    items,
    tracks: dropPlan.tracks,
    nextCursor: placements.primary.from + placements.primary.durationInFrames,
  }
}

export async function importLocalMediaToTimeline(
  path: string,
  atSeconds?: number,
  recursive = false,
): Promise<ImportLocalMediaResult> {
  const handles = recursive
    ? await getDevLocalMediaHandles(path, { recursive: true })
    : await getDevLocalMediaHandles(path)
  if (handles.length === 0) {
    throw new Error('The local path contains no files.')
  }

  const importedMedia = await useMediaLibraryStore.getState().importHandlesForPlacement(handles)
  const entries = buildDroppedMediaEntriesFromImportedMedia(importedMedia)
  if (entries.length === 0) {
    throw new Error('No supported media files could be imported from that path.')
  }

  const timeline = useTimelineStore.getState()
  const { activeTrackId, selectItems } = useSelectionStore.getState()
  const project = useProjectStore.getState().currentProject
  const canvasWidth = project?.metadata.width ?? DEFAULT_PROJECT_WIDTH
  const canvasHeight = project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT
  let workingTracks = timeline.tracks
  const workingItems: TimelineItem[] = [...timeline.items]
  const createdItems: TimelineItem[] = []
  let cursor =
    atSeconds === undefined
      ? usePlaybackStore.getState().currentFrame
      : Math.round(atSeconds * timeline.fps)

  for (const entry of entries) {
    const placed = await placeImportedMediaEntry({
      entry,
      tracks: workingTracks,
      items: workingItems,
      activeTrackId,
      cursor,
      fps: timeline.fps,
      canvasWidth,
      canvasHeight,
    })
    if (!placed) continue

    workingTracks = placed.tracks
    workingItems.push(...placed.items)
    createdItems.push(...placed.items)
    cursor = placed.nextCursor
  }

  if (createdItems.length === 0) {
    throw new Error('The media was imported, but no compatible timeline placement was available.')
  }

  if (workingTracks !== timeline.tracks) {
    timeline.setTracks(workingTracks)
  }
  timeline.addItems(createdItems)
  selectItems(createdItems.map((item) => item.id))

  return {
    importedCount: entries.length,
    placedCount: createdItems.length,
  }
}
