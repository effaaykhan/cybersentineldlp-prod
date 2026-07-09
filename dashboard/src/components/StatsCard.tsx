import { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DRILL_TOOLTIP } from '@/lib/drilldown'

export type StatsColor = 'indigo' | 'red' | 'orange' | 'green' | 'gray'
type LegacyColor = 'blue' | 'green' | 'red' | 'yellow'
export type StatsCardColor = StatsColor | LegacyColor

interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  /** Trend chip rendered under the metric. Negative numbers come in
   *  red, positive in green; the +/- sign is added automatically. */
  trend?: { value: number; isPositive: boolean }
  /** Optional sub-label rendered below the metric (e.g. "of 5 total"). */
  subtext?: string
  /** Semantic colour. Accepts both the new palette
   *  ('indigo'|'red'|'orange'|'green'|'gray') and the legacy palette
   *  ('blue'|'green'|'red'|'yellow') for back-compat with older pages. */
  color?: StatsCardColor
  /** Drill-down destination. When set, the card becomes a Link with
   *  cursor-pointer + tooltip + a small arrow affordance in the corner. */
  to?: string
  /** Tooltip override for the drill-down. */
  drillTooltip?: string
}

// One quiet tint per semantic colour: a soft chip behind the icon, a
// coloured icon, and a hairline rule. The metric itself stays solid ink
// (mono) so the number is the loudest thing, not the decoration.
const PALETTES: Record<StatsColor, { chip: string; icon: string; rule: string }> = {
  indigo: { chip: 'bg-primary-50', icon: 'text-primary-600', rule: 'bg-primary-500' },
  red:    { chip: 'bg-danger-50',  icon: 'text-danger-600',  rule: 'bg-danger-500' },
  orange: { chip: 'bg-warning-50', icon: 'text-warning-600', rule: 'bg-warning-500' },
  green:  { chip: 'bg-success-50', icon: 'text-success-600', rule: 'bg-success-500' },
  gray:   { chip: 'bg-slate-100',  icon: 'text-slate-500',   rule: 'bg-slate-400' },
}

const LEGACY_COLOR: Record<LegacyColor, StatsColor> = {
  blue: 'indigo', green: 'green', red: 'red', yellow: 'orange',
}

function normalize(c: StatsCardColor | undefined): StatsColor {
  if (!c) return 'indigo'
  if (c in PALETTES) return c as StatsColor
  return LEGACY_COLOR[c as LegacyColor] ?? 'indigo'
}

export default function StatsCard({
  title, value, icon: Icon, trend, subtext, color, to, drillTooltip,
}: StatsCardProps) {
  const p = PALETTES[normalize(color)]
  const interactive = !!to

  const body = (
    <>
      {/* Thin semantic rule pinned to the left edge. */}
      <div className={cn('absolute inset-y-3 left-0 w-[3px] rounded-full', p.rule)} />

      {interactive && (
        <span
          aria-hidden
          className="absolute top-4 right-4 text-slate-300 transition-colors group-hover:text-primary-600"
        >
          <ArrowUpRight className="h-4 w-4" />
        </span>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="metric-label">{title}</p>
        <div className={cn('h-9 w-9 shrink-0 rounded-lg flex items-center justify-center', p.chip)}>
          <Icon className={cn('h-[18px] w-[18px]', p.icon)} />
        </div>
      </div>

      <p className="metric-value mt-3">{value}</p>

      <div className="mt-1.5 flex items-center gap-2 min-h-[1.25rem]">
        {subtext && <p className="text-xs text-slate-500 truncate">{subtext}</p>}
        {trend && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-semibold num',
              trend.isPositive ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700',
            )}
          >
            <span aria-hidden>{trend.isPositive ? '↑' : '↓'}</span>
            {Math.abs(trend.value)}%
          </span>
        )}
      </div>
    </>
  )

  if (interactive) {
    return (
      <Link
        to={to!}
        title={drillTooltip ?? DRILL_TOOLTIP}
        aria-label={`${title}: ${drillTooltip ?? DRILL_TOOLTIP}`}
        className={cn(
          'card-modern relative overflow-hidden block group cursor-pointer pl-5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:ring-offset-2',
        )}
      >
        {body}
      </Link>
    )
  }
  return <div className="card-modern relative overflow-hidden pl-5">{body}</div>
}
