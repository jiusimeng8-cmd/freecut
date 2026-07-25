import { colorBoostFor, paletteSimilarityBoost, parseColorQuery } from './color-boost'
import type { PaletteEntry } from '../deps/analysis'
import type { RankableScene, ScoredScene } from './rank'

interface PaletteRankOptions {
  query?: string
  referencePalette?: PaletteEntry[] | null
}

export function rankScenesByPalette(
  scenes: RankableScene[],
  options: PaletteRankOptions,
): ScoredScene[] {
  const referencePalette = options.referencePalette ?? null
  const colorQuery = options.query ? parseColorQuery(options.query) : null
  if (!referencePalette && (!colorQuery?.paletteOnly || colorQuery.colors.length === 0)) {
    return []
  }

  const scored: ScoredScene[] = []
  for (const scene of scenes) {
    if (referencePalette) {
      const similarity = paletteSimilarityBoost(referencePalette, scene.palette)
      if (!similarity) continue
      scored.push({
        ...scene,
        score: similarity.boost,
        matchSpans: [],
        signals: {
          ranker: 'palette',
          paletteDistance: similarity.distance,
        },
      })
      continue
    }

    const match = colorBoostFor(colorQuery!.colors, scene.palette)
    if (!match) continue
    scored.push({
      ...scene,
      score: match.boost,
      matchSpans: [],
      signals: {
        ranker: 'palette',
        colorMatch: match.family,
      },
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.mediaFileName !== b.mediaFileName) {
      return a.mediaFileName.localeCompare(b.mediaFileName)
    }
    return a.timeSec - b.timeSec
  })
  return scored
}
