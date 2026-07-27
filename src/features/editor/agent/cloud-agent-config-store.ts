import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CloudAgentConfigState {
  profileId: string
  autoApprove: boolean
  updateProfileId: (profileId: string) => void
  updateAutoApprove: (autoApprove: boolean) => void
}

export interface CloudAgentProfileOption {
  id: string
  label: string
}

const FAST_AGENT_PROFILE_ID =
  import.meta.env.VITE_FREECUT_AGENT_FAST_PROFILE_ID?.trim() || 'smart-edit-fast'
const EXPERT_AGENT_PROFILE_ID =
  import.meta.env.VITE_FREECUT_AGENT_EXPERT_PROFILE_ID?.trim() || 'smart-edit-expert'

export const CLOUD_AGENT_PROFILE_OPTIONS: readonly CloudAgentProfileOption[] = [
  { id: FAST_AGENT_PROFILE_ID, label: '快速' },
  { id: EXPERT_AGENT_PROFILE_ID, label: '专家X2' },
]

export const DEFAULT_AGENT_PROFILE_ID =
  import.meta.env.VITE_FREECUT_AGENT_PROFILE_ID?.trim() || FAST_AGENT_PROFILE_ID

export const useCloudAgentConfigStore = create<CloudAgentConfigState>()(
  persist(
    (set) => ({
      profileId: DEFAULT_AGENT_PROFILE_ID,
      autoApprove: false,
      updateProfileId: (profileId) => set({ profileId: profileId.trim() }),
      updateAutoApprove: (autoApprove) => set({ autoApprove }),
    }),
    {
      name: 'freecut:agent-profile',
      partialize: ({ profileId, autoApprove }) => ({ profileId, autoApprove }),
    },
  ),
)

export function getCloudAgentProfileId(): string {
  return useCloudAgentConfigStore.getState().profileId
}
