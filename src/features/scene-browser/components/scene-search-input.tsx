import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/shared/ui/cn'
import { useSceneBrowserStore } from '../stores/scene-browser-store'
import { LibraryPaletteGrid } from './library-palette-grid'

export function SceneSearchModeButtons({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const colorMode = useSceneBrowserStore((s) => s.colorMode)
  const setColorMode = useSceneBrowserStore((s) => s.setColorMode)

  return (
    <button
      type="button"
      onClick={() => setColorMode(!colorMode)}
      className={cn(
        'flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors',
        colorMode
          ? 'border-primary/60 bg-primary/10 text-primary'
          : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
      )}
      title={
        colorMode ? t('sceneBrowser.search.exitColorMode') : t('sceneBrowser.search.colorTitle')
      }
      aria-label={
        colorMode ? t('sceneBrowser.search.exitColorMode') : t('sceneBrowser.search.colorTitle')
      }
      aria-pressed={colorMode}
    >
      <Palette className="h-3 w-3" />
      {!compact && t('sceneBrowser.search.color')}
    </button>
  )
}

export function SceneSearchField() {
  const { t } = useTranslation()
  const query = useSceneBrowserStore((s) => s.query)
  const setQuery = useSceneBrowserStore((s) => s.setQuery)
  const focusNonce = useSceneBrowserStore((s) => s.focusNonce)
  const reference = useSceneBrowserStore((s) => s.reference)
  const setReference = useSceneBrowserStore((s) => s.setReference)
  const colorMode = useSceneBrowserStore((s) => s.colorMode)
  const scope = useSceneBrowserStore((s) => s.scope)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusNonce > 0) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focusNonce])

  if (colorMode) {
    return (
      <div className="flex min-w-0 flex-1 items-start gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5">
        {reference ? (
          <button
            type="button"
            onClick={() => setReference(null)}
            className="flex h-6 max-w-[220px] items-center gap-1 rounded-md border border-primary/60 bg-primary/10 px-2 text-[11px] text-primary transition-colors hover:bg-primary/20"
            title={t('sceneBrowser.search.clearReference')}
          >
            <Palette className="h-3 w-3 shrink-0" />
            <span className="truncate">{reference.label}</span>
            <X className="h-3 w-3 shrink-0" />
          </button>
        ) : (
          <LibraryPaletteGrid scope={scope} />
        )}
      </div>
    )
  }

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sceneBrowser.search.keywordPlaceholder')}
          disabled={!!reference}
          className="h-8 pl-8 pr-7 text-[12px] disabled:opacity-60"
          spellCheck={false}
          autoComplete="off"
        />
        {query.length > 0 && !reference && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={t('sceneBrowser.search.clearSearch')}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {reference && (
        <button
          type="button"
          onClick={() => setReference(null)}
          className="flex h-8 max-w-[220px] items-center gap-1 rounded-md border border-primary/60 bg-primary/10 px-2 text-[11px] text-primary transition-colors hover:bg-primary/20"
          title={t('sceneBrowser.search.similarPaletteTo', { label: reference.label })}
        >
          <Palette className="h-3 w-3 shrink-0" />
          <span className="truncate">{reference.label}</span>
          <X className="h-3 w-3 shrink-0" />
        </button>
      )}
    </div>
  )
}
