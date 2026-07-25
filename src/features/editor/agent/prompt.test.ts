import { describe, expect, it } from 'vitest'
import { buildMessages } from './prompt'

describe('buildMessages', () => {
  it('directs subtitle requests to the structured caption tool', () => {
    const [system] = buildMessages([], '给全部素材加字幕', 'Clips: none.')

    expect(system?.role).toBe('system')
    expect(system?.content).toContain('generate_captions')
  })
})
