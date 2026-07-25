import { describe, expect, it, vi } from 'vitest'
import {
  compareReleaseVersions,
  UpdateNotificationService,
} from './update-notification-service'

describe('compareReleaseVersions', () => {
  it('compares numeric release components', () => {
    expect(compareReleaseVersions('1.2.0', '1.1.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.0.1', '1.0.1')).toBe(0)
    expect(compareReleaseVersions('1.0.0', '2.0.0')).toBeLessThan(0)
  })
})

describe('UpdateNotificationService', () => {
  it('returns a newer release from a HTTPS manifest', async () => {
    const fetchManifest = vi.fn(async () =>
      Response.json({
        version: '1.0.2',
        downloadUrl: 'https://downloads.example.com/freecut',
        notes: 'Prototype update',
      }),
    )
    const service = new UpdateNotificationService(
      'https://updates.example.com/version.json',
      '1.0.1',
      fetchManifest,
    )

    await expect(service.check()).resolves.toEqual({
      version: '1.0.2',
      downloadUrl: 'https://downloads.example.com/freecut',
      notes: 'Prototype update',
    })
  })

  it('returns null when the installed version is current', async () => {
    const service = new UpdateNotificationService(
      'https://updates.example.com/version.json',
      '1.0.1',
      async () =>
        Response.json({
          version: '1.0.1',
          downloadUrl: 'https://downloads.example.com/freecut',
        }),
    )

    await expect(service.check()).resolves.toBeNull()
  })

  it('rejects non-HTTPS download links', async () => {
    const service = new UpdateNotificationService(
      'https://updates.example.com/version.json',
      '1.0.1',
      async () =>
        Response.json({
          version: '1.0.2',
          downloadUrl: 'http://downloads.example.com/freecut',
        }),
    )

    await expect(service.check()).rejects.toThrow()
  })
})
