import { z } from 'zod'
import {
  convertTimelineToComposition,
  importSingleFrameRenderer,
} from '@/features/editor/deps/export-contract'
import {
  getActiveExportSequenceId,
  getExportableSequence,
} from '@/features/editor/deps/timeline-contract'
import { definePlatformTool, objectSchema } from './shared'

const frameTargetSchema = {
  sequenceId: z.string().min(1).nullable().optional(),
  frame: z.number().int().min(0).optional(),
  atSeconds: z.number().min(0).optional(),
}

function resolveFrameTarget(args: {
  sequenceId?: string | null
  frame?: number
  atSeconds?: number
}) {
  if (args.frame !== undefined && args.atSeconds !== undefined) {
    throw new Error('Provide either frame or atSeconds, not both.')
  }
  const sequenceId =
    args.sequenceId === undefined ? getActiveExportSequenceId() : args.sequenceId
  const sequence = getExportableSequence(sequenceId ?? null)
  const requestedFrame =
    args.frame ?? (args.atSeconds === undefined ? 0 : Math.round(args.atSeconds * sequence.fps))
  const maxFrame = Math.max(0, sequence.durationFrames - 1)
  if (requestedFrame > maxFrame) {
    throw new Error(`Frame ${requestedFrame} exceeds the sequence duration (${maxFrame}).`)
  }
  const composition = convertTimelineToComposition(
    sequence.tracks,
    sequence.items,
    sequence.transitions,
    sequence.fps,
    sequence.width,
    sequence.height,
    null,
    null,
    sequence.keyframes,
    sequence.backgroundColor,
    sequence.busAudioEq,
    sequence.masterBusDb,
    sequence.compositions,
  )
  return { sequence, composition, frame: requestedFrame }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to encode frame image.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Failed to create frame analysis canvas.')
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

function analyzeImageData(
  imageData: ImageData,
  blackLumaThreshold: number,
  blackRatioThreshold: number,
) {
  const pixels = imageData.width * imageData.height
  let red = 0
  let green = 0
  let blue = 0
  let alpha = 0
  let lumaTotal = 0
  let minLuma = 255
  let maxLuma = 0
  let blackPixels = 0
  let transparentPixels = 0
  let blankPixels = 0

  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    const r = imageData.data[offset]!
    const g = imageData.data[offset + 1]!
    const b = imageData.data[offset + 2]!
    const a = imageData.data[offset + 3]!
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    red += r
    green += g
    blue += b
    alpha += a
    lumaTotal += luma
    minLuma = Math.min(minLuma, luma)
    maxLuma = Math.max(maxLuma, luma)
    if (luma <= blackLumaThreshold) blackPixels += 1
    if (a <= 8) transparentPixels += 1
    if (luma <= blackLumaThreshold || a <= 8) blankPixels += 1
  }

  const blackPixelRatio = pixels === 0 ? 0 : blackPixels / pixels
  const transparentPixelRatio = pixels === 0 ? 0 : transparentPixels / pixels
  const blankPixelRatio = pixels === 0 ? 0 : blankPixels / pixels
  return {
    width: imageData.width,
    height: imageData.height,
    pixelCount: pixels,
    averageColor: {
      r: pixels === 0 ? 0 : red / pixels,
      g: pixels === 0 ? 0 : green / pixels,
      b: pixels === 0 ? 0 : blue / pixels,
      a: pixels === 0 ? 0 : alpha / pixels,
    },
    averageLuma: pixels === 0 ? 0 : lumaTotal / pixels,
    minLuma: pixels === 0 ? 0 : minLuma,
    maxLuma: pixels === 0 ? 0 : maxLuma,
    blackPixelRatio,
    transparentPixelRatio,
    blankPixelRatio,
    isLikelyBlack: blankPixelRatio >= blackRatioThreshold,
  }
}

