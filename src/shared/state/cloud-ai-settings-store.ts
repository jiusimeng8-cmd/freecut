import { create } from 'zustand'

interface CloudAiSettingsState {
  open: boolean
  openSettings: () => void
  closeSettings: () => void
}

export const useCloudAiSettingsStore = create<CloudAiSettingsState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
}))
