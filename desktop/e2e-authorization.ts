import { dirname, isAbsolute, resolve } from 'node:path'

export const DEFAULT_E2E_WORKSPACE_ROOT = 'C:\\tmp\\freecut-local-e2e-fixture'
const DEFAULT_E2E_USER_DATA_PREFIX = 'C:\\tmp\\freecut-local-e2e-userdata-'

function normalizedAbsolutePath(value: string | undefined, label: string): string {
  const candidate = value?.trim()
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path.`)
  }
  return resolve(candidate)
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function isTrustedE2eAuthorization(input: {
  enabled: boolean
  projectId?: string
  configuredWorkspaceRoot?: string
  requestedWorkspaceRoot?: string
  actualWorkspaceRoot?: string
  requestedUserDataPath?: string
  actualUserDataPath?: string
}): boolean {
  if (!input.enabled || input.projectId !== 'local-e2e-fixture') return false

  const explicitWorkspaceRoot = input.configuredWorkspaceRoot?.trim()
  const expectedWorkspaceRoot = normalizedAbsolutePath(
    explicitWorkspaceRoot || DEFAULT_E2E_WORKSPACE_ROOT,
    'FREECUT_E2E_WORKSPACE_ROOT',
  )
  const requestedWorkspaceRoot = normalizedAbsolutePath(
    input.requestedWorkspaceRoot,
    'FREECUT_E2E_WORKSPACE',
  )
  const actualWorkspaceRoot = normalizedAbsolutePath(
    input.actualWorkspaceRoot,
    'E2E workspace handle root',
  )
  if (
    !samePath(expectedWorkspaceRoot, requestedWorkspaceRoot) ||
    !samePath(expectedWorkspaceRoot, actualWorkspaceRoot)
  ) {
    return false
  }

  const requestedUserDataPath = normalizedAbsolutePath(
    input.requestedUserDataPath,
    'FREECUT_E2E_USER_DATA',
  )
  const actualUserDataPath = normalizedAbsolutePath(
    input.actualUserDataPath,
    'Electron userData path',
  )
  if (!samePath(requestedUserDataPath, actualUserDataPath)) return false

  if (explicitWorkspaceRoot) {
    return samePath(actualUserDataPath, resolve(dirname(expectedWorkspaceRoot), 'userdata'))
  }
  return actualUserDataPath
    .toLowerCase()
    .startsWith(resolve(DEFAULT_E2E_USER_DATA_PREFIX).toLowerCase())
}
