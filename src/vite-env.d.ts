/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FREECUT_CLOUD_BASE_URL?: string
  readonly VITE_FREECUT_CLOUD_BUSINESS_KEY?: string
  readonly VITE_FREECUT_AI_BUSINESS_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  readonly freecutDesktop?: import('../desktop/desktop-types').FreeCutDesktopApi
}
