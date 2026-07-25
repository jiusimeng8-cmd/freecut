// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { DESKTOP_CREDENTIAL_KEYS } from './desktop-types'

afterEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: undefined,
  })
  vi.resetModules()
})

function installDesktopCredentials() {
  const values = new Map<string, string>()
  const credentials = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    has: vi.fn(async (key: string) => values.has(key)),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: {
      app: { isDesktop: true },
      credentials,
    },
  })
  return credentials
}

describe('Desktop credential config stores', () => {
  it('migrates a legacy Bridge key and removes it from Renderer persistence', async () => {
    const credentials = installDesktopCredentials()
    window.localStorage.setItem(
      'freecut:cloud-bridge-config',
      JSON.stringify({
        state: {
          baseUrl: 'https://api.freecut.example',
          businessKey: 'legacy-business-key',
        },
        version: 0,
      }),
    )
    const module = await import('../src/shared/state/cloud-mcp-config-store')

    await module.initializeCloudMcpConfigStore()

    expect(credentials.set).toHaveBeenCalledWith(
      DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey,
      'legacy-business-key',
      'https://mcp.123jianhao.com',
    )
    expect(module.useCloudMcpConfigStore.getState()).toEqual(
      expect.objectContaining({
        baseUrl: 'https://mcp.123jianhao.com',
        businessKey: '',
        businessKeyConfigured: true,
      }),
    )
    expect(window.localStorage.getItem('freecut:cloud-bridge-config')).not.toContain(
      'legacy-business-key',
    )
  })

  it('does not let a delayed startup credential check overwrite a later save', async () => {
    const values = new Map<string, string>()
    let resolveInitialHas: ((value: boolean) => void) | undefined
    let hasCalls = 0
    const credentials = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      has: vi.fn(async (key: string) => {
        hasCalls += 1
        if (hasCalls === 1) {
          return new Promise<boolean>((resolve) => {
            resolveInitialHas = resolve
          })
        }
        return values.has(key)
      }),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value)
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key)
      }),
    }
    Object.defineProperty(window, 'freecutDesktop', {
      configurable: true,
      value: {
        app: { isDesktop: true },
        credentials,
      },
    })
    const module = await import('../src/shared/state/cloud-mcp-config-store')

    const initializing = module.initializeCloudMcpConfigStore()
    await Promise.resolve()

    await module.useCloudMcpConfigStore.getState().updateConfig({
      baseUrl: 'https://mcp.123jianhao.com',
      businessKey: 'new-business-key',
    })
    resolveInitialHas?.(false)
    await initializing

    expect(module.useCloudMcpConfigStore.getState()).toEqual(
      expect.objectContaining({
        businessKey: '',
        businessKeyConfigured: true,
      }),
    )
  })
})
