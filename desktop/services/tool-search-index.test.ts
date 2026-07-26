// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { expandQueryTerms, hasChineseCharacters, scoreToolForQuery } from './tool-search-index'

const PLACE_MEDIA = {
  name: 'place_media',
  title: 'Place media on timeline',
  category: 'media',
  description:
    'Place existing media-library items sequentially at an exact time and track with default, cover, contain, or picture-in-picture layout.',
}

const DELETE_TRACK = {
  name: 'delete_track',
  title: 'Delete timeline track',
  category: 'timeline',
  description: 'Delete an active-timeline track and every item, transition, and keyframe owned by it.',
}

const CATALOG = [PLACE_MEDIA, DELETE_TRACK]

/** Ranks the catalog the way the search tool does, so tests assert on order. */
function bestMatch(query: string): string | null {
  const ranked = CATALOG.map((tool) => ({ tool, score: scoreToolForQuery(tool, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
  return ranked[0]?.tool.name ?? null
}

describe('tool search query expansion', () => {
  it('scores a Chinese query that shares no character with the catalog', () => {
    // The original scorer returned 0 here, which is what sent the loop
    // rewording the same request until it ran out of rounds.
    expect(scoreToolForQuery(PLACE_MEDIA, '将媒体库素材添加到时间轴')).toBeGreaterThan(0)
  })

  it('ranks the placement tool first for the request that failed in production', () => {
    expect(bestMatch('将媒体库素材添加到时间轴')).toBe('place_media')
  })

  it('segments Chinese without spaces to reach the embedded terms', () => {
    // No delimiter exists to split on, so this only works via substring lookup.
    expect(expandQueryTerms('把素材放到时间轴上')).toEqual(
      expect.arrayContaining(['media', 'clip', 'place', 'timeline']),
    )
  })

  it('still scores English queries and keeps name above description', () => {
    // `place_media` matches the name (+4); `delete_track` only the description.
    expect(scoreToolForQuery(PLACE_MEDIA, 'place')).toBeGreaterThan(
      scoreToolForQuery(DELETE_TRACK, 'place'),
    )
  })

  it('keeps the caller original terms alongside the expansions', () => {
    expect(expandQueryTerms('place 时间轴')).toEqual(
      expect.arrayContaining(['place', 'timeline']),
    )
  })

  it('deduplicates when a term and its expansion coincide', () => {
    const terms = expandQueryTerms('timeline 时间轴')
    expect(terms.filter((term) => term === 'timeline')).toHaveLength(1)
  })

  it('distinguishes distinct Chinese requests instead of matching everything', () => {
    expect(bestMatch('删除轨道')).toBe('delete_track')
    expect(bestMatch('放入时间轴')).toBe('place_media')
  })

  it('scores nothing for an empty or whitespace-only query', () => {
    expect(scoreToolForQuery(PLACE_MEDIA, '')).toBe(0)
    expect(scoreToolForQuery(PLACE_MEDIA, '   ')).toBe(0)
  })

  it('scores nothing for Chinese outside the lexicon, so the caller can fall back', () => {
    // The tool falls back to an unranked catalog slice on a total miss; that
    // only works if an unknown query genuinely scores zero rather than
    // matching something arbitrary.
    expect(scoreToolForQuery(PLACE_MEDIA, '天气怎么样')).toBe(0)
  })

  it('detects Han characters to identify a query that cannot match raw English', () => {
    expect(hasChineseCharacters('时间轴')).toBe(true)
    expect(hasChineseCharacters('place media')).toBe(false)
  })
})
