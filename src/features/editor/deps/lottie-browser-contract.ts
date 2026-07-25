/**
 * Adapter exports for lottie-browser dependencies.
 * Editor modules should import Lottie browser UI, catalog, and attribution helpers from here.
 */

export { LottieBrowserPanel } from '@/features/lottie-browser/components/lottie-browser-panel'
export {
  buildLottieAttribution,
  type LottieBrowseCategory,
  type LottieFilesAnimation,
} from '@/features/lottie-browser/services/lottiefiles-api'
export {
  LOTTIE_PAGE_SIZE,
  useLottieBrowserStore,
} from '@/features/lottie-browser/stores/lottie-browser-store'
