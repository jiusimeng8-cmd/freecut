import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileArchive, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { installDesktopUpdateSafely } from '@/shared/desktop/install-update'

type DesktopApi = NonNullable<Window['freecutDesktop']>
type DesktopUpdateStatus = Awaited<ReturnType<DesktopApi['updates']['getStatus']>>

function updateStatusText(
  t: ReturnType<typeof useTranslation>['t'],
  status: DesktopUpdateStatus,
): string {
  switch (status.phase) {
    case 'disabled':
      return t('settings.desktop.status.disabled')
    case 'checking':
      return t('settings.desktop.status.checking')
    case 'available':
      return t('settings.desktop.status.available', { version: status.availableVersion })
    case 'downloading':
      return t('settings.desktop.status.downloading', {
        percent: Math.round(status.progressPercent ?? 0),
      })
    case 'downloaded':
      return t('settings.desktop.status.downloaded', { version: status.availableVersion })
    case 'up-to-date':
      return t('settings.desktop.status.upToDate')
    case 'installing':
      return t('settings.desktop.status.installing')
    case 'error':
      return t('settings.desktop.status.error')
    default:
      return t('settings.desktop.status.idle')
  }
}

export function DesktopAppControls() {
  const { t } = useTranslation()
  const desktop = window.freecutDesktop
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [updateActionPending, setUpdateActionPending] = useState(false)
  const [diagnosticsPending, setDiagnosticsPending] = useState(false)

  const applyStatus = useCallback((next: DesktopUpdateStatus) => {
    setStatus((current) => (!current || next.updatedAt >= current.updatedAt ? next : current))
  }, [])

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    const unsubscribe = desktop.updates.onStatus((next) => {
      if (!disposed) applyStatus(next)
    })
    void desktop.updates
      .getStatus()
      .then((next) => {
        if (!disposed) applyStatus(next)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [applyStatus, desktop])

  if (!desktop) return null

  const phase = status?.phase ?? 'idle'
  const updateBusy =
    updateActionPending ||
    phase === 'checking' ||
    phase === 'downloading' ||
    phase === 'installing'

  const handleUpdateAction = async () => {
    if (!status || updateBusy || phase === 'disabled') return
    setUpdateActionPending(true)
    try {
      if (phase === 'available') {
        applyStatus(await desktop.updates.download())
      } else if (phase === 'downloaded') {
        await installDesktopUpdateSafely()
      } else {
        applyStatus(await desktop.updates.check())
      }
    } catch {
      toast.error(t('settings.desktop.updateFailed'))
    } finally {
      setUpdateActionPending(false)
    }
  }

  const handleDiagnosticsExport = async () => {
    setDiagnosticsPending(true)
    try {
      const outputPath = await desktop.diagnostics.export()
      if (outputPath) {
        toast.success(t('settings.desktop.diagnostics.exported'), {
          description: outputPath,
        })
      }
    } catch {
      toast.error(t('settings.desktop.diagnostics.exportFailed'))
    } finally {
      setDiagnosticsPending(false)
    }
  }

  const UpdateIcon =
    phase === 'available'
      ? Download
      : phase === 'downloaded'
        ? RotateCcw
        : updateBusy
          ? Loader2
          : RefreshCw
  const updateActionLabel =
    phase === 'available'
      ? t('settings.desktop.actions.download')
      : phase === 'downloaded'
        ? t('settings.desktop.actions.restartInstall')
        : updateBusy
          ? phase === 'downloading'
            ? t('settings.desktop.actions.downloading')
            : phase === 'installing'
              ? t('settings.desktop.actions.installing')
              : t('settings.desktop.actions.checking')
          : t('settings.desktop.actions.check')

  return (
    <>
      <Separator className="my-4" />
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm">{t('settings.desktop.title')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status
                ? t('settings.desktop.version', { version: status.currentVersion })
                : t('settings.desktop.loading')}
            </p>
            {status && (
              <p className="mt-1 text-xs text-muted-foreground">
                {updateStatusText(t, status)}
              </p>
            )}
            {status?.phase === 'error' && status.error && (
              <p className="mt-1 max-w-md text-xs text-destructive">{status.error}</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!status || updateBusy || phase === 'disabled'}
            onClick={() => void handleUpdateAction()}
            className="shrink-0 gap-1.5"
          >
            <UpdateIcon className={`h-3.5 w-3.5 ${updateBusy ? 'animate-spin' : ''}`} />
            {updateActionLabel}
          </Button>
        </div>
        {phase === 'downloading' && (
          <Progress
            value={status?.progressPercent ?? 0}
            className="h-1.5"
            aria-label={t('settings.desktop.status.downloading', {
              percent: Math.round(status?.progressPercent ?? 0),
            })}
          />
        )}
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm text-muted-foreground">
            {t('settings.desktop.diagnostics.title')}
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={diagnosticsPending}
            onClick={() => void handleDiagnosticsExport()}
            className="shrink-0 gap-1.5"
          >
            {diagnosticsPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileArchive className="h-3.5 w-3.5" />
            )}
            {diagnosticsPending
              ? t('settings.desktop.diagnostics.exporting')
              : t('settings.desktop.diagnostics.export')}
          </Button>
        </div>
      </div>
    </>
  )
}
