import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@tanstack/react-router'

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
}))

vi.mock('@/infrastructure/storage', () => ({
  getProject: mocks.getProject,
}))

vi.mock('@/shared/projects/migrations', () => ({
  CURRENT_SCHEMA_VERSION: 13,
}))

import { Route } from './$projectId'

async function runLoader(projectId: string) {
  const loader = Route.options.loader
  if (typeof loader !== 'function') throw new Error('Editor route loader is not configured.')
  return loader({ params: { projectId } } as never)
}

describe('editor project route loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects a missing project back to the projects page', async () => {
    mocks.getProject.mockResolvedValue(null)

    let thrown: unknown
    try {
      await runLoader('missing-project')
    } catch (error) {
      thrown = error
    }

    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options?: unknown }).options).toMatchObject({
      to: '/projects',
      replace: true,
    })
  })

  it('returns editor metadata for an existing project', async () => {
    mocks.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'Project 1',
      schemaVersion: 12,
      metadata: {
        width: 1920,
        height: 1080,
        fps: 30,
        backgroundColor: '#000000',
      },
    })

    await expect(runLoader('project-1')).resolves.toMatchObject({
      project: {
        id: 'project-1',
        name: 'Project 1',
        width: 1920,
        height: 1080,
        fps: 30,
      },
      migration: {
        storedSchemaVersion: 12,
        currentSchemaVersion: 13,
        requiresUpgrade: true,
      },
    })
  })
})
