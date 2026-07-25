import { z } from 'zod'
import {
  importMediaLibraryService,
  resolveMediaUrl,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import {
  buildDroppedMediaEntriesFromImportedMedia,
  buildDroppedMediaTimelineItems,
  executeTimelineCommand,
  getDroppedMediaDurationInFrames,
  planTrackMediaDropPlacements,
  resolveSourceEditTrackTargets,
  useItemsStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { usePlaybackStore } from '@/shared/state/playback'
import { useSelectionStore } from '@/shared/state/selection'
import { DEFAULT_PROJECT_HEIGHT, DEFAULT_PROJECT_WIDTH } from '@/shared/projects/defaults'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem, TimelineTrack } from '@/types/timeline'
import { definePlatformTool, objectSchema } from './shared'

type ImportedMediaEntry = ReturnType<typeof buildDroppedMediaEntriesFromImportedMedia>[number]
type PlannedItem = ReturnType<typeof planTrackMediaDropPlacements>['plannedItems'][number]

function resolvePlacements(planned: PlannedItem) {
  const primary =
    planned.placements.find((placement) => placement.mediaType !== 'audio') ??
    planned.placements[0]
  if (!primary) return null
  return {
    primary,
    linkedAudio: planned.placements.find(
      (placement) => placement.mediaType === 'audio' && placement.trackId !== primary.trackId,
    ),
  }
}

function applyLayout(
  items: TimelineItem[],
  layout: 'default' | 'cover' | 'contain' | 'pip',
  canvasWidth: number,
  canvasHeight: number,
): TimelineItem[] {
  if (layout === 'default') return items
  return items.map((item) => {
    if (item.type === 'audio') return item
    const sourceWidth = 'sourceWidth' in item ? (item.sourceWidth ?? canvasWidth) : canvasWidth
    const sourceHeight = 'sourceHeight' in item ? (item.sourceHeight ?? canvasHeight) : canvasHeight
    const scale =
      layout === 'cover'
        ? Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
        : layout === 'contain'
          ? Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
          : Math.min((canvasWidth * 0.32) / sourceWidth, (canvasHeight * 0.32) / sourceHeight)
    const width = sourceWidth * scale
    const height = sourceHeight * scale
    const margin = Math.min(canvasWidth, canvasHeight) * 0.04
    return {
      ...item,
      transform: {
        ...item.transform,
        width,
        height,
        x: layout === 'pip' ? (canvasWidth - width) / 2 - margin : 0,
        y: layout === 'pip' ? (canvasHeight - height) / 2 - margin : 0,
      },
    }
  })
}

async function placeMediaEntries(params: {
  media: MediaMetadata[]
  atSeconds?: number
  trackId?: string
  layout: 'default' | 'cover' | 'contain' | 'pip'
}): Promise<{ items: TimelineItem[]; tracks: TimelineTrack[] }> {
  const entries = buildDroppedMediaEntriesFromImportedMedia(params.media)
  if (entries.length === 0) throw new Error('No supported media can be placed.')

  const timeline = useTimelineStore.getState()
  const project = useProjectStore.getState().currentProject
  const canvasWidth = project?.metadata.width ?? DEFAULT_PROJECT_WIDTH
  const canvasHeight = project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT
  const activeTrackId = params.trackId ?? useSelectionStore.getState().activeTrackId
  let tracks = timeline.tracks
  const workingItems = [...timeline.items]
  const createdItems: TimelineItem[] = []
  let cursor =
    params.atSeconds === undefined
      ? usePlaybackStore.getState().currentFrame
      : Math.round(params.atSeconds * timeline.fps)

  for (const entry of entries) {
    const referenceTrack = tracks.find((track) => track.id === activeTrackId)
    const hasAudio = entry.mediaType === 'video' && !!entry.media.audioCodec
    const targets = resolveSourceEditTrackTargets({
      tracks,
      activeTrackId,
      mediaType: entry.mediaType,
      hasAudio,
      patchVideo: true,
      patchAudio: true,
      preferredTrackHeight: referenceTrack?.height ?? 64,
    })
    if (!targets) throw new Error(`No compatible track is available for ${entry.label}.`)
    tracks = targets.tracks
    const targetTrackId =
      entry.mediaType === 'audio' ? targets.audioTrackId : targets.videoTrackId
    if (!targetTrackId) throw new Error(`No target track is available for ${entry.label}.`)

    const durationInFrames = getDroppedMediaDurationInFrames(
      entry.media,
      entry.mediaType,
      timeline.fps,
    )
    const plan = planTrackMediaDropPlacements({
      entries: [
        {
          payload: entry as ImportedMediaEntry,
          label: entry.label,
          mediaType: entry.mediaType,
          durationInFrames,
          hasLinkedAudio: hasAudio,
        },
      ],
      dropFrame: cursor,
      tracks,
      existingItems: workingItems,
      dropTargetTrackId: targetTrackId,
    })
    const planned = plan.plannedItems[0]
    if (!planned) throw new Error(`Could not plan placement for ${entry.label}.`)
    tracks = plan.tracks
    const placement = resolvePlacements(planned)
    if (!placement) throw new Error(`Could not resolve placement for ${entry.label}.`)
    const blobUrl = await resolveMediaUrl(entry.mediaId)
    if (!blobUrl) throw new Error(`Could not resolve media source ${entry.mediaId}.`)

    const nextItems = applyLayout(
      buildDroppedMediaTimelineItems({
        media: entry.media,
        mediaId: entry.mediaId,
        mediaType: entry.mediaType,
        label: entry.label,
        timelineFps: timeline.fps,
        blobUrl,
        thumbnailUrl: null,
        canvasWidth,
        canvasHeight,
        placement: {
          primary: placement.primary,
          linkedAudio: placement.linkedAudio,
        },
        linkVideoAudio: planned.linkVideoAudio,
      }),
      params.layout,
      canvasWidth,
      canvasHeight,
    )
    workingItems.push(...nextItems)
    createdItems.push(...nextItems)
    cursor = placement.primary.from + placement.primary.durationInFrames
  }

  executeTimelineCommand(
    'AGENT_PLACE_MEDIA',
    () => {
      const store = useItemsStore.getState()
      store.setTracks(tracks)
      store._addItems(createdItems)
      useTimelineSettingsStore.getState().markDirty()
    },
    { mediaIds: params.media.map((media) => media.id), itemCount: createdItems.length },
  )
  useSelectionStore.getState().selectItems(createdItems.map((item) => item.id))
  return { items: createdItems, tracks }
}

const placeMedia = definePlatformTool({
  name: 'place_media',
  title: 'Place media on timeline',
  description:
    'Place existing media-library items sequentially at an exact time and track with default, cover, contain, or picture-in-picture layout.',
  inputSchema: objectSchema(
    {
      mediaIds: { type: 'array', items: { type: 'string' } },
      atSeconds: { type: 'number', minimum: 0 },
      trackId: { type: 'string' },
      layout: { type: 'string', enum: ['default', 'cover', 'contain', 'pip'] },
    },
    ['mediaIds'],
  ),
  schema: z.object({
    mediaIds: z.array(z.string()).min(1),
    atSeconds: z.number().min(0).optional(),
    trackId: z.string().min(1).optional(),
    layout: z.enum(['default', 'cover', 'contain', 'pip']).optional(),
  }),
  summarize: ({ mediaIds }) =>
    `Place ${mediaIds.length} media item${mediaIds.length === 1 ? '' : 's'}`,
  execute: async ({ mediaIds, atSeconds, trackId, layout = 'default' }) => {
    const store = useMediaLibraryStore.getState()
    const missingIds = mediaIds.filter((id) => !store.mediaById[id])
    const { mediaLibraryService } = await importMediaLibraryService()
    const resolved = await Promise.all(
      mediaIds.map(async (id) => store.mediaById[id] ?? (await mediaLibraryService.getMedia(id))),
    )
    const media = resolved.filter((entry): entry is MediaMetadata => !!entry)
    if (media.length !== mediaIds.length) {
      throw new Error(`Media not found: ${missingIds.join(', ')}`)
    }
    const placed = await placeMediaEntries({ media, atSeconds, trackId, layout })
    return {
      ok: true,
      message: `Placed ${placed.items.length} timeline item${placed.items.length === 1 ? '' : 's'} from ${media.length} media source${media.length === 1 ? '' : 's'}.`,
      data: {
        mediaIds,
        itemIds: placed.items.map((item) => item.id),
        trackIds: [...new Set(placed.items.map((item) => item.trackId))],
        layout,
      },
      changed: true,
    }
  },
})

const importMediaUrl = definePlatformTool({
  name: 'import_media_url',
  title: 'Import media URL',
  description:
    'Import a direct CORS-enabled media URL into the project media library and optionally place it on the timeline.',
  inputSchema: objectSchema(
    {
      url: { type: 'string' },
      place: { type: 'boolean' },
      atSeconds: { type: 'number', minimum: 0 },
      trackId: { type: 'string' },
      layout: { type: 'string', enum: ['default', 'cover', 'contain', 'pip'] },
    },
    ['url'],
  ),
  schema: z.object({
    url: z.string().url(),
    place: z.boolean().optional(),
    atSeconds: z.number().min(0).optional(),
    trackId: z.string().min(1).optional(),
    layout: z.enum(['default', 'cover', 'contain', 'pip']).optional(),
  }),
  summarize: () => 'Import media from URL',
  execute: async ({ url, place = false, atSeconds, trackId, layout = 'default' }) => {
    const media = await useMediaLibraryStore.getState().importMediaFromUrl(url)
    if (media.length === 0) throw new Error('The URL did not produce an imported media item.')
    const placed = place
      ? await placeMediaEntries({ media, atSeconds, trackId, layout })
      : { items: [] as TimelineItem[], tracks: useTimelineStore.getState().tracks }
    return {
      ok: true,
      message: `Imported ${media.length} media item${media.length === 1 ? '' : 's'}${place ? ` and placed ${placed.items.length} timeline item${placed.items.length === 1 ? '' : 's'}` : ''}.`,
      data: {
        mediaIds: media.map((entry) => entry.id),
        itemIds: placed.items.map((item) => item.id),
      },
      changed: true,
    }
  },
})

export const MEDIA_PLATFORM_TOOLS = [placeMedia, importMediaUrl] as const
