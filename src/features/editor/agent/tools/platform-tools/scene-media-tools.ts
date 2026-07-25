import { z } from 'zod'
import {
  buildCaptionTrack,
  buildSubtitleSegmentForClip,
  findCompatibleCaptionTrackForRanges,
  resolveMediaUrl,
  subtitleSidecarService,
  useMediaLibraryStore,
} from '@/features/editor/deps/media-library'
import { useProjectStore } from '@/features/editor/deps/projects'
import {
  parseColorQuery,
  rankScenes,
  rankScenesByPalette,
} from '@/features/editor/deps/scene-browser-contract'
import {
  executeTimelineCommand,
  useItemsStore,
  useTimelineSettingsStore,
  useTimelineStore,
} from '@/features/editor/deps/timeline-contract'
import { useEditorStore } from '@/features/editor/stores/editor-store'
import { detectScenes } from '@/infrastructure/analysis/scene-detection'
import { getDevLocalMediaHandles } from '@/infrastructure/storage/dev-workspace-handle'
import { saveScenes } from '@/infrastructure/storage/workspace-fs/scenes'
import { useSourcePlayerStore } from '@/shared/state/source-player'
import {
  inferSubtitleFormat,
  parseSrt,
  parseVtt,
  type SubtitleFormat,
} from '@/shared/utils/subtitles'
import { definePlatformTool, objectSchema, resolveItemHandles } from './shared'

type RankableScene = Parameters<typeof rankScenes>[1][number]

const paletteEntrySchema = z.object({
  l: z.number(),
  a: z.number(),
  b: z.number(),
  weight: z.number().positive(),
})

async function ensureOpenProjectMedia() {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('Open the target project first.')

  const store = useMediaLibraryStore.getState()
  if (store.currentProjectId !== project.id) {
    store.setCurrentProject(project.id)
    await useMediaLibraryStore.getState().loadMediaItems()
  }

  return {
    project,
    media: useMediaLibraryStore.getState().mediaItems,
  }
}

function waitForVideoMetadata(video: HTMLVideoElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video for scene detection.'))
    video.src = url
    video.load()
  })
}

async function resolveSubtitleFile(path: string): Promise<{
  file: File
  format: SubtitleFormat
}> {
  const handles = await getDevLocalMediaHandles(path)
  const supported = handles.filter((handle) => inferSubtitleFormat(handle.name) !== null)
  if (supported.length !== 1) {
    throw new Error(
      supported.length === 0
        ? `No SRT or VTT subtitle file was found at ${path}.`
        : `The path contains multiple SRT/VTT subtitle files: ${path}`,
    )
  }
  const file = await supported[0]!.getFile()
  const format = inferSubtitleFormat(file.name)
  if (!format) throw new Error(`Unsupported subtitle file: ${file.name}`)
  return { file, format }
}

