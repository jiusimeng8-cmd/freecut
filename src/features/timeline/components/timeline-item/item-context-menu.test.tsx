import type { ComponentProps, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { fireEvent, render, screen } from '@testing-library/react'
import { useSelectionStore } from '@/shared/state/selection'
import { ItemContextMenu } from './item-context-menu'

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => null,
  ContextMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ContextMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/features/timeline/deps/settings', () => ({
  useResolvedHotkeys: () => ({}),
}))

vi.mock('@/config/hotkeys', () => ({
  formatHotkeyBinding: () => '',
}))

function renderContextMenu(overrides: Partial<ComponentProps<typeof ItemContextMenu>> = {}) {
  const onDetectScenes = vi.fn()

  render(
    <ItemContextMenu
      trackLocked={false}
      joinActions={{
        canJoinSelected: false,
        hasJoinableLeft: false,
        hasJoinableRight: false,
        closerEdge: null,
        onJoinSelected: () => {},
        onJoinLeft: () => {},
        onJoinRight: () => {},
      }}
      destructiveActions={{
        isSelected: true,
        onRippleDelete: () => {},
        onDelete: () => {},
      }}
      sceneDetectionActions={{
        canDetectScenes: true,
        isDetectingScenes: false,
        onDetectScenes,
      }}
      {...overrides}
    >
      <div>Clip</div>
    </ItemContextMenu>,
  )

  fireEvent.contextMenu(screen.getByText('Clip'))

  return { onDetectScenes }
}

describe('ItemContextMenu scene detection', () => {
  beforeEach(() => {
    useSelectionStore.setState({
      selectedItemIds: [],
      selectedMarkerId: null,
      selectedTransitionId: null,
      selectedTrackId: null,
      selectedTrackIds: [],
      activeTrackId: null,
      selectionType: null,
    })
  })

  it('renders the algorithmic scene detection options', () => {
    renderContextMenu()

    expect(screen.getByText('Detect Scenes & Split')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fast (Histogram)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Optical Flow' })).toBeInTheDocument()
  })

  it('dispatches optical-flow scene detection', () => {
    const { onDetectScenes } = renderContextMenu()

    fireEvent.click(screen.getByRole('button', { name: 'Optical Flow' }))

    expect(onDetectScenes).toHaveBeenCalledWith('optical-flow')
  })
})

describe('ItemContextMenu captions', () => {
  it('does not show transcript generation actions', () => {
    renderContextMenu({ captionActions: {} })

    expect(screen.queryByRole('button', { name: 'Generate Captions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Regenerate Captions' })).not.toBeInTheDocument()
  })

  it('keeps embedded subtitle extraction available', () => {
    const onExtractEmbeddedSubtitles = vi.fn()

    renderContextMenu({
      captionActions: {
        canExtractEmbeddedSubtitles: true,
        onExtractEmbeddedSubtitles,
      },
    })

    const item = screen.getByRole('button', { name: 'Extract Embedded Subtitles' })
    fireEvent.click(item)
    expect(onExtractEmbeddedSubtitles).toHaveBeenCalledTimes(1)
  })
})
