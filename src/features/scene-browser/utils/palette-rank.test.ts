// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { rankScenesByPalette } from './palette-rank'
import type { RankableScene } from './rank'

function scene(
  id: string,
  palette?: RankableScene['palette'],
  text = 'Existing caption',
): RankableScene {
  return {
    id,
    mediaId: id.split(':')[0] ?? 'media',
    mediaFileName: `${id}.mp4`,
    timeSec: 0,
    text,
    palette,
  }
}

describe('rankScenesByPalette', () => {
  it('matches pure color queries against existing palettes', () => {
    const scenes = [
      scene('red:0', [{ l: 53, a: 70, b: 50, weight: 1 }]),
      scene('blue:0', [{ l: 40, a: 15, b: -60, weight: 1 }]),
    ]

    const result = rankScenesByPalette(scenes, { query: 'red' })

    expect(result.map((item) => item.id)).toEqual(['red:0'])
    expect(result[0]?.signals).toMatchObject({ ranker: 'palette', colorMatch: 'red' })
  })

  it('does not treat mixed content queries as palette-only', () => {
    const scenes = [scene('red:0', [{ l: 53, a: 70, b: 50, weight: 1 }])]
    expect(rankScenesByPalette(scenes, { query: 'red jacket' })).toEqual([])
  })

  it('ranks by an existing reference palette without vectors', () => {
    const red = [{ l: 53, a: 70, b: 50, weight: 1 }]
    const scenes = [scene('warm:0', red), scene('cool:0', [{ l: 40, a: 15, b: -60, weight: 1 }])]

    const result = rankScenesByPalette(scenes, { referencePalette: red })

    expect(result.map((item) => item.id)).toEqual(['warm:0'])
    expect(result[0]?.signals.paletteDistance).toBeDefined()
  })
})
