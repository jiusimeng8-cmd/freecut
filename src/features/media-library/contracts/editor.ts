/**
 * Media-library contract consumed by the editor feature adapter.
 */

export { MediaLibrary } from '../components/media-library'
export const importEmbeddedSubtitleTrackPickerHost = () =>
  import('../components/embedded-subtitle-track-picker-host')
export const importSubtitleScanProgressDialog = () =>
  import('../components/subtitle-scan-progress-dialog')

export { useMediaLibraryStore } from '../stores/media-library-store'
export { useEmbeddedSubtitlePickerStore } from '../stores/embedded-subtitle-picker-store'
export { useSubtitleScanProgressStore } from '../stores/subtitle-scan-progress-store'

export { mediaTranscriptionService } from '../services/media-transcription-service'
export { proxyService } from '../services/proxy-service'
export { frameInterpolationService } from '../services/frame-interpolation-service'
export { upscaleService } from '../services/upscale-service'
export {
  chooseEmbeddedSubtitleTrackForMedia,
  getEmbeddedSubtitleTrackLabel,
  subtitleSidecarService,
} from '../services/subtitle-sidecar-service'

export {
  buildCaptionTrack,
  buildSubtitleSegmentForClip,
  findCompatibleCaptionTrackForRanges,
} from '../utils/caption-items'
export {
  clearMediaDragData,
  setMediaDragData,
} from '../utils/drag-data-cache'
export { getSharedProxyKey } from '../utils/proxy-key'
export { resolveMediaUrl } from '../utils/media-resolver'
export { getMediaType } from '../utils/validation'

export const importProxyService = () => import('../services/proxy-service')
export const importMediaLibraryService = () => import('../services/media-library-service')
export const importThumbnailGenerator = () => import('../utils/thumbnail-generator')
