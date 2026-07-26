// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import { extractToolCallPath } from './tool-call-path'

describe('extractToolCallPath', () => {
  it('extracts an absolute Windows path', () => {
    expect(extractToolCallPath({ path: 'C:\\Users\\me\\Desktop\\clips' })).toBe(
      'C:\\Users\\me\\Desktop\\clips',
    )
  })

  it('trims surrounding whitespace', () => {
    expect(extractToolCallPath({ path: '  C:\\media  ' })).toBe('C:\\media')
  })

  it('ignores relative paths so nothing outside the stated intent is authorized', () => {
    expect(extractToolCallPath({ path: 'clips' })).toBeNull()
    expect(extractToolCallPath({ path: '..\\..\\secrets' })).toBeNull()
    expect(extractToolCallPath({ path: './media' })).toBeNull()
  })

  it('ignores empty, blank, and NUL-bearing values', () => {
    expect(extractToolCallPath({ path: '' })).toBeNull()
    expect(extractToolCallPath({ path: '   ' })).toBeNull()
    expect(extractToolCallPath({ path: 'C:\\media\0.txt' })).toBeNull()
  })

  it('ignores non-string and missing path fields', () => {
    expect(extractToolCallPath({ path: 42 })).toBeNull()
    expect(extractToolCallPath({ path: null })).toBeNull()
    expect(extractToolCallPath({ path: ['C:\\media'] })).toBeNull()
    expect(extractToolCallPath({ preset: 'cinematic' })).toBeNull()
    expect(extractToolCallPath({})).toBeNull()
  })

  it('ignores non-object arguments', () => {
    expect(extractToolCallPath(undefined)).toBeNull()
    expect(extractToolCallPath(null)).toBeNull()
    expect(extractToolCallPath('C:\\media')).toBeNull()
    expect(extractToolCallPath(['C:\\media'])).toBeNull()
  })
})
