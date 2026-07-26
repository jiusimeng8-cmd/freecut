import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILT_IN_CLOUD_MCP_BASE_URL,
  isCloudMcpConfigured,
  useCloudMcpConfigStore,
} from './cloud-mcp-config-store'

const STORAGE_NAME = 'freecut:cloud-bridge-config'

function setDesktopApi(credentials: {
  set: (key: string, value: string, baseUrl?: string) => Promise<void>
  has: (key: string, baseUrl?: string) => Promise<boolean>
  delete: (key: string) => Promise<void>
}) {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: { credentials },
  })
}

function clearDesktopApi() {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'freecutDesktop')
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_NAME)
  useCloudMcpConfigStore.setState({
    baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
    businessKey: '',
    businessKeyConfigured: false,
  })
})

afterEach(() => {
  clearDesktopApi()
})

describe('cloud MCP key configuration on desktop', () => {
  it('reports configured after a save even though the plaintext key is cleared', async () => {
    const stored = new Map<string, string>()
    setDesktopApi({
      set: async (key, value) => {
        stored.set(key, value)
      },
      has: async (key) => stored.has(key),
      delete: async (key) => {
        stored.delete(key)
      },
    })

    await useCloudMcpConfigStore.getState().updateConfig({
      baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
      businessKey: 'sk-desktop-key',
    })

    const state = useCloudMcpConfigStore.getState()
    // The renderer must not retain the plaintext key.
    expect(state.businessKey).toBe('')
    // ...so this flag is the only signal that the key exists.
    expect(state.businessKeyConfigured).toBe(true)
    expect(isCloudMcpConfigured({ baseUrl: state.baseUrl, businessKey: state.businessKey })).toBe(
      true,
    )
  })

  it('honours an explicitly passed configured flag so subscribers drive the result', () => {
    setDesktopApi({
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
    })
    const config = { baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL, businessKey: '' }

    expect(isCloudMcpConfigured(config, true)).toBe(true)
    expect(isCloudMcpConfigured(config, false)).toBe(false)
  })

  it('reports not configured after the key is cleared', async () => {
    const stored = new Map<string, string>([['cloud-bridge.business-key', 'cipher']])
    setDesktopApi({
      set: async (key, value) => {
        stored.set(key, value)
      },
      has: async (key) => stored.has(key),
      delete: async (key) => {
        stored.delete(key)
      },
    })
    useCloudMcpConfigStore.setState({ businessKeyConfigured: true })

    await useCloudMcpConfigStore.getState().clearConfig()

    const state = useCloudMcpConfigStore.getState()
    expect(state.businessKeyConfigured).toBe(false)
    expect(isCloudMcpConfigured({ baseUrl: state.baseUrl, businessKey: '' })).toBe(false)
  })
})
