import { useMemo } from 'react'
import { useMediaLibraryStore } from '../deps/media-library'
import { useSceneBrowserStore } from '../stores/scene-browser-store'
import { parseColorQuery } from '../utils/color-boost'
import { rankScenesByPalette } from '../utils/palette-rank'
import { rankScenes, type RankableScene, type ScoredScene } from '../utils/rank'

export interface RankedScenesResult {
  scenes: ScoredScene[]
  totalScenes: number
  totalClips: number
  clipsWithCaptions: number
  isQuerying: boolean
}

/**
 * Build the Scene Browser list from persisted captions. Text queries use
 * keyword ranking; pure color queries and palette references use only the
 * palette already stored on each caption.
 */
export function useRankedScenes(): RankedScenesResult {
  const mediaItems = useMediaLibraryStore((s) => s.mediaItems)
  const query = useSceneBrowserStore((s) => s.query)
  const scope = useSceneBrowserStore((s) => s.scope)
  const sortMode = useSceneBrowserStore((s) => s.sortMode)
  const reference = useSceneBrowserStore((s) => s.reference)
  const colorQuery = useMemo(() => parseColorQuery(query), [query])

  // fallow-ignore-next-line complexity
  return useMemo<RankedScenesResult>(() => {
    const allScenes: RankableScene[] = []
    let clipsWithCaptions = 0

    for (const media of mediaItems) {
      if (scope && media.id !== scope) continue
      const captions = media.aiCaptions
      if (!captions || captions.length === 0) continue
      clipsWithCaptions += 1
      captions.forEach((caption, captionIndex) => {
        allScenes.push({
          id: `${media.id}:${captionIndex}`,
          mediaId: media.id,
          mediaFileName: media.fileName,
          timeSec: caption.timeSec,
          text: caption.text,
          thumbRelPath: caption.thumbRelPath,
          palette: caption.palette,
        })
      })
    }

    let ranked: ScoredScene[]
    if (reference) {
      ranked = rankScenesByPalette(allScenes, { referencePalette: reference.palette })
    } else if (colorQuery.paletteOnly) {
      ranked = rankScenesByPalette(allScenes, { query })
    } else {
      ranked = rankScenes(query, allScenes)
    }

    const hasRankingSignal = query.trim().length > 0 || !!reference
    if (!hasRankingSignal || sortMode === 'time' || sortMode === 'name') {
      ranked.sort((a, b) => {
        if (a.mediaFileName !== b.mediaFileName) {
          return a.mediaFileName.localeCompare(b.mediaFileName)
        }
        return a.timeSec - b.timeSec
      })
    }

    return {
      scenes: ranked,
      totalScenes: allScenes.length,
      totalClips: mediaItems.length,
      clipsWithCaptions,
      isQuerying: hasRankingSignal,
    }
  }, [mediaItems, query, scope, sortMode, reference, colorQuery.paletteOnly])
}
