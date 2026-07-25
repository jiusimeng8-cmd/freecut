/**
 * Scene Detection Service
 *
 * Two detection methods:
 * - `histogram` (default): Fast CPU-only color histogram comparison.
 * - `optical-flow`: GPU optical flow via WebGPU compute shaders.
 *
 */

import { OpticalFlowAnalyzer } from './optical-flow-analyzer'
import type { MotionResult } from './optical-flow-analyzer'
import { ANALYSIS_WIDTH, ANALYSIS_HEIGHT } from './optical-flow-shaders'
import { detectScenesHistogram } from './histogram-scene-detection'
import { seekVideo, deduplicateCuts } from './scene-detection-utils'
import { createLogger } from '@/shared/logging/logger'

const log = createLogger('SceneDetection')

/**
 * In-memory cache of scene detection results keyed by
 * `${mediaId}:${method}:${sampleIntervalMs}`.
 * Survives across multiple detection runs within the same session.
 */
const resultsCache = new Map<string, SceneCut[]>()

/** Default sampling interval in milliseconds (matches masterselects) */
const SAMPLE_INTERVAL_MS = 500

/** Minimum gap in seconds between scene cuts - prevents micro-segments from dissolves/pans */
const MIN_CUT_GAP_SEC = 2.0

export interface SceneCut {
  /** Frame number where the scene cut occurs */
  frame: number
  /** Time in seconds */
  time: number
  /** Motion result at the cut point */
  motion: MotionResult
  /** Historical compatibility for previously model-verified scene records. */
  verified?: boolean
}

export interface SceneDetectionProgress {
  percent: number
  currentSample: number
  totalSamples: number
  sceneCuts: number
  /** Current stage of the pipeline */
  stage?: 'optical-flow'
}

export interface DetectScenesOptions {
  /**
   * Detection method:
   * - `'histogram'` - fast CPU-only color histogram comparison (default).
   *    Best for hard cuts. No WebGPU required.
   * - `'optical-flow'` - GPU optical flow via WebGPU compute shaders.
   *    Detects more subtle transitions but requires WebGPU.
   */
  method?: 'histogram' | 'optical-flow'
  /** Time between samples in ms (default: 250 for histogram, 500 for optical-flow) */
  sampleIntervalMs?: number
  /** Progress callback */
  onProgress?: (progress: SceneDetectionProgress) => void
  /** AbortSignal for cancellation */
  signal?: AbortSignal
  /** Media ID for result caching - skip re-analysis when the same media is detected again */
  mediaId?: string
}

/**
 * Detect scene cuts in a video element.
 *
 * Uses `method` to select the detection strategy:
 * - `'histogram'` (default): fast CPU-only color histogram comparison
 * - `'optical-flow'`: GPU optical flow via WebGPU compute shaders
 *
 */
export async function detectScenes(
  video: HTMLVideoElement,
  fps: number,
  options: DetectScenesOptions = {},
): Promise<SceneCut[]> {
  const { method = 'histogram', onProgress, signal, mediaId } = options

  const sampleIntervalMs =
    options.sampleIntervalMs ?? (method === 'histogram' ? 250 : SAMPLE_INTERVAL_MS)

  // Return cached results when available
  if (mediaId) {
    const cacheKey = `${mediaId}:${method}:${sampleIntervalMs}`
    const cached = resultsCache.get(cacheKey)
    if (cached) {
      log.info('Returning cached scene detection results', { mediaId, cuts: cached.length })
      return cached
    }
  }

  let cuts: SceneCut[]

  if (method === 'histogram') {
    cuts = await detectScenesHistogram(video, fps, {
      sampleIntervalMs,
      onProgress,
      signal,
    })
  } else {
    cuts = await detectScenesOpticalFlow(video, fps, sampleIntervalMs, onProgress, signal)
  }

  if (mediaId) {
    resultsCache.set(`${mediaId}:${method}:${sampleIntervalMs}`, cuts)
  }
  return cuts
}

/**
 * Pass 1 alternative: GPU optical flow detection.
 * Requires WebGPU - throws if unavailable.
 */
async function detectScenesOpticalFlow(
  video: HTMLVideoElement,
  fps: number,
  sampleIntervalMs: number,
  onProgress?: (progress: SceneDetectionProgress) => void,
  signal?: AbortSignal,
): Promise<SceneCut[]> {
  if (!navigator.gpu) {
    throw new Error('WebGPU not supported - optical-flow scene detection requires GPU')
  }

  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No GPU adapter available')
  const device = await adapter.requestDevice()

  const analyzer = new OpticalFlowAnalyzer(device)

  const shaderOk = await analyzer.checkShaderCompilation()
  if (!shaderOk) {
    analyzer.destroy()
    device.destroy()
    throw new Error('Optical flow shader compilation failed - check console for details')
  }

  const sceneCuts: SceneCut[] = []
  const duration = video.duration
  const sampleIntervalSec = sampleIntervalMs / 1000
  const totalSamples = Math.ceil(duration / sampleIntervalSec)
  const canvas = new OffscreenCanvas(ANALYSIS_WIDTH, ANALYSIS_HEIGHT)
  const ctx = canvas.getContext('2d')!

  try {
    let maxMotionSeen = 0
    for (let i = 0; i < totalSamples; i++) {
      if (signal?.aborted) break

      const time = i * sampleIntervalSec
      await seekVideo(video, time)

      ctx.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT)
      const bitmap = await createImageBitmap(canvas)

      const result = await analyzer.analyzeFrame(bitmap)
      bitmap.close()

      if (result.totalMotion > maxMotionSeen) {
        maxMotionSeen = result.totalMotion
      }

      if (result.isSceneCut) {
        const frame = Math.round(time * fps)
        sceneCuts.push({ frame, time, motion: result })
      }

      onProgress?.({
        percent: (i / totalSamples) * 100,
        currentSample: i,
        totalSamples,
        sceneCuts: sceneCuts.length,
        stage: 'optical-flow',
      })
    }
    log.info('Optical flow pass complete', {
      totalSamples,
      maxMotion: maxMotionSeen.toFixed(4),
      rawCuts: sceneCuts.length,
    })
  } finally {
    analyzer.destroy()
    device.destroy()
  }

  // Deduplicate: keep strongest cut within each MIN_CUT_GAP_SEC window
  const deduped = deduplicateCuts(sceneCuts, MIN_CUT_GAP_SEC)
  log.info('Deduplication complete', { cuts: deduped.length, minGapSec: MIN_CUT_GAP_SEC })
  return deduped
}
