import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { i18n } from '@/i18n'
import type {
  DesktopUpdateStatus,
  FreeCutDesktopApi,
} from '../../../../desktop/desktop-types'
import { DesktopAppControls } from './desktop-app-controls'

const availableStatus: DesktopUpdateStatus = {
  phase: 'available',
  currentVersion: '1.0.1',
  availableVersion: '1.0.2',
  updatedAt: 1,
}

const downloadedStatus: DesktopUpdateStatus = {
  phase: 'downloaded',
  currentVersion: '1.0.1',
  availableVersion: '1.0.2',
  progressPercent: 100,
  updatedAt: 2,
}

let statusListener: ((status: DesktopUpdateStatus) => void) | null = null
const getStatus = vi.fn()
const check = vi.fn()
const download = vi.fn()
const install = vi.fn()
const diagnosticsExport = vi.fn()

function installDesktopApi(): void {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: {
      updates: {
        getStatus,
        check,
        download,
        install,
        onStatus: (listener: (status: DesktopUpdateStatus) => void) => {
          statusListener = listener
          return () => {
            statusListener = null
          }
        },
      },
      diagnostics: {
        export: diagnosticsExport,
      },
    } as unknown as FreeCutDesktopApi,
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  statusListener = null
  getStatus.mockReset().mockResolvedValue(availableStatus)
  check.mockReset()
  download.mockReset().mockResolvedValue(downloadedStatus)
  install.mockReset().mockResolvedValue(undefined)
  diagnosticsExport.mockReset().mockResolvedValue('C:\\FreeCut-Diagnostics')
  installDesktopApi()
})

afterEach(() => {
  Object.defineProperty(window, 'freecutDesktop', {
    configurable: true,
    value: undefined,
  })
})

describe('DesktopAppControls', () => {
  it('downloads an available update and exposes restart installation', async () => {
    render(<DesktopAppControls />)

    expect(await screen.findByText('Version 1.0.1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }))

    await waitFor(() => expect(download).toHaveBeenCalledOnce())
    expect(await screen.findByText('Version 1.0.2 is ready to install.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }))
    await waitFor(() => expect(install).toHaveBeenCalledOnce())
  })

  it('renders progress events and exports desktop diagnostics', async () => {
    render(<DesktopAppControls />)
    await screen.findByText('Version 1.0.1')

    act(() => {
      statusListener?.({
        phase: 'downloading',
        currentVersion: '1.0.1',
        availableVersion: '1.0.2',
        progressPercent: 42,
        updatedAt: 3,
      })
    })

    expect(screen.getByText('Downloading update: 42%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(diagnosticsExport).toHaveBeenCalledOnce())
  })
})
