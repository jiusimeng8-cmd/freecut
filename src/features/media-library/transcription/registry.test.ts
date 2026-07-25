import { describe, expect, it } from 'vite-plus/test'
import { getMediaTranscriptionModelLabel } from './registry'

describe('getMediaTranscriptionModelLabel', () => {
  it('keeps labels for stored transcript metadata', () => {
    expect(getMediaTranscriptionModelLabel('whisper-large')).toBe('Large v3 Turbo')
    expect(getMediaTranscriptionModelLabel('parakeet-tdt-v3')).toBe('Parakeet (fast)')
  })
})