const captureFrame = definePlatformTool({
  name: 'capture_frame',
  title: 'Capture rendered frame',
  description:
    'Render one exact sequence frame with the export renderer and optionally return it as a data URL for Bridge/MCP image consumers.',
  inputSchema: objectSchema({
    sequenceId: { type: ['string', 'null'] },
    frame: { type: 'number', minimum: 0 },
    atSeconds: { type: 'number', minimum: 0 },
    width: { type: 'number', minimum: 1 },
    height: { type: 'number', minimum: 1 },
    format: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
    quality: { type: 'number', minimum: 0, maximum: 1 },
    includeDataUrl: { type: 'boolean' },
  }),
  readOnly: true,
  schema: z.object({
    ...frameTargetSchema,
    width: z.number().int().positive().max(7680).optional(),
    height: z.number().int().positive().max(4320).optional(),
    format: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
    quality: z.number().min(0).max(1).optional(),
    includeDataUrl: z.boolean().optional(),
  }),
  summarize: ({ frame, atSeconds }) =>
    `Capture frame ${frame ?? `${atSeconds ?? 0}s`}`,
  execute: async ({
    sequenceId,
    frame,
    atSeconds,
    width,
    height,
    format = 'image/png',
    quality = 1,
    includeDataUrl = false,
  }) => {
    const target = resolveFrameTarget({ sequenceId, frame, atSeconds })
    const outputWidth = width ?? target.sequence.width
    const outputHeight = height ?? target.sequence.height
    const { renderSingleFrame } = await importSingleFrameRenderer()
    const blob = await renderSingleFrame({
      composition: target.composition,
      frame: target.frame,
      width: outputWidth,
      height: outputHeight,
      format,
      quality,
    })
    return {
      ok: true,
      message: `Captured frame ${target.frame} at ${outputWidth}x${outputHeight}.`,
      data: {
        sequenceId: target.sequence.id,
        frame: target.frame,
        atSeconds: target.frame / target.sequence.fps,
        width: outputWidth,
        height: outputHeight,
        mimeType: blob.type,
        byteLength: blob.size,
        ...(includeDataUrl ? { dataUrl: await blobToDataUrl(blob) } : {}),
      },
    }
  },
})

const inspectFrame = definePlatformTool({
  name: 'inspect_frame',
  title: 'Inspect rendered frame',
  description:
    'Render one exact sequence frame and return objective pixel statistics including average color and black-frame likelihood.',
  inputSchema: objectSchema({
    sequenceId: { type: ['string', 'null'] },
    frame: { type: 'number', minimum: 0 },
    atSeconds: { type: 'number', minimum: 0 },
    width: { type: 'number', minimum: 1 },
    height: { type: 'number', minimum: 1 },
    blackLumaThreshold: { type: 'number', minimum: 0, maximum: 255 },
    blackRatioThreshold: { type: 'number', minimum: 0, maximum: 1 },
  }),
  readOnly: true,
  schema: z.object({
    ...frameTargetSchema,
    width: z.number().int().positive().max(1920).optional(),
    height: z.number().int().positive().max(1080).optional(),
    blackLumaThreshold: z.number().min(0).max(255).optional(),
    blackRatioThreshold: z.number().min(0).max(1).optional(),
  }),
  summarize: ({ frame, atSeconds }) =>
    `Inspect frame ${frame ?? `${atSeconds ?? 0}s`}`,
  execute: async ({
    sequenceId,
    frame,
    atSeconds,
    width = 320,
    height = 180,
    blackLumaThreshold = 8,
    blackRatioThreshold = 0.98,
  }) => {
    const target = resolveFrameTarget({ sequenceId, frame, atSeconds })
    const { renderSingleFrame } = await importSingleFrameRenderer()
    const blob = await renderSingleFrame({
      composition: target.composition,
      frame: target.frame,
      width,
      height,
      format: 'image/png',
      quality: 1,
    })
    const analysis = analyzeImageData(
      await blobToImageData(blob),
      blackLumaThreshold,
      blackRatioThreshold,
    )
    return {
      ok: true,
      message: analysis.isLikelyBlack
        ? `Frame ${target.frame} is likely black.`
        : `Frame ${target.frame} contains visible image content.`,
      data: {
        sequenceId: target.sequence.id,
        frame: target.frame,
        atSeconds: target.frame / target.sequence.fps,
        blackLumaThreshold,
        blackRatioThreshold,
        ...analysis,
      },
    }
  },
})

