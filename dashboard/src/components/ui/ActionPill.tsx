import { cn } from '@/lib/utils'

// Enforcement action → severity-token color. blocked=crit, quarantined=high,
// alerted=med, logged/allowed=low.
const ACTION_META: Record<string, { color: string; label: string }> = {
  blocked: { color: 'var(--cs-crit)', label: 'Blocked' },
  block: { color: 'var(--cs-crit)', label: 'Blocked' },
  quarantined: { color: 'var(--cs-high)', label: 'Quarantined' },
  quarantine: { color: 'var(--cs-high)', label: 'Quarantined' },
  alerted: { color: 'var(--cs-med)', label: 'Alerted' },
  alert: { color: 'var(--cs-med)', label: 'Alerted' },
  logged: { color: 'var(--cs-low)', label: 'Logged' },
  log: { color: 'var(--cs-low)', label: 'Logged' },
  allowed: { color: 'var(--cs-low)', label: 'Allowed' },
  allow: { color: 'var(--cs-low)', label: 'Allowed' },
}

/** A small pill describing the enforcement action taken on an event. */
export function ActionPill({ action, className }: { action?: string; className?: string }) {
  const key = (action || 'logged').toLowerCase()
  const meta =
    ACTION_META[key] ?? { color: 'var(--cs-low)', label: action ? action.charAt(0).toUpperCase() + action.slice(1) : 'Logged' }
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-cs-pill text-xs font-medium', className)}
      style={{
        background: `color-mix(in srgb, ${meta.color} 12%, var(--cs-panel))`,
        color: meta.color,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
      {meta.label}
    </span>
  )
}

export default ActionPill
