import { z } from 'zod'
import {
  assessExportPreflight,
  buildTranscriptSubtitleCues,
  buildRenderJob,
  buildSegmentJobs,
  convertTimelineToComposition,
  deleteExportFile,
  listExportFiles,
  rangesFromFixedDuration,
  rangesFromMarkers,
  readExportFile,
  saveExportFile,
  useRenderQueueStore,
  workspaceFolderName,
} from '@/features/editor/deps/export-contract'
import { useMediaLibraryStore } from '@/features/editor/deps/media-library'
import {
  getActiveExportSequenceId,
  getExportableSequence,
} from '@/features/editor/deps/timeline-contract'
import { useProjectStore } from '@/features/editor/deps/projects'
import { serializeSrt, type SubtitleCue } from '@/shared/utils/subtitles'
import type { CompositionInputProps, ExtendedExportSettings } from '@/types/export'
import type { TextItem, TimelineItem } from '@/types/timeline'
import { definePlatformTool, objectSchema } from './shared'

function jobSummary(job: ReturnType<typeof useRenderQueueStore.getState>['jobs'][number]) {
  return {
    id: job.id,
    name: job.name,
    projectId: job.projectId,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    renderedFrames: job.renderedFrames,
    totalFrames: job.totalFrames,
    inPoint: job.inPoint,
    outPoint: job.outPoint,
    durationFrames: job.durationFrames,
    exportMode: job.exportMode,
    clientSettings: job.clientSettings,
    fileName: job.fileName,
    savedPath: job.savedPath,
    fileSize: job.fileSize,
    sidecarSavedPath: job.sidecarSavedPath,
    sidecarFileSize: job.sidecarFileSize,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function requireActiveProjectId(): string {
  const projectId = useProjectStore.getState().currentProject?.id
  if (!projectId) throw new Error('No fully loaded project is currently open.')
  return projectId
}

function requireProjectJob(
  job: ReturnType<typeof useRenderQueueStore.getState>['jobs'][number],
  projectId: string,
): void {
  if (job.projectId !== projectId) {
    throw new Error(`Export job ${job.id} does not belong to the open project.`)
  }
}

function fileNameFromPath(path: string | undefined): string | null {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? null
}

function exportMimeType(fileName: string): string {
  const extension = fileName.split('.').at(-1)?.toLowerCase()
  if (extension === 'mp4') return 'video/mp4'
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mkv') return 'video/x-matroska'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'aac') return 'audio/aac'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'srt') return 'application/x-subrip'
  if (extension === 'vtt') return 'text/vtt'
  return 'application/octet-stream'
}

function exportRelPath(projectId: string, fileName: string): string {
  return `projects/${projectId}/exports/${fileName}`
}

function exportDownloadUrl(relPath: string): string | null {
  if (!import.meta.env.DEV) return null
  return new URL(
    `/__freecut_dev_workspace/file?path=${encodeURIComponent(relPath)}`,
    window.location.origin,
  ).toString()
}

function normalizeRequestedFileName(requested: string, fallback: string): string {
  const trimmed = requested.trim()
  const fallbackExtension = fallback.includes('.') ? fallback.slice(fallback.lastIndexOf('.')) : ''
  return trimmed.includes('.') || !fallbackExtension ? trimmed : `${trimmed}${fallbackExtension}`
}

function applyRequestedSegmentFileNames(
  jobs: Awaited<ReturnType<typeof buildSegmentJobs>>,
  requested: string | undefined,
): void {
  if (!requested) return
  const normalized = normalizeRequestedFileName(requested, jobs[0]?.fileName ?? '')
  const dot = normalized.lastIndexOf('.')
  const stem = dot > 0 ? normalized.slice(0, dot) : normalized
  const extension = dot > 0 ? normalized.slice(dot) : ''
  jobs.forEach((job, index) => {
    job.fileName = `${stem} - Part ${index + 1}${extension}`
  })
}

function artifactData(
  projectId: string,
  entry: Awaited<ReturnType<typeof listExportFiles>>[number],
) {
  const relPath = exportRelPath(projectId, entry.name)
  return {
    exists: true,
    name: entry.name,
    size: entry.size,
    lastModified: entry.lastModified,
    mimeType: exportMimeType(entry.name),
    workspaceName: workspaceFolderName(),
    relPath,
    downloadUrl: exportDownloadUrl(relPath),
  }
}

function collectSubtitleCues(composition: CompositionInputProps): SubtitleCue[] {
  const soloActive = composition.tracks.some((track) => track.solo)
  const durationSeconds =
    composition.durationInFrames === undefined
      ? Infinity
      : composition.durationInFrames / composition.fps
  const cues: SubtitleCue[] = [...buildTranscriptSubtitleCues(composition)]

  for (const track of composition.tracks) {
    if (soloActive ? !track.solo : track.visible === false) continue
    for (const item of track.items ?? []) {
      if (item.type === 'subtitle' && item.source.type !== 'transcript') {
        const itemStart = item.from / composition.fps
        const itemEnd = (item.from + item.durationInFrames) / composition.fps
        for (const cue of item.cues) {
          const startSeconds = Math.max(0, itemStart + cue.startSeconds)
          const endSeconds = Math.min(
            durationSeconds,
            itemEnd,
            itemStart + cue.endSeconds,
          )
          if (cue.text.trim() && endSeconds > startSeconds) {
            cues.push({ id: cue.id, startSeconds, endSeconds, text: cue.text })
          }
        }
      } else if (isCaptionText(item)) {
        const startSeconds = Math.max(0, item.from / composition.fps)
        const endSeconds = Math.min(
          durationSeconds,
          (item.from + item.durationInFrames) / composition.fps,
        )
        if (item.text.trim() && endSeconds > startSeconds) {
          cues.push({ id: item.id, startSeconds, endSeconds, text: item.text })
        }
      }
    }
  }

  const unique = new Map<string, SubtitleCue>()
  for (const cue of cues) {
    const key = `${cue.startSeconds.toFixed(6)}:${cue.endSeconds.toFixed(6)}:${cue.text}`
    if (!unique.has(key)) unique.set(key, cue)
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  )
}

const exportSettingsSchema = z.object({
  sequenceId: z.string().min(1).nullable().optional(),
  mode: z.enum(['video', 'audio']).optional(),
  codec: z.enum(['h264', 'h265', 'vp8', 'vp9', 'av1']).optional(),
  quality: z.enum(['low', 'medium', 'high', 'ultra']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoContainer: z.enum(['mp4', 'mov', 'webm', 'mkv']).optional(),
  audioContainer: z.enum(['mp3', 'aac', 'wav']).optional(),
  subtitleMode: z.enum(['off', 'burn', 'sidecar', 'embedded']).optional(),
  rangeMode: z.enum(['whole', 'current', 'custom']).optional(),
  startSeconds: z.number().min(0).optional(),
  endSeconds: z.number().min(0).optional(),
  name: z.string().min(1).max(200).optional(),
  fileName: z.string().trim().min(1).max(240).optional(),
})

function exportInputSchema() {
  return objectSchema({
    sequenceId: { type: ['string', 'null'] },
    mode: { type: 'string', enum: ['video', 'audio'] },
    codec: { type: 'string', enum: ['h264', 'h265', 'vp8', 'vp9', 'av1'] },
    quality: { type: 'string', enum: ['low', 'medium', 'high', 'ultra'] },
    width: { type: 'number', minimum: 1 },
    height: { type: 'number', minimum: 1 },
    videoContainer: { type: 'string', enum: ['mp4', 'mov', 'webm', 'mkv'] },
    audioContainer: { type: 'string', enum: ['mp3', 'aac', 'wav'] },
    subtitleMode: { type: 'string', enum: ['off', 'burn', 'sidecar', 'embedded'] },
    rangeMode: { type: 'string', enum: ['whole', 'current', 'custom'] },
    startSeconds: { type: 'number', minimum: 0 },
    endSeconds: { type: 'number', minimum: 0 },
    name: { type: 'string' },
    fileName: { type: 'string' },
  })
}

function resolveExportContext(args: z.infer<typeof exportSettingsSchema>) {
  const sequenceId =
    args.sequenceId === undefined ? getActiveExportSequenceId() : args.sequenceId
  const sequence = getExportableSequence(sequenceId ?? null)
  const mode = args.mode ?? 'video'
  const videoContainer = args.videoContainer ?? 'mp4'
  const subtitleMode = args.subtitleMode ?? 'burn'
  if (mode === 'video' && subtitleMode === 'embedded' && !['webm', 'mkv'].includes(videoContainer)) {
    throw new Error('Embedded subtitles require a WebM or MKV video container.')
  }
  const settings: ExtendedExportSettings = {
    mode,
    codec: args.codec ?? 'h264',
    quality: args.quality ?? 'high',
    resolution: {
      width: args.width ?? sequence.width,
      height: args.height ?? sequence.height,
    },
    ...(mode === 'video'
      ? {
          videoContainer,
          subtitleMode,
        }
      : { audioContainer: args.audioContainer ?? 'wav' }),
  }
  return { sequence, settings }
}

function resolveExportRange(
  args: z.infer<typeof exportSettingsSchema>,
  sequence: ReturnType<typeof getExportableSequence>,
): { inPoint: number | null; outPoint: number | null } {
  const rangeMode =
    args.rangeMode ??
    (args.startSeconds !== undefined || args.endSeconds !== undefined
      ? 'custom'
      : sequence.inPoint !== null && sequence.outPoint !== null
        ? 'current'
        : 'whole')
  if (rangeMode === 'whole') return { inPoint: null, outPoint: null }
  if (rangeMode === 'current') {
    if (sequence.inPoint === null || sequence.outPoint === null) {
      throw new Error('The selected timeline has no current In/Out range.')
    }
    return { inPoint: sequence.inPoint, outPoint: sequence.outPoint }
  }
  if (args.startSeconds === undefined || args.endSeconds === undefined) {
    throw new Error('startSeconds and endSeconds are required for a custom range.')
  }
  const inPoint = Math.round(args.startSeconds * sequence.fps)
  const outPoint = Math.round(args.endSeconds * sequence.fps)
  if (outPoint <= inPoint) {
    throw new Error('endSeconds must be greater than startSeconds.')
  }
  return { inPoint, outPoint }
}

async function buildJob(args: z.infer<typeof exportSettingsSchema>) {
  const projectId = requireActiveProjectId()
  const { sequence, settings } = resolveExportContext(args)
  const { inPoint, outPoint } = resolveExportRange(args, sequence)
  const job = await buildRenderJob({
    settings,
    inPoint,
    outPoint,
    name: args.name,
    sequence,
  })
  if (job.projectId !== projectId) {
    throw new Error('The export snapshot does not match the open project.')
  }
  if (args.fileName) {
    job.fileName = normalizeRequestedFileName(args.fileName, job.fileName)
  }
  return { job, settings }
}

async function preflightJob(
  job: Awaited<ReturnType<typeof buildRenderJob>>,
  settings: ExtendedExportSettings,
) {
  const snapshot = job.snapshot
  const composition = convertTimelineToComposition(
    snapshot.tracks,
    snapshot.items,
    snapshot.transitions,
    snapshot.fps,
    snapshot.width,
    snapshot.height,
    job.inPoint,
    job.outPoint,
    snapshot.keyframes,
    snapshot.backgroundColor,
    snapshot.busAudioEq,
    snapshot.masterBusDb,
    snapshot.compositions,
  )
  return assessExportPreflight({
    settings,
    fps: snapshot.fps,
    composition,
    durationFrames: job.durationFrames,
    brokenMediaIds: useMediaLibraryStore.getState().brokenMediaIds,
  })
}

const checkExport = definePlatformTool({
  name: 'check_export',
  title: 'Check export settings',
  description:
    'Resolve the real codec, container, range, output name, and frozen sequence snapshot for an export without enqueueing it.',
  inputSchema: exportInputSchema(),
  readOnly: true,
  schema: exportSettingsSchema,
  summarize: () => 'Check export settings',
  execute: async (args) => {
    const { job, settings } = await buildJob(args)
    const preflight = await preflightJob(job, settings)
    return {
      ok: preflight.canExport,
      message: preflight.canExport
        ? `Export is ready as ${job.fileName}.`
        : `Export preflight blocked ${job.fileName}.`,
      data: { job: jobSummary(job), preflight },
      ...(!preflight.canExport
        ? {
            error: {
              code: 'EXPORT_PREFLIGHT_FAILED',
              message: 'One or more export preflight checks failed.',
            },
          }
        : {}),
    }
  },
})

const enqueueExport = definePlatformTool({
  name: 'enqueue_export',
  title: 'Enqueue export',
  description:
    'Freeze the selected Main/sequence timeline and enqueue an MP4/MOV/WebM/MKV or MP3/AAC/WAV export.',
  inputSchema: exportInputSchema(),
  schema: exportSettingsSchema,
  summarize: () => 'Enqueue project export',
  execute: async (args) => {
    const { job, settings } = await buildJob(args)
    const preflight = await preflightJob(job, settings)
    if (!preflight.canExport) {
      return {
        ok: false,
        message: `Export preflight blocked ${job.fileName}.`,
        data: { job: jobSummary(job), preflight },
        error: {
          code: 'EXPORT_PREFLIGHT_FAILED',
          message: 'One or more export preflight checks failed.',
        },
        changed: false,
      }
    }
    useRenderQueueStore.getState().enqueueJobs([job])
    return {
      ok: true,
      message: `Queued export ${job.fileName}.`,
      data: { job: jobSummary(job), preflight },
      operationId: job.id,
      changed: true,
    }
  },
})

const enqueueSegmentedExport = definePlatformTool({
  name: 'enqueue_segmented_export',
  title: 'Enqueue segmented export',
  description:
    'Split the selected export range at timeline markers or fixed-duration intervals and enqueue every segment.',
  inputSchema: objectSchema(
    {
      ...exportInputSchema().properties,
      strategy: { type: 'string', enum: ['markers', 'fixed_duration'] },
      chunkSeconds: { type: 'number', minimum: 1 },
    },
    ['strategy'],
  ),
  schema: exportSettingsSchema
    .extend({
      strategy: z.enum(['markers', 'fixed_duration']),
      chunkSeconds: z.number().min(1).optional(),
    })
    .refine(
      ({ strategy, chunkSeconds }) => strategy !== 'fixed_duration' || chunkSeconds !== undefined,
      'chunkSeconds is required for fixed_duration.',
    ),
  summarize: ({ strategy }) => `Enqueue ${strategy} segmented export`,
  execute: async (args) => {
    const projectId = requireActiveProjectId()
    const { sequence, settings } = resolveExportContext(args)
    const { inPoint, outPoint } = resolveExportRange(args, sequence)
    const rangeStart = inPoint ?? 0
    const rangeEnd = outPoint ?? sequence.durationFrames
    const ranges =
      args.strategy === 'markers'
        ? rangesFromMarkers(sequence.markers, rangeStart, rangeEnd)
        : rangesFromFixedDuration(
            rangeStart,
            rangeEnd,
            Math.round(args.chunkSeconds! * sequence.fps),
          )
    if (ranges.length === 0) throw new Error('The selected range produced no export segments.')

    const baseName = args.name ?? sequence.name
    const jobs = await buildSegmentJobs(
      settings,
      ranges,
      (index) => `${baseName} - Part ${index + 1}`,
      sequence,
    )
    if (jobs.some((job) => job.projectId !== projectId)) {
      throw new Error('One or more export snapshots do not match the open project.')
    }
    applyRequestedSegmentFileNames(jobs, args.fileName)
    const preflights = await Promise.all(
      jobs.map(async (job) => ({ job, preflight: await preflightJob(job, settings) })),
    )
    const blocked = preflights.filter(({ preflight }) => !preflight.canExport)
    if (blocked.length > 0) {
      return {
        ok: false,
        message: `${blocked.length} segmented export job${blocked.length === 1 ? '' : 's'} failed preflight.`,
        data: {
          jobs: preflights.map(({ job, preflight }) => ({ job: jobSummary(job), preflight })),
        },
        error: {
          code: 'EXPORT_PREFLIGHT_FAILED',
          message: 'One or more segmented export preflight checks failed.',
        },
        changed: false,
      }
    }

    useRenderQueueStore.getState().enqueueJobs(jobs)
    return {
      ok: true,
      message: `Queued ${jobs.length} segmented export job${jobs.length === 1 ? '' : 's'}.`,
      data: { jobs: jobs.map(jobSummary) },
      operationId: crypto.randomUUID(),
      changed: true,
    }
  },
})

const readExportJobs = definePlatformTool({
  name: 'read_export_jobs',
  title: 'Read export jobs',
  description:
    'Read the open project render queue with real artifact existence checks and effective missing status.',
  inputSchema: objectSchema({
    status: {
      type: 'string',
      enum: ['queued', 'rendering', 'completed', 'missing', 'failed', 'cancelled'],
    },
  }),
  readOnly: true,
  schema: z.object({
    status: z
      .enum(['queued', 'rendering', 'completed', 'missing', 'failed', 'cancelled'])
      .optional(),
  }),
  summarize: () => 'Read export queue',
  execute: async ({ status }) => {
    const projectId = requireActiveProjectId()
    const queue = useRenderQueueStore.getState()
    const files = await listExportFiles(projectId)
    const filesByName = new Map(files.map((file) => [file.name, file]))
    const jobs = queue.jobs
      .filter((job) => job.projectId === projectId)
      .map((job) => {
        const savedName = fileNameFromPath(job.savedPath)
        const entry = savedName ? filesByName.get(savedName) : undefined
        const effectiveStatus =
          job.status === 'completed' && !entry ? ('missing' as const) : job.status
        return {
          ...jobSummary(job),
          effectiveStatus,
          artifact: entry
            ? artifactData(projectId, entry)
            : {
                exists: false,
                name: savedName ?? job.fileName,
                workspaceName: workspaceFolderName(),
                relPath: savedName ? exportRelPath(projectId, savedName) : job.savedPath ?? null,
                downloadUrl: null,
              },
        }
      })
      .filter((job) => !status || job.effectiveStatus === status)
    return {
      ok: true,
      message: `Read ${jobs.length} export job${jobs.length === 1 ? '' : 's'}.`,
      data: {
        projectId,
        isPaused: queue.isPaused,
        activeJobId: jobs.some((job) => job.id === queue.activeJobId)
          ? queue.activeJobId
          : null,
        jobs,
      },
    }
  },
})

const manageExportJob = definePlatformTool({
  name: 'manage_export_job',
  title: 'Manage export job',
  description: 'Cancel, retry, remove, or reorder one export queue job.',
  inputSchema: objectSchema(
    {
      operation: { type: 'string', enum: ['cancel', 'retry', 'remove', 'move_up', 'move_down'] },
      jobId: { type: 'string' },
    },
    ['operation', 'jobId'],
  ),
  destructive: true,
  schema: z.object({
    operation: z.enum(['cancel', 'retry', 'remove', 'move_up', 'move_down']),
    jobId: z.string().min(1),
  }),
  summarize: ({ operation }) => `${operation} export job`,
  execute: ({ operation, jobId }) => {
    const projectId = requireActiveProjectId()
    const queue = useRenderQueueStore.getState()
    const job = queue.jobs.find((candidate) => candidate.id === jobId)
    if (!job) throw new Error(`Export job not found: ${jobId}`)
    requireProjectJob(job, projectId)

    let accepted = true
    let changed = true
    if (operation === 'cancel') {
      accepted = job.status === 'queued' || job.status === 'rendering'
      if (accepted) queue.cancelJob(jobId)
    } else if (operation === 'retry') {
      accepted = ['completed', 'failed', 'cancelled'].includes(job.status)
      if (accepted) queue.retryJob(jobId)
    } else if (operation === 'remove') {
      queue.removeJob(jobId)
    } else {
      const projectJobs = queue.jobs.filter((candidate) => candidate.projectId === projectId)
      const index = projectJobs.findIndex((candidate) => candidate.id === jobId)
      const target = index + (operation === 'move_up' ? -1 : 1)
      accepted = target >= 0 && target < projectJobs.length
      if (accepted) queue.moveJob(jobId, operation === 'move_up' ? -1 : 1)
    }
    changed = accepted

    if (!accepted) {
      return {
        ok: false,
        message: `${operation} is not valid for export job ${jobId} in status ${job.status}.`,
        data: { accepted: false, changed: false, job: jobSummary(job) },
        error: {
          code: 'EXPORT_JOB_OPERATION_REJECTED',
          message: 'The requested queue operation is not valid for the current job state.',
        },
        changed: false,
      }
    }

    const updated = useRenderQueueStore
      .getState()
      .jobs.find((candidate) => candidate.id === jobId)
    return {
      ok: true,
      message: `${operation} applied to export job ${jobId}.`,
      data: {
        accepted: true,
        job: updated ? jobSummary(updated) : null,
      },
      changed,
    }
  },
})

const setExportQueuePaused = definePlatformTool({
  name: 'set_export_queue_paused',
  title: 'Pause or resume exports',
  description: 'Pause or resume serial processing of queued export jobs.',
  inputSchema: objectSchema(
    { paused: { type: 'boolean' } },
    ['paused'],
  ),
  schema: z.object({ paused: z.boolean() }),
  summarize: ({ paused }) => (paused ? 'Pause export queue' : 'Resume export queue'),
  execute: ({ paused }) => {
    requireActiveProjectId()
    const queue = useRenderQueueStore.getState()
    const changed = queue.isPaused !== paused
    if (changed) queue.setPaused(paused)
    return {
      ok: true,
      message: changed
        ? paused
          ? 'Paused export queue.'
          : 'Resumed export queue.'
        : `Export queue was already ${paused ? 'paused' : 'running'}.`,
      data: { paused },
      changed,
    }
  },
})

const clearExportJobs = definePlatformTool({
  name: 'clear_export_jobs',
  title: 'Clear export jobs',
  description: 'Remove finished jobs or clear the entire render queue.',
  inputSchema: objectSchema(
    { scope: { type: 'string', enum: ['finished', 'all'] } },
    ['scope'],
  ),
  destructive: true,
  schema: z.object({ scope: z.enum(['finished', 'all']) }),
  summarize: ({ scope }) => `Clear ${scope} export jobs`,
  execute: ({ scope }) => {
    const projectId = requireActiveProjectId()
    const queue = useRenderQueueStore.getState()
    const removable = queue.jobs.filter(
      (job) =>
        job.projectId === projectId &&
        (scope === 'all' || ['completed', 'failed', 'cancelled'].includes(job.status)),
    )
    for (const job of removable) queue.removeJob(job.id)
    const removed = removable.length
    return {
      ok: true,
      message: `Removed ${removed} export job${removed === 1 ? '' : 's'}.`,
      data: { scope, removed },
      changed: removed > 0,
    }
  },
})

const readExports = definePlatformTool({
  name: 'read_exports',
  requiresProject: false,
  title: 'Read exported files',
  description:
    'List final files saved under a project exports folder with size, MIME type, workspace path, and Bridge download URL.',
  inputSchema: objectSchema({ projectId: { type: 'string' } }),
  readOnly: true,
  schema: z.object({ projectId: z.string().min(1).optional() }),
  summarize: () => 'Read exported files',
  execute: async ({ projectId }) => {
    const id = projectId ?? useProjectStore.getState().currentProject?.id
    if (!id) throw new Error('No project is currently open.')
    const files = await listExportFiles(id)
    return {
      ok: true,
      message: `Found ${files.length} exported file${files.length === 1 ? '' : 's'}.`,
      data: {
        projectId: id,
        workspaceName: workspaceFolderName(),
        files: files.map((entry) => artifactData(id, entry)),
      },
    }
  },
})

const getExportArtifact = definePlatformTool({
  name: 'get_export_artifact',
  requiresProject: false,
  title: 'Get export artifact',
  description:
    'Resolve one exported file by queue job or file name and return its real existence, metadata, workspace path, and Bridge download URL.',
  inputSchema: objectSchema({
    projectId: { type: 'string' },
    jobId: { type: 'string' },
    fileName: { type: 'string' },
  }),
  readOnly: true,
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      jobId: z.string().min(1).optional(),
      fileName: z.string().min(1).optional(),
    })
    .refine(({ jobId, fileName }) => Number(!!jobId) + Number(!!fileName) === 1, {
      message: 'Provide exactly one of jobId or fileName.',
    }),
  summarize: ({ jobId, fileName }) => `Read export artifact ${jobId ?? fileName}`,
  execute: async ({ projectId, jobId, fileName }) => {
    let id = projectId ?? useProjectStore.getState().currentProject?.id
    let requestedName = fileName
    let job:
      | ReturnType<typeof useRenderQueueStore.getState>['jobs'][number]
      | undefined
    if (jobId) {
      job = useRenderQueueStore.getState().jobs.find((candidate) => candidate.id === jobId)
      if (!job) throw new Error(`Export job not found: ${jobId}`)
      id = id ?? job.projectId
      if (!id || job.projectId !== id) {
        throw new Error(`Export job ${jobId} does not belong to project ${id ?? '(unknown)'}.`)
      }
      requestedName = fileNameFromPath(job.savedPath) ?? job.fileName
    }
    if (!id) throw new Error('No project is open or specified.')

    const entry = (await listExportFiles(id)).find((file) => file.name === requestedName)
    if (!entry) {
      const relPath = requestedName ? exportRelPath(id, requestedName) : null
      return {
        ok: true,
        message: `Export artifact ${requestedName ?? jobId} is missing.`,
        data: {
          projectId: id,
          job: job ? jobSummary(job) : null,
          artifact: {
            exists: false,
            name: requestedName ?? null,
            workspaceName: workspaceFolderName(),
            relPath,
            downloadUrl: null,
          },
        },
      }
    }
    const blob = await readExportFile(entry.path)
    const artifact = artifactData(id, entry)
    return {
      ok: true,
      message: `Export artifact ${entry.name} exists (${entry.size} bytes).`,
      data: {
        projectId: id,
        job: job ? jobSummary(job) : null,
        artifact: {
          ...artifact,
          readable: blob !== null,
        },
      },
    }
  },
})

const deleteExport = definePlatformTool({
  name: 'delete_export',
  requiresProject: false,
  title: 'Delete exported file',
  description: 'Delete one final exported file from the project exports folder.',
  inputSchema: objectSchema(
    {
      fileName: { type: 'string' },
      projectId: { type: 'string' },
    },
    ['fileName'],
  ),
  destructive: true,
  schema: z.object({
    fileName: z.string().min(1),
    projectId: z.string().min(1).optional(),
  }),
  summarize: ({ fileName }) => `Delete export ${fileName}`,
  execute: async ({ fileName, projectId }) => {
    const id = projectId ?? useProjectStore.getState().currentProject?.id
    if (!id) throw new Error('No project is currently open.')
    const entry = (await listExportFiles(id)).find((file) => file.name === fileName)
    if (!entry) throw new Error(`Exported file not found: ${fileName}`)
    await deleteExportFile(entry.path)
    return {
      ok: true,
      message: `Deleted exported file ${fileName}.`,
      data: { projectId: id, fileName },
      changed: true,
    }
  },
})

function isCaptionText(item: TimelineItem): item is TextItem {
  return item.type === 'text' && (item.textRole === 'caption' || !!item.captionSource)
}

const exportSubtitles = definePlatformTool({
  name: 'export_subtitles',
  title: 'Export SRT subtitles',
  description:
    'Serialize editable subtitle and caption items from Main or a sequence and save an SRT file in project exports.',
  inputSchema: objectSchema({
    sequenceId: { type: ['string', 'null'] },
    fileName: { type: 'string' },
    rangeMode: { type: 'string', enum: ['whole', 'current', 'custom'] },
    startSeconds: { type: 'number', minimum: 0 },
    endSeconds: { type: 'number', minimum: 0 },
  }),
  schema: z.object({
    sequenceId: z.string().min(1).nullable().optional(),
    fileName: z.string().min(1).optional(),
    rangeMode: z.enum(['whole', 'current', 'custom']).optional(),
    startSeconds: z.number().min(0).optional(),
    endSeconds: z.number().min(0).optional(),
  }),
  summarize: () => 'Export subtitles as SRT',
  execute: async ({ sequenceId, fileName, rangeMode, startSeconds, endSeconds }) => {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('No project is currently open.')
    const resolvedSequenceId =
      sequenceId === undefined ? getActiveExportSequenceId() : sequenceId
    const sequence = getExportableSequence(resolvedSequenceId ?? null)
    const range = resolveExportRange(
      { sequenceId, rangeMode, startSeconds, endSeconds },
      sequence,
    )
    const composition = convertTimelineToComposition(
      sequence.tracks,
      sequence.items,
      sequence.transitions,
      sequence.fps,
      sequence.width,
      sequence.height,
      range.inPoint,
      range.outPoint,
      sequence.keyframes,
      sequence.backgroundColor,
      sequence.busAudioEq,
      sequence.masterBusDb,
      sequence.compositions,
    )
    const cues = collectSubtitleCues(composition)
    if (cues.length === 0) throw new Error('The selected timeline has no editable subtitles.')
    const requestedName = fileName ?? `${project.name}${sequence.id ? ` - ${sequence.name}` : ''}.srt`
    const finalName = requestedName.toLowerCase().endsWith('.srt')
      ? requestedName
      : `${requestedName}.srt`
    const content = serializeSrt(cues)
    const saved = await saveExportFile(
      project.id,
      finalName,
      new Blob([content], { type: 'application/x-subrip;charset=utf-8' }),
    )
    return {
      ok: true,
      message: `Exported ${cues.length} subtitle cue${cues.length === 1 ? '' : 's'} to ${saved.relPath}.`,
      data: { ...saved, cueCount: cues.length },
      changed: true,
    }
  },
})

export const EXPORT_PLATFORM_TOOLS = [
  checkExport,
  enqueueExport,
  enqueueSegmentedExport,
  readExportJobs,
  manageExportJob,
  setExportQueuePaused,
  clearExportJobs,
  readExports,
  getExportArtifact,
  deleteExport,
  exportSubtitles,
] as const