const inspectFrames = definePlatformTool({
  name: 'inspect_frames',
  title: 'Inspect multiple rendered frames',
  description:
    'Render and inspect exact times across a sequence to find black or blank frames before export.',
  inputSchema: objectSchema(
    {
      sequenceId: { type: ['string', 'null'] },
      timesSeconds: { type: 'array', items: { type: 'number', minimum: 0 } },
      width: { type: 'number', minimum: 1 },
      height: { type: 'number', minimum: 1 },
      blackLumaThreshold: { type: 'number', minimum: 0, maximum: 255 },
      blackRatioThreshold: { type: 'number', minimum: 0, maximum: 1 },
    },
    ['timesSeconds'],
  ),
  readOnly: true,
  schema: z.object({
    sequenceId: z.string().min(1).nullable().optional(),
    timesSeconds: z.array(z.number().min(0)).min(1).max(120),
    width: z.number().int().positive().max(640).optional(),
    height: z.number().int().positive().max(360).optional(),
    blackLumaThreshold: z.number().min(0).max(255).optional(),
    blackRatioThreshold: z.number().min(0).max(1).optional(),
  }),
  summarize: ({ timesSeconds }) =>
    `Inspect ${timesSeconds.length} rendered frame${timesSeconds.length === 1 ? '' : 's'}`,
  execute: async ({
    sequenceId,
    timesSeconds,
    width = 160,
    height = 90,
    blackLumaThreshold = 8,
    blackRatioThreshold = 0.98,
  }) => {
    const sequenceTarget =
      sequenceId === undefined ? getActiveExportSequenceId() : sequenceId
    const sequence = getExportableSequence(sequenceTarget ?? null)
    const frames = [
      ...new Set(timesSeconds.map((seconds) => Math.round(seconds * sequence.fps))),
    ]
    const maxFrame = Math.max(0, sequence.durationFrames - 1)
    if (frames.some((frame) => frame > maxFrame)) {
      throw new Error(`One or more requested times exceed the sequence duration.`)
    }
    const target = resolveFrameTarget({ sequenceId: sequenceTarget, frame: frames[0] })
    const { renderSingleFrame } = await importSingleFrameRenderer()
    const results = []
    for (const frame of frames) {
      const blob = await renderSingleFrame({
        composition: target.composition,
        frame,
        width,
        height,
        format: 'image/png',
        quality: 1,
      })
      results.push({
        frame,
        atSeconds: frame / sequence.fps,
        ...analyzeImageData(
          await blobToImageData(blob),
          blackLumaThreshold,
          blackRatioThreshold,
        ),
      })
    }
    const likelyBlackFrames = results
      .filter((result) => result.isLikelyBlack)
      .map(({ frame, atSeconds, blankPixelRatio }) => ({
        frame,
        atSeconds,
        blankPixelRatio,
      }))
    return {
      ok: true,
      message:
        likelyBlackFrames.length === 0
          ? `Inspected ${results.length} frames; none were likely black.`
          : `Found ${likelyBlackFrames.length} likely black frame${likelyBlackFrames.length === 1 ? '' : 's'}.`,
      data: {
        sequenceId: sequence.id,
        blackLumaThreshold,
        blackRatioThreshold,
        results,
        likelyBlackFrames,
      },
    }
  },
})

export const FRAME_PLATFORM_TOOLS = [
  captureFrame,
  inspectFrame,
  inspectFrames,
] as const