const searchScenes = definePlatformTool({
  name: 'search_scenes',
  title: 'Search scenes',
  description:
    'Search existing media AI captions by text, color intent, or a reference palette without running new analysis.',
  inputSchema: objectSchema({
    query: { type: 'string' },
    mediaIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    referencePalette: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          l: { type: 'number' },
          a: { type: 'number' },
          b: { type: 'number' },
          weight: { type: 'number', exclusiveMinimum: 0 },
        },
        required: ['l', 'a', 'b', 'weight'],
        additionalProperties: false,
      },
    },
    threshold: { type: 'number', minimum: 0, maximum: 1 },
    limit: { type: 'number', minimum: 1, maximum: 200 },
  }),
  readOnly: true,
  schema: z.object({
    query: z.string().optional(),
    mediaIds: z.array(z.string().min(1)).min(1).optional(),
    referencePalette: z.array(paletteEntrySchema).min(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  summarize: ({ query }) => `Search scenes${query ? ` for "${query}"` : ''}`,
  execute: async ({ query = '', mediaIds, referencePalette, threshold, limit = 50 }) => {
    const { project, media } = await ensureOpenProjectMedia()
    const mediaById = new Map(media.map((entry) => [entry.id, entry]))
    const missingMediaIds = (mediaIds ?? []).filter((mediaId) => !mediaById.has(mediaId))
    if (missingMediaIds.length > 0) {
      throw new Error(`Media not found: ${missingMediaIds.join(', ')}`)
    }

    const scopedMedia = mediaIds ? mediaIds.map((mediaId) => mediaById.get(mediaId)!) : media
    const scenes: RankableScene[] = []
    let clipsWithCaptions = 0
    for (const entry of scopedMedia) {
      if (!entry.aiCaptions || entry.aiCaptions.length === 0) continue
      clipsWithCaptions += 1
      entry.aiCaptions.forEach((caption, index) => {
        scenes.push({
          id: `${entry.id}:${index}`,
          mediaId: entry.id,
          mediaFileName: entry.fileName,
          timeSec: caption.timeSec,
          text: caption.text,
          thumbRelPath: caption.thumbRelPath,
          palette: caption.palette,
        })
      })
    }

    const colorQuery = parseColorQuery(query)
    const paletteSearch = referencePalette !== undefined || colorQuery.paletteOnly
    const ranked = paletteSearch
      ? rankScenesByPalette(scenes, {
          query,
          referencePalette: referencePalette ?? null,
        })
      : rankScenes(query, scenes, { threshold })

    if (!query.trim() && !referencePalette) {
      ranked.sort((left, right) => {
        if (left.mediaFileName !== right.mediaFileName) {
          return left.mediaFileName.localeCompare(right.mediaFileName)
        }
        return left.timeSec - right.timeSec
      })
    }

    const matches = ranked.slice(0, limit)
    return {
      ok: true,
      message: `Found ${ranked.length} matching scene${ranked.length === 1 ? '' : 's'}.`,
      data: {
        projectId: project.id,
        query,
        ranker: paletteSearch ? 'palette' : 'keyword',
        totalScenes: scenes.length,
        clipsWithCaptions,
        totalMatches: ranked.length,
        truncated: ranked.length > matches.length,
        matches,
      },
      changed: false,
    }
  },
})

const detectAndSplitScenes = definePlatformTool({
  name: 'detect_and_split_scenes',
  title: 'Detect and split scenes',
  description:
    'Detect source-video scene cuts, persist the analysis cache, and split one timeline clip at valid cut points.',
  destructive: true,
  inputSchema: objectSchema(
    {
      item: { type: 'string' },
      method: { type: 'string', enum: ['histogram', 'optical-flow'] },
      sampleIntervalMs: { type: 'number', minimum: 50, maximum: 10000 },
    },
    ['item'],
  ),
  schema: z.object({
    item: z.string().min(1),
    method: z.enum(['histogram', 'optical-flow']).optional(),
    sampleIntervalMs: z.number().int().min(50).max(10000).optional(),
  }),
  summarize: ({ item }) => `Detect and split scenes in ${item}`,
  execute: async ({ item: handle, method = 'histogram', sampleIntervalMs }) => {
    const { project, media } = await ensureOpenProjectMedia()
    const [clip] = resolveItemHandles([handle], {
      allowSelection: false,
      itemTypes: ['video'],
    })
    if (!clip || clip.type !== 'video') throw new Error(`Video clip not found: ${handle}`)
    if (!clip.mediaId) throw new Error(`Video clip has no media id: ${clip.id}`)

    const sourceMedia = media.find((entry) => entry.id === clip.mediaId)
    if (!sourceMedia) throw new Error(`Media not found: ${clip.mediaId}`)

    const timeline = useTimelineStore.getState()
    const interval = sampleIntervalMs ?? (method === 'histogram' ? 250 : 500)
    const mediaFps = clip.sourceFps ?? sourceMedia.fps ?? timeline.fps
    const sourceFps = clip.sourceFps ?? mediaFps
    const sourceStartSeconds = (clip.sourceStart ?? 0) / sourceFps
    const speed = clip.speed ?? 1
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'

    try {
      const url = await resolveMediaUrl(sourceMedia.id)
      await waitForVideoMetadata(video, url)
      const cuts = await detectScenes(video, mediaFps, {
        method,
        sampleIntervalMs: interval,
        mediaId: sourceMedia.id,
      })
      await saveScenes({
        mediaId: sourceMedia.id,
        service: method === 'histogram' ? 'scene-detect-histogram' : 'scene-detect-optical-flow',
        model: method,
        method,
        sampleIntervalMs: interval,
        fps: mediaFps,
        cuts,
      })

      const clipEnd = clip.from + clip.durationInFrames
      const splitFrames = [
        ...new Set(
          cuts
            .map(
              (cut) =>
                clip.from + Math.round(((cut.time - sourceStartSeconds) * timeline.fps) / speed),
            )
            .filter((frame) => frame > clip.from && frame < clipEnd),
        ),
      ].sort((left, right) => left - right)
      const splitCount = timeline.splitItemAtFrames(clip.id, splitFrames)
      const changed = splitCount > 0
      if (changed) {
        await useTimelineStore.getState().saveTimeline(project.id)
      }

      return {
        ok: true,
        message:
          splitCount > 0
            ? `Detected ${cuts.length} scene cut${cuts.length === 1 ? '' : 's'} and split ${clip.id} at ${splitCount} point${splitCount === 1 ? '' : 's'}.`
            : `Detected ${cuts.length} scene cut${cuts.length === 1 ? '' : 's'}, but none produced a valid split in ${clip.id}.`,
        data: {
          projectId: project.id,
          itemId: clip.id,
          mediaId: sourceMedia.id,
          method,
          sampleIntervalMs: interval,
          detectedCutCount: cuts.length,
          candidateSplitFrames: splitFrames,
          splitCount,
          scenesSaved: true,
        },
        operationId: changed ? crypto.randomUUID() : undefined,
        changed,
      }
    } finally {
      video.onloadedmetadata = null
      video.onerror = null
      video.src = ''
    }
  },
})

const attachSubtitleFile = definePlatformTool({
  name: 'attach_subtitle_file',
  title: 'Attach subtitle file',
  description:
    'Parse one local SRT/VTT file and attach its overlapping cues to a specified video or audio clip as one editable subtitle segment.',
  inputSchema: objectSchema(
    {
      path: { type: 'string' },
      item: { type: 'string' },
    },
    ['path', 'item'],
  ),
  schema: z.object({
    path: z.string().trim().min(1),
    item: z.string().min(1),
  }),
  summarize: ({ path, item }) => `Attach ${path} to ${item}`,
  execute: async ({ path, item: handle }) => {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('Open the target project first.')
    const [clip] = resolveItemHandles([handle], {
      allowSelection: false,
      itemTypes: ['video', 'audio'],
    })
    if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) {
      throw new Error(`Video/audio clip not found: ${handle}`)
    }

    const { file, format } = await resolveSubtitleFile(path)
    const parsed = format === 'srt' ? parseSrt(await file.text()) : parseVtt(await file.text())
    if (parsed.cues.length === 0) {
      throw new Error(`No valid subtitle cues were found in ${file.name}.`)
    }

    const timeline = useTimelineStore.getState()
    const provisional = buildSubtitleSegmentForClip({
      trackId: clip.trackId,
      cues: parsed.cues,
      clip,
      timelineFps: timeline.fps,
      canvasWidth: project.metadata.width,
      canvasHeight: project.metadata.height,
      label: file.name,
      source: {
        type: 'subtitle-import',
        fileName: file.name,
        format,
        importedAt: Date.now(),
      },
    })
    if (!provisional) {
      return {
        ok: true,
        message: `${file.name} has no cues overlapping ${clip.id}.`,
        data: {
          projectId: project.id,
          itemId: clip.id,
          fileName: file.name,
          format,
          cueCount: parsed.cues.length,
          insertedItemCount: 0,
          parseWarnings: parsed.warnings,
        },
        changed: false,
      }
    }

    const range = {
      startFrame: provisional.from,
      endFrame: provisional.from + provisional.durationInFrames,
    }
    let nextTracks = timeline.tracks
    let targetTrack = findCompatibleCaptionTrackForRanges(timeline.tracks, timeline.items, [range])
    if (!targetTrack) {
      targetTrack = buildCaptionTrack(timeline.tracks)
      nextTracks = [...timeline.tracks, targetTrack].sort((left, right) => left.order - right.order)
    }
    const segment = { ...provisional, trackId: targetTrack.id }

    executeTimelineCommand(
      'AGENT_ATTACH_SUBTITLE_FILE',
      () => {
        const store = useItemsStore.getState()
        if (nextTracks !== timeline.tracks) {
          store.setTracks(nextTracks)
        }
        store._addItem(segment)
        useTimelineSettingsStore.getState().markDirty()
      },
      { itemId: clip.id, subtitleItemId: segment.id, fileName: file.name },
    )
    await useTimelineStore.getState().saveTimeline(project.id)

    return {
      ok: true,
      message: `Attached ${parsed.cues.length} cue${parsed.cues.length === 1 ? '' : 's'} from ${file.name} to ${clip.id}.`,
      data: {
        projectId: project.id,
        itemId: clip.id,
        subtitleItemId: segment.id,
        trackId: segment.trackId,
        fileName: file.name,
        format,
        cueCount: parsed.cues.length,
        insertedItemCount: 1,
        parseWarnings: parsed.warnings,
      },
      operationId: crypto.randomUUID(),
      changed: true,
      warnings: parsed.warnings.map((message) => ({
        code: 'SUBTITLE_PARSE_WARNING',
        message,
      })),
    }
  },
})

