/** Drop cached thumbnail resources when media captions are removed or replaced. */

import { invalidateMediaCaptionThumbBlobs } from '../hooks/use-caption-thumbnail'
import { registerMediaCaptionCacheInvalidator } from '../deps/media-library'
import { invalidateLazyThumbCache } from './lazy-thumb'

function invalidateMediaCaptionThumbnails(
  mediaId: string,
  thumbRelPaths: ReadonlyArray<string | undefined> = [],
): void {
  invalidateMediaCaptionThumbBlobs(mediaId, thumbRelPaths)
  invalidateLazyThumbCache(mediaId)
}

const unregisterMediaCaptionCacheInvalidator = registerMediaCaptionCacheInvalidator(
  invalidateMediaCaptionThumbnails,
)

if (import.meta.hot) {
  import.meta.hot.dispose(unregisterMediaCaptionCacheInvalidator)
}
