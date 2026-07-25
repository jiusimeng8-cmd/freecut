import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, Sparkles, Type } from 'lucide-react'
import { cn } from '@/shared/ui/cn'
import type { SceneMatchSignals } from '../utils/rank'

interface SceneMatchBadgesProps {
  signals: SceneMatchSignals
  score: number
  rank?: 'top' | 'default'
  className?: string
}

export const SceneMatchBadges = memo(function SceneMatchBadges({
  signals,
  score,
  rank = 'default',
  className,
}: SceneMatchBadgesProps) {
  const { t } = useTranslation()
  const chips: React.ReactNode[] = []
  const isTopRank = rank === 'top'

  if (signals.ranker === 'keyword' && signals.keywordMatched) {
    chips.push(
      <Chip
        key="keyword"
        tone="keyword"
        icon={<Type className="h-2.5 w-2.5" />}
        label={t('sceneBrowser.match.keyword')}
        hint={t('sceneBrowser.match.keywordHint', { score: score.toFixed(2) })}
      />,
    )
  }

  if (signals.ranker === 'palette' && signals.colorMatch) {
    chips.push(
      <Chip
        key="palette-color"
        tone="palette"
        icon={<Palette className="h-2.5 w-2.5" />}
        label={t('sceneBrowser.match.colorWithName', { color: signals.colorMatch })}
        hint={t('sceneBrowser.match.paletteColorHint', { color: signals.colorMatch })}
      />,
    )
  }

  if (signals.ranker === 'palette' && typeof signals.paletteDistance === 'number') {
    chips.push(
      <Chip
        key="palette-similar"
        tone="palette"
        icon={<Palette className="h-2.5 w-2.5" />}
        label={t('sceneBrowser.match.paletteDistance', {
          distance: signals.paletteDistance.toFixed(1),
        })}
        hint={t('sceneBrowser.match.paletteDistanceHint')}
      />,
    )
  }

  if (chips.length === 0 && !isTopRank) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {isTopRank && (
        <Chip
          tone="top"
          icon={<Sparkles className="h-2.5 w-2.5" />}
          label={t('sceneBrowser.match.top')}
          hint={t('sceneBrowser.match.topHint')}
        />
      )}
      {chips}
    </div>
  )
})

interface ChipProps {
  tone: 'keyword' | 'top' | 'palette'
  icon: React.ReactNode
  label: string
  hint?: string
}

function Chip({ tone, icon, label, hint }: ChipProps) {
  const cls = (() => {
    switch (tone) {
      case 'keyword':
        return 'bg-amber-400/15 text-amber-300 border-amber-400/30'
      case 'palette':
        return 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30'
      case 'top':
        return 'bg-primary/15 text-primary border-primary/40'
    }
  })()

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[9.5px] font-medium leading-none',
        cls,
      )}
      title={hint}
    >
      {icon}
      {label}
    </span>
  )
}

export const SceneMatchStrength = memo(function SceneMatchStrength({
  signals,
  score,
}: {
  signals: SceneMatchSignals
  score: number
}) {
  if (signals.ranker !== 'keyword') return null

  return (
    <div className="h-0.5 w-full overflow-hidden rounded-full bg-amber-400/10">
      <div
        className="h-full bg-amber-400/70"
        style={{ width: `${Math.max(20, Math.min(100, score * 100))}%` }}
      />
    </div>
  )
})
