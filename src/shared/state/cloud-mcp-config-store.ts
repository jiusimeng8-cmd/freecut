import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DESKTOP_CREDENTIAL_KEYS } from '../../../desktop/desktop-types'

export interface CloudMcpConfig {
  baseUrl: string
  businessKey: string
}

interface CloudMcpConfigState extends CloudMcpConfig {
  businessKeyConfigured: boolean
  updateConfig: (config: CloudMcpConfig) => Promise<void>
  clearConfig: () => Promise<void>
}

const STORAGE_NAME = 'freecut:cloud-bridge-config'
export const BUILT_IN_CLOUD_MCP_BASE_URL =
  import.meta.env.VITE_FREECUT_CLOUD_BASE_URL?.trim().replace(/\/+$/, '') ||
  'https://mcp.123jianhao.com'

const DEFAULT_CONFIG: CloudMcpConfig = {
  baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
  businessKey: import.meta.env.VITE_FREECUT_CLOUD_BUSINESS_KEY ?? '',
}
let desktopCredentialConfigurationRevision = 0

function desktopApi() {
  return typeof window === 'undefined' ? undefined : window.freecutDesktop
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function readLegacyBusinessKey(): string {
  const source = window.localStorage.getItem(STORAGE_NAME)
  if (!source) return ''
  const stored = JSON.parse(source) as { state?: { businessKey?: unknown } }
  return typeof stored.state?.businessKey === 'string' ? stored.state.businessKey.trim() : ''
}

export const useCloudMcpConfigStore = create<CloudMcpConfigState>()(
  persist(
    (set) => ({
      ...DEFAULT_CONFIG,
      businessKeyConfigured: Boolean(DEFAULT_CONFIG.businessKey),
      updateConfig: async (config) => {
        const baseUrl = BUILT_IN_CLOUD_MCP_BASE_URL
        const businessKey = config.businessKey.trim()
        const desktop = desktopApi()
        if (desktop) {
          if (businessKey) {
            await desktop.credentials.set(
              DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey,
              businessKey,
              baseUrl,
            )
          }
          const businessKeyConfigured =
            Boolean(businessKey) ||
            await desktop.credentials.has(
              DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey,
              baseUrl,
            )
          desktopCredentialConfigurationRevision += 1
          set({ baseUrl, businessKey: '', businessKeyConfigured })
          return
        }
        set({
          baseUrl,
          businessKey,
          businessKeyConfigured: Boolean(businessKey),
        })
      },
      clearConfig: async () => {
        const desktop = desktopApi()
        if (desktop) {
          await desktop.credentials.delete(DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey)
          set({
            baseUrl: normalizeBaseUrl(DEFAULT_CONFIG.baseUrl),
            businessKey: '',
            businessKeyConfigured: false,
          })
          desktopCredentialConfigurationRevision += 1
          return
        }
        set({
          ...DEFAULT_CONFIG,
          businessKeyConfigured: Boolean(DEFAULT_CONFIG.businessKey),
        })
      },
    }),
    {
      name: STORAGE_NAME,
      partialize: ({ baseUrl, businessKey }) =>
        desktopApi() ? { baseUrl } : { baseUrl, businessKey },
      merge: (persisted, current) => {
        const stored = persisted as Partial<CloudMcpConfig>
        if (desktopApi()) {
          return {
            ...current,
            baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
            businessKey: '',
            businessKeyConfigured: false,
          }
        }
        const businessKey = stored.businessKey?.trim() ?? current.businessKey
        return {
          ...current,
          ...stored,
          baseUrl: BUILT_IN_CLOUD_MCP_BASE_URL,
          businessKey,
          businessKeyConfigured: Boolean(businessKey),
        }
      },
    },
  ),
)

export async function initializeCloudMcpConfigStore(): Promise<void> {
  const desktop = desktopApi()
  if (!desktop) return
  const revisionAtStart = desktopCredentialConfigurationRevision

  const legacyBusinessKey = readLegacyBusinessKey() || DEFAULT_CONFIG.businessKey.trim()
  if (legacyBusinessKey) {
    await desktop.credentials.set(
      DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey,
      legacyBusinessKey,
      useCloudMcpConfigStore.getState().baseUrl,
    )
  }
  const businessKeyConfigured = await desktop.credentials.has(
    DESKTOP_CREDENTIAL_KEYS.cloudBridgeBusinessKey,
    useCloudMcpConfigStore.getState().baseUrl,
  )
  if (revisionAtStart !== desktopCredentialConfigurationRevision) return
  useCloudMcpConfigStore.setState({
    businessKey: '',
    businessKeyConfigured,
  })
}

export function getCloudMcpConfig(): CloudMcpConfig {
  const { baseUrl, businessKey } = useCloudMcpConfigStore.getState()
  return { baseUrl, businessKey }
}

export function isCloudMcpConfigured(config = getCloudMcpConfig()): boolean {
  const hasBusinessKey = desktopApi()
    ? useCloudMcpConfigStore.getState().businessKeyConfigured
    : Boolean(config.businessKey.trim())
  return Boolean(config.baseUrl.trim() && hasBusinessKey)
}
