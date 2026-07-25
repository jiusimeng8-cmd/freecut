import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Filter, LayoutGrid, List, Search } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/shared/ui/cn'
import { useMediaLibraryStore } from '../deps/media-library'
import {
  useSceneBrowserStore,
  type SceneBrowserSortMode,
  type SceneBrowserViewMode,
} from '../stores/scene-browser-store'
import { useRankedScenes } from '../hooks/use-ranked-scenes'
import { SceneSearchField, SceneSearchModeButtons } from './scene-search-input'
import { GlobalSceneRow, ScopedSceneRow } from './scene-row'
import { GlobalSceneCard, ScopedSceneCard } from './scene-card'
import '../utils/invalidate'

interface SceneBrowserPanelProps {
  className?: string
}

const SORT_OPTIONS: Array<{ value: SceneBrowserSortMode; labelKey: string }> = [
  { value: 'relevance', labelKey: 'sceneBrowser.sort.relevance' },
  { value: 'time', labelKey: 'sceneBrowser.sort.time' },
  { value: 'name', labelKey: 'sceneBrowser.sort.name' },
]

// fallow-ignore-next-line complexity
export function SceneBrowserPanel({ className }: SceneBrowserPanelProps) {
  const { t } = useTranslation()
  const query = useSceneBrowserStore((s) => s.query)
  const scope = useSceneBrowserStore((s) => s.scope)
  const setScope = useSceneBrowserStore((s) => s.setScope)
  const sortMode = useSceneBrowserStore((s) => s.sortMode)
  const setSortMode = useSceneBrowserStore((s) => s.setSortMode)
  const viewMode = useSceneBrowserStore((s) => s.viewMode)
  const setViewMode = useSceneBrowserStore((s) => s.setViewMode)

  const mediaItems = useMediaLibraryStore((s) => s.mediaItems)
  const mediaWithCaptions = useMemo(
    () => mediaItems.filter((m) => (m.aiCaptions?.length ?? 0) > 0),
    [mediaItems],
  )

  const headerRef = useRef<HTMLDivElement | null>(null)
  const [headerWidth, setHeaderWidth] = useState<number>(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const update = () => {
      setHeaderWidth(el.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The scope `<Select>` shows arbitrary-length filenames, so collapse it
  // earlier when a specific media is selected.
  const compact = headerWidth < 360
  const compactScope = headerWidth < 440 || (scope !== null && headerWidth < 560)

  const { scenes, totalScenes, clipsWithCaptions, isQuerying } = useRankedScenes()

  const scopedMedia = useMemo(
    () => (scope ? (mediaWithCaptions.find((m) => m.id === scope) ?? null) : null),
    [scope, mediaWithCaptions],
  )

  const handleScopeChange = useCallback(
    (value: string) => {
      setScope(value === 'all' ? null : value)
    },
    [setScope],
  )

  const hasAnyCaptions = totalScenes > 0
  const hasResults = scenes.length > 0
  const isFiltered = query.trim().length > 0
  const SceneGridCard = scope === null ? GlobalSceneCard : ScopedSceneCard
  const SceneListRow = scope === null ? GlobalSceneRow : ScopedSceneRow

  const scopeLabel = `${t('sceneBrowser.counts.clip', {
    count: clipsWithCaptions,
  })} · ${t('sceneBrowser.counts.scene', { count: totalScenes })}`

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={headerRef} className="flex flex-col gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <SceneSearchModeButtons compact={compact} />
          <div className="flex-1" />
          {compactScope ? (
            <CompactScopePicker
              scope={scope}
              scopedMedia={scopedMedia}
              mediaWithCaptions={mediaWithCaptions}
              onChange={handleScopeChange}
            />
          ) : (
            <Select value={scope ?? 'all'} onValueChange={handleScopeChange}>
              <SelectTrigger className="h-6 w-36 text-[11px]">
                <SelectValue placeholder={t('sceneBrowser.scope.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('sceneBrowser.scope.allMedia')}</SelectItem>
                {mediaWithCaptions.map((media) => (
                  <SelectItem key={media.id} value={media.id}>
                    {media.fileName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center">
          <SceneSearchField />
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Search className="h-3 w-3" />
          {isFiltered
            ? `${t('sceneBrowser.counts.match', { count: scenes.length })} · ${scopeLabel}`
            : scopeLabel}
        </span>
        <div className="flex items-center gap-1.5">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          <span className="text-muted-foreground/80">{t('sceneBrowser.sort.label')}</span>
          <Select value={sortMode} onValueChange={(v) => setSortMode(v as SceneBrowserSortMode)}>
            <SelectTrigger className="h-6 w-28 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* The `[&>...]` override forces Radix's inner viewport wrapper to
          block layout. Radix defaults it to `display: table; min-width: 100%`
          which lets the wrapper grow past the viewport width if any row has
          a long intrinsic min-width — that overflow slides row content
          underneath the vertical scrollbar. Block layout keeps the wrapper
          clamped to viewport width so the scrollbar sits in its own column. */}
      <ScrollArea className="flex-1 min-h-0 mr-2 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className={cn('pl-2 pr-3 py-2', viewMode === 'list' && 'space-y-0.5')}>
          {hasResults ? (
            viewMode === 'grid' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                {scenes.map((scene, index) => (
                  <SceneGridCard
                    key={scene.id}
                    scene={scene}
                    match={isQuerying ? { rank: index === 0 ? 'top' : 'default' } : undefined}
                  />
                ))}
              </div>
            ) : (
              scenes.map((scene, index) => (
                <SceneListRow
                  key={scene.id}
                  scene={scene}
                  match={isQuerying ? { rank: index === 0 ? 'top' : 'default' } : undefined}
                />
              ))
            )
          ) : (
            <EmptyState hasAnyCaptions={hasAnyCaptions} isFiltered={isFiltered} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * Compact replacement for the scope `<Select>` used when the browser header
 * is too narrow to fit the full pill. Renders a small filter-icon button
 * (with a dot when a specific clip is scoped) that opens a dropdown listing
 * "All media" + every captioned clip.
 */
function CompactScopePicker({
  scope,
  scopedMedia,
  mediaWithCaptions,
  onChange,
}: {
  scope: string | null
  scopedMedia: { id: string; fileName: string } | null
  mediaWithCaptions: ReadonlyArray<{ id: string; fileName: string }>
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const title = scopedMedia
    ? t('sceneBrowser.scope.scopedTo', { name: scopedMedia.fileName })
    : t('sceneBrowser.scope.scopedToAll')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors',
            scope
              ? 'border-primary/60 bg-primary/10 text-primary'
              : 'border-border bg-secondary text-muted-foreground hover:text-foreground',
          )}
          title={title}
          aria-label={title}
        >
          <Filter className="h-3 w-3" />
          <ChevronDown className="h-3 w-3 opacity-70" />
          {scope && (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => onChange('all')}>
          {t('sceneBrowser.scope.allMedia')}
          {scope === null && <Check className="ml-auto h-3 w-3" />}
        </DropdownMenuItem>
        {mediaWithCaptions.length > 0 && <DropdownMenuSeparator />}
        {mediaWithCaptions.map((media) => (
          <DropdownMenuItem key={media.id} onClick={() => onChange(media.id)}>
            <span className="truncate">{media.fileName}</span>
            {scope === media.id && <Check className="ml-auto h-3 w-3 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ViewModeToggle({
  value,
  onChange,
}: {
  value: SceneBrowserViewMode
  onChange: (mode: SceneBrowserViewMode) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center rounded-md border border-border bg-secondary p-0.5">
      <button
        type="button"
        onClick={() => onChange('list')}
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-[3px] transition-colors',
          value === 'list'
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:text-foreground',
        )}
        title={t('sceneBrowser.view.list')}
        aria-label={t('sceneBrowser.view.list')}
        aria-pressed={value === 'list'}
      >
        <List className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-[3px] transition-colors',
          value === 'grid'
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:text-foreground',
        )}
        title={t('sceneBrowser.view.grid')}
        aria-label={t('sceneBrowser.view.grid')}
        aria-pressed={value === 'grid'}
      >
        <LayoutGrid className="h-3 w-3" />
      </button>
    </div>
  )
}

function EmptyState({
  hasAnyCaptions,
  isFiltered,
}: {
  hasAnyCaptions: boolean
  isFiltered: boolean
}) {
  const { t } = useTranslation()
  if (!hasAnyCaptions) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-muted-foreground">
        <Search className="h-6 w-6" />
        <p className="text-[12px]">{t('sceneBrowser.empty.noCaptionsTitle')}</p>
      </div>
    )
  }
  if (isFiltered) {
    return (
      <div className="flex flex-col items-center gap-1 px-6 py-10 text-center text-muted-foreground">
        <p className="text-[12px]">{t('sceneBrowser.empty.noMatchesTitle')}</p>
        <p className="text-[11px] text-muted-foreground/80">
          {t('sceneBrowser.empty.noMatchesPrefix')}{' '}
          <span className="font-medium">{t('sceneBrowser.scope.allMedia')}</span>.
        </p>
      </div>
    )
  }
  return null
}
