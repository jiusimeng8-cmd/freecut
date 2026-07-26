import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLocalHandles: vi.fn(),
  importHandles: vi.fn(),
  getBreakdown: vi.fn(),
  getProject: vi.fn(),
  loadMediaItems: vi.fn(),
  setCurrentProject: vi.fn(),
}))

vi.mock('@/infrastructure/storage/dev-workspace-handle', () => ({
  getDevLocalMediaHandles: mocks.getLocalHandles,
}))

vi.mock('@/features/editor/deps/media-library', () => ({
  getLastImportBreakdown: mocks.getBreakdown,
  getSharedProxyKey: vi.fn(),
  importMediaLibraryService: vi.fn(),
  mediaTranscriptionService: {},
  proxyService: {},
  useMediaLibraryStore: {
    getState: () => ({
      currentProjectId: 'project-1',
      importHandles: mocks.importHandles,
      setCurrentProject: mocks.setCurrentProject,
      loadMediaItems: mocks.loadMediaItems,
      mediaById: {},
    }),
  },
}))

vi.mock('@/features/editor/deps/projects', () => ({
  getProject: mocks.getProject,
  useProjectStore: { getState: () => ({ currentProject: { id: 'project-1' } }) },
}))

vi.mock('@/features/editor/deps/timeline-contract', () => ({
  getMediaDeletionImpact: vi.fn(),
  removeProjectItems: vi.fn(),
  useTimelineStore: { getState: () => ({}) },
}))

import { MEDIA_MANAGEMENT_PLATFORM_TOOLS } from './media-management-tools'

const importTool = MEDIA_MANAGEMENT_PLATFORM_TOOLS.find(
  (tool) => tool.name === 'import_media_files',
)!

async function runImport() {
  return (await importTool.execute({ path: 'C:\\clips' } as never)) as {
    ok: boolean
    message: string
    changed: boolean
    error?: { code: string }
  }
}

describe('import_media_files zero-result reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProject.mockResolvedValue({ id: 'project-1' })
    // Eight files found on disk, none returned as newly imported.
    mocks.getLocalHandles.mockResolvedValue(Array.from({ length: 8 }, () => ({ name: 'x.mp4' })))
    mocks.importHandles.mockResolvedValue([])
  })

  it('says the files are already in the library when all were duplicates', async () => {
    mocks.getBreakdown.mockReturnValue({
      requested: 8,
      imported: 0,
      duplicates: Array.from({ length: 8 }, (_, i) => `clip-${i}.mp4`),
      failed: 0,
    })

    const result = await runImport()

    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.error?.code).toBe('MEDIA_ALREADY_IMPORTED')
    expect(result.message).toContain('already in this project')
    // Must not blame the format when nothing was malformed.
    expect(result.message).not.toContain('unsupported')
    expect(result.message).toContain('clip-0.mp4')
    // Long lists are truncated rather than dumping every name.
    expect(result.message).toContain('5 more')
  })

  it('blames the failures, not duplication, when files actually failed', async () => {
    mocks.getBreakdown.mockReturnValue({
      requested: 8,
      imported: 0,
      duplicates: [],
      failed: 8,
    })

    const result = await runImport()

    expect(result.error?.code).toBe('NO_MEDIA_IMPORTED')
    expect(result.message).toContain('8 failed to import')
    expect(result.message).not.toContain('already in this project')
  })

  it('reports both counts in a mixed duplicate-and-failure import', async () => {
    mocks.getBreakdown.mockReturnValue({
      requested: 8,
      imported: 0,
      duplicates: ['a.mp4', 'b.mp4'],
      failed: 6,
    })

    const result = await runImport()

    expect(result.error?.code).toBe('NO_MEDIA_IMPORTED')
    expect(result.message).toContain('6 failed to import')
    expect(result.message).toContain('2 were already in the library')
  })

  it('falls back to the generic reason when no breakdown is available', async () => {
    mocks.getBreakdown.mockReturnValue(null)

    const result = await runImport()

    expect(result.error?.code).toBe('NO_MEDIA_IMPORTED')
    expect(result.message).toContain('none could be imported')
  })

  it('still reports success when media was imported', async () => {
    mocks.importHandles.mockResolvedValue([{ id: 'media-1' }])
    mocks.getBreakdown.mockReturnValue({
      requested: 8,
      imported: 1,
      duplicates: [],
      failed: 7,
    })

    const result = await runImport()

    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
  })
})
