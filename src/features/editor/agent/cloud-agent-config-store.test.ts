import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLOUD_AGENT_PROFILE_OPTIONS,
  DEFAULT_AGENT_PROFILE_ID,
  getCloudAgentProfileId,
  useCloudAgentConfigStore,
} from './cloud-agent-config-store'

beforeEach(() => {
  localStorage.removeItem('freecut:agent-profile')
  useCloudAgentConfigStore.setState({
    profileId: DEFAULT_AGENT_PROFILE_ID,
    autoApprove: false,
  })
})

describe('cloud agent profile configuration', () => {
  it('defaults to the deployed editing profile', () => {
    expect(DEFAULT_AGENT_PROFILE_ID).toBe('smart-edit-fast')
  })

  it('exposes fast and expert product profiles without binding an upstream model', () => {
    expect(CLOUD_AGENT_PROFILE_OPTIONS).toEqual([
      { id: 'smart-edit-fast', label: '快速' },
      { id: 'smart-edit-expert', label: '专家X2' },
    ])
  })

  it('persists the selected profile and auto-approval preference', () => {
    useCloudAgentConfigStore.getState().updateProfileId('multimodal-editing-director')
    useCloudAgentConfigStore.getState().updateAutoApprove(true)

    expect(getCloudAgentProfileId()).toBe('multimodal-editing-director')
    expect(JSON.parse(localStorage.getItem('freecut:agent-profile') ?? '{}')).toEqual({
      state: {
        profileId: 'multimodal-editing-director',
        autoApprove: true,
      },
      version: 0,
    })
  })
})