const consolidateSubtitles = definePlatformTool({
  name: 'consolidate_subtitles',
  title: 'Consolidate subtitles',
  description:
    'Replace legacy per-cue imported/embedded subtitle text items with one editable subtitle segment per clip.',
  destructive: true,
  inputSchema: objectSchema({
    item: { type: 'string' },
  }),
  schema: z.object({
    item: z.string().min(1).optional(),
  }),
  summarize: ({ item }) => `Consolidate subtitles${item ? ` for ${item}` : ''}`,
  execute: async ({ item: handle }) => {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('Open the target project first.')
    let clipId: string | undefined
    if (handle) {
      const [clip] = resolveItemHandles([handle], {
        allowSelection: false,
        itemTypes: ['video', 'audio'],
      })
      if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) {
        throw new Error(`Video/audio clip not found: ${handle}`)
      }
      clipId = clip.id
    }

    const result = subtitleSidecarService.consolidatePerCueCaptionsToSegments({ clipId })
    const changed = result.segmentsCreated > 0
    if (changed) {
      await useTimelineStore.getState().saveTimeline(project.id)
    }
    return {
      ok: true,
      message:
        result.segmentsCreated > 0
          ? `Consolidated ${result.cuesConsolidated} cue${result.cuesConsolidated === 1 ? '' : 's'} into ${result.segmentsCreated} subtitle segment${result.segmentsCreated === 1 ? '' : 's'}.`
          : 'No legacy per-cue subtitles required consolidation.',
      data: {
        projectId: project.id,
        itemId: clipId ?? null,
        ...result,
      },
      operationId: changed ? crypto.randomUUID() : undefined,
      changed,
    }
  },
})

