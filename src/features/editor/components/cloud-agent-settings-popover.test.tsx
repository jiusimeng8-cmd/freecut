import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CloudAgentSettingsPopover, ModeSegmentedControl } from './cloud-agent-settings-popover'
import { CLOUD_AGENT_PROFILE_OPTIONS } from '../agent/cloud-agent-config-store'

vi.mock('../agent', () => ({
  useAgentStore: (selector: (state: { resetConnection: () => void }) => unknown) =>
    selector({ resetConnection: vi.fn() }),
}))

const [fastOption, expertOption] = CLOUD_AGENT_PROFILE_OPTIONS

describe('CloudAgentSettingsPopover mode control', () => {
  it('shows both modes and announces the current selection', async () => {
    render(<ModeSegmentedControl value={fastOption!.id} onChange={vi.fn()} />)

    const toggle = await screen.findByRole('button', {
      name: `工作模式，当前${fastOption!.label}，点击切换`,
    })
    expect(toggle).toHaveTextContent(fastOption!.label)
    expect(toggle).toHaveTextContent(expertOption!.label)
  })

  it('switches to the other mode when the control is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModeSegmentedControl value={fastOption!.id} onChange={onChange} />)

    const toggle = await screen.findByRole('button', {
      name: `工作模式，当前${fastOption!.label}，点击切换`,
    })
    await user.click(toggle)

    expect(onChange).toHaveBeenCalledWith(expertOption!.id)
  })

  it('does not render the mode control inside the settings popover', () => {
    render(<CloudAgentSettingsPopover />)

    expect(screen.queryByRole('button', { name: /工作模式，当前/ })).not.toBeInTheDocument()
  })
})
