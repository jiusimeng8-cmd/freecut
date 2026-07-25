// @vitest-environment node

import { describe, expect, it } from 'vite-plus/test'
import {
  DEFAULT_E2E_WORKSPACE_ROOT,
  isTrustedE2eAuthorization,
} from './e2e-authorization'

describe('Electron E2E authorization paths', () => {
  it('keeps the historical fixture and userData prefix as the default', () => {
    expect(
      isTrustedE2eAuthorization({
        enabled: true,
        projectId: 'local-e2e-fixture',
        requestedWorkspaceRoot: DEFAULT_E2E_WORKSPACE_ROOT,
        actualWorkspaceRoot: DEFAULT_E2E_WORKSPACE_ROOT,
        requestedUserDataPath: 'C:\\tmp\\freecut-local-e2e-userdata-default',
        actualUserDataPath: 'C:\\tmp\\freecut-local-e2e-userdata-default',
      }),
    ).toBe(true)
  })

  it('accepts an explicit run workspace only with its exact handle root and sibling userData', () => {
    const runRoot = 'C:\\tmp\\jianhao-local-first-e2e-20260722-5cf09f04'
    const workspaceRoot = `${runRoot}\\workspace`
    const userDataPath = `${runRoot}\\userdata`

    expect(
      isTrustedE2eAuthorization({
        enabled: true,
        projectId: 'local-e2e-fixture',
        configuredWorkspaceRoot: workspaceRoot,
        requestedWorkspaceRoot: workspaceRoot,
        actualWorkspaceRoot: workspaceRoot,
        requestedUserDataPath: userDataPath,
        actualUserDataPath: userDataPath,
      }),
    ).toBe(true)
  })

  it('rejects an explicit root when the actual workspace handle points elsewhere', () => {
    const runRoot = 'C:\\tmp\\jianhao-local-first-e2e-20260722-5cf09f04'
    const workspaceRoot = `${runRoot}\\workspace`
    const userDataPath = `${runRoot}\\userdata`

    expect(
      isTrustedE2eAuthorization({
        enabled: true,
        projectId: 'local-e2e-fixture',
        configuredWorkspaceRoot: workspaceRoot,
        requestedWorkspaceRoot: workspaceRoot,
        actualWorkspaceRoot: 'C:\\tmp\\different-workspace',
        requestedUserDataPath: userDataPath,
        actualUserDataPath: userDataPath,
      }),
    ).toBe(false)
  })
})