const focusMedia = definePlatformTool({
  name: 'focus_media',
  title: 'Focus media',
  description:
    'Select one media-library item, open it in the Source Monitor, and seek to a source timestamp.',
  inputSchema: objectSchema(
    {
      mediaId: { type: 'string' },
      atSeconds: { type: 'number', minimum: 0 },
    },
    ['mediaId'],
  ),
  schema: z.object({
    mediaId: z.string().min(1),
    atSeconds: z.number().min(0).optional(),
  }),
  summarize: ({ mediaId, atSeconds }) =>
    `Focus media ${mediaId}${atSeconds === undefined ? '' : ` at ${atSeconds}s`}`,
  execute: async ({ mediaId, atSeconds = 0 }) => {
    const { project, media } = await ensureOpenProjectMedia()
    const entry = media.find((candidate) => candidate.id === mediaId)
    if (!entry) throw new Error(`Media not found: ${mediaId}`)

    const fps = entry.fps || 30
    const durationFrames = Math.max(1, Math.round(entry.duration * fps))
    const frame = Math.max(0, Math.min(durationFrames - 1, Math.round(atSeconds * fps)))
    const outFrame = Math.min(durationFrames, frame + Math.max(1, Math.round(3 * fps)))
    const mediaStore = useMediaLibraryStore.getState()
    const sourceStore = useSourcePlayerStore.getState()
    const editorStore = useEditorStore.getState()
    const selectionChanged =
      mediaStore.selectedMediaIds.length !== 1 ||
      mediaStore.selectedMediaIds[0] !== mediaId ||
      mediaStore.selectedCompositionIds.length > 0
    const previewChanged = editorStore.sourcePreviewMediaId !== mediaId
    const seekChanged =
      sourceStore.currentMediaId !== mediaId ||
      sourceStore.pendingSeekFrame !== frame ||
      sourceStore.inPoint !== frame ||
      sourceStore.outPoint !== outFrame

    mediaStore.setSelection({ mediaIds: [mediaId], compositionIds: [] })
    sourceStore.playerMethods?.pause()
    sourceStore.setCurrentMediaId(mediaId)
    sourceStore.clearInOutPoints()
    sourceStore.setInPoint(frame)
    sourceStore.setOutPoint(outFrame)
    sourceStore.setPendingPlay(false)
    sourceStore.setPendingSeekFrame(frame)
    editorStore.setSourcePreviewMediaId(mediaId)

    return {
      ok: true,
      message: `Focused ${entry.fileName} at ${(frame / fps).toFixed(3)}s.`,
      data: {
        projectId: project.id,
        mediaId,
        fileName: entry.fileName,
        frame,
        atSeconds: frame / fps,
        selectionChanged,
        previewChanged,
        seekChanged,
        uiChanged: selectionChanged || previewChanged || seekChanged,
      },
      changed: false,
    }
  },
})

export const SCENE_MEDIA_PLATFORM_TOOLS = [
  searchScenes,
  detectAndSplitScenes,
  attachSubtitleFile,
  consolidateSubtitles,
  focusMedia,
] as const
