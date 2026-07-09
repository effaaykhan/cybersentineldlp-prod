import { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { DRILL_TOOLTIP } from '@/lib/drilldown'

export type StatsColor = 'indigo' | 'red' | 'orange' | 'green' | 'gray'
type LegacyColor = 'blue' | 'green' | 'red' | 'yellow'
export type StatsCardColor = StatsColor | LegacyColor

interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  trend?: { value: number; isPositive: boolean }
  subtext?: string
  color?: StatsCardColor
  /** Drill-down destination — makes the card a Link with a hover affordance. */
  to?: string
  drillTooltip?: string
}

// Each semantic color resolves to a single design token. Severity/status is
// the only place non-indigo hue is used.
const TOKEN: Record<StatsColor, string> = {
  indigo: 'var(--cs-indigo)',
  red: 'var(--cs-crit)',
  orange: 'var(--cs-high)',
  green: 'var(--cs-ok)',
  gray: 'var(--cs-muted)',
}

const LEGACY_COLOR: Record<LegacyColor, StatsColor> = {
  blue: 'indigo', green: 'green', red: 'red', yellow: 'orange',
}

function normalize(c: StatsCardColor | undefined): StatsColor {
  if (!c) return 'indigo'
  if (c in TOKEN) return c as StatsColor
  return LEGACY_COLOR[c as LegacyColor] ?? 'indigo'
}

export default function StatsCard({
  title, value, icon: Icon, trend, subtext, color, to, drillTooltip,
}: StatsCardProps) {
  const semantic = normalize(color)
  const c = TOKEN[semantic]
  const chipBg = semantic === 'indigo' ? 'var(--cs-indigo-faint)' : `color-mix(in srgb, ${c} 13%, var(--cs-panel))`
  const interactive = !!to

  const body = (
    <>
      {/* Thin semantic rule pinned to the left edge. */}
      <div className="absolute inset-y-3 left-0 w-[3px] rounded-full" style={{ background: c }} />

      {interactive && (
        <span
          aria-hidden
          className="absolute top-3.5 right-4 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-cs-muted-2 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0"
          style={{ color: 'var(--cs-indigo)' }}
        >
          Drill down <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="metric-label">{title}</p>
        <div
          className="h-9 w-9 shrink-0 rounded-cs-sm flex items-center justify-center"
          style={{ background: chipBg, color: c }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
      </div>

      <p className="metric-value mt-3">{value}</p>

      <div className="mt-1.5 flex items-center gap-2 min-h-[1.25rem]">
        {subtext && (
          <p className="text-xs truncate" style={{ color: semantic === 'gray' ? 'var(--cs-muted)' : c }}>
            {subtext}
          </p>
        )}
        {trend && (
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-cs-sm text-[11px] font-semibold num"
            style={{
              background: `color-mix(in srgb, ${trend.isPositive ? 'var(--cs-ok)' : 'var(--cs-crit)'} 12%, var(--cs-panel))`,
              color: trend.isPositive ? 'var(--cs-ok)' : 'var(--cs-crit)',
            }}
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
        className="card-modern relative overflow-hidden block group cursor-pointer pl-5 focus-visible:outline-none focus-visible:shadow-focus"
      >
        {body}
      </Link>
    )
  }
  return <div className="card-modern relative overflow-hidden pl-5">{body}</div>
}
