import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CloudAgentSettingsPopover } from './cloud-agent-settings-popover'
import { useCloudAiSettingsStore } from '@/shared/state/cloud-ai-settings-store'
import { CLOUD_AGENT_PROFILE_OPTIONS } from '../agent/cloud-agent-config-store'

vi.mock('../agent', () => ({
  useAgentStore: (selector: (state: { resetConnection: () => void }) => unknown) =>
    selector({ resetConnection: vi.fn() }),
}))

const [fastOption, expertOption] = CLOUD_AGENT_PROFILE_OPTIONS

function openPopover() {
  useCloudAiSettingsStore.setState({ open: true })
  return render(<CloudAgentSettingsPopover />)
}

describe('CloudAgentSettingsPopover mode control', () => {
  it('exposes the modes as a radio group with exactly one selected', async () => {
    openPopover()

    const group = await screen.findByRole('radiogroup', { name: '工作模式' })
    const radios = screen.getAllByRole('radio')
    expect(group).toBeInTheDocument()
    expect(radios).toHaveLength(CLOUD_AGENT_PROFILE_OPTIONS.length)
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })

  it('moves the selection when the other mode is clicked', async () => {
    const user = userEvent.setup()
    openPopover()

    const fast = await screen.findByRole('radio', { name: fastOption!.label })
    const expert = await screen.findByRole('radio', { name: expertOption!.label })
    expect(fast).toHaveAttribute('aria-checked', 'true')

    await user.click(expert)

    expect(expert).toHaveAttribute('aria-checked', 'true')
    expect(fast).toHaveAttribute('aria-checked', 'false')
  })

  it('renders the mode control after the save button', async () => {
    openPopover()

    const save = await screen.findByRole('button', { name: /保存配置/ })
    const group = await screen.findByRole('radiogroup', { name: '工作模式' })
    // The user asked for the control to sit below the save action; DOCUMENT_POSITION_FOLLOWING
    // is the assertion that survives styling changes, unlike a snapshot of the markup.
    expect(save.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
