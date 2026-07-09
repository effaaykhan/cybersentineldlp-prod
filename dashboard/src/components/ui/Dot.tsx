import { cn } from '@/lib/utils'

// Severity / status → token color. Severity is the ONLY place semantic
// hue is used in the theme.
const LEVEL_COLOR: Record<string, string> = {
  critical: 'var(--cs-crit)',
  crit: 'var(--cs-crit)',
  high: 'var(--cs-high)',
  medium: 'var(--cs-med)',
  med: 'var(--cs-med)',
  moderate: 'var(--cs-med)',
  low: 'var(--cs-low)',
  info: 'var(--cs-low)',
  ok: 'var(--cs-ok)',
  active: 'var(--cs-ok)',
  online: 'var(--cs-ok)',
  connected: 'var(--cs-ok)',
}

export function dotColor(level?: string): string {
  return LEVEL_COLOR[(level || '').toLowerCase()] ?? 'var(--cs-muted)'
}

/** A small severity/status dot. */
export function Dot({
  level,
  pulse = false,
  className,
}: {
  level?: string
  pulse?: boolean
  className?: string
}) {
  const color = dotColor(level)
  if (pulse) {
    return (
      <span className={cn('cs-live-dot', className)} style={{ background: color, ['--cs-ok' as any]: color }} />
    )
  }
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full shrink-0', className)}
      style={{ background: color }}
    />
  )
}

export default Dot
