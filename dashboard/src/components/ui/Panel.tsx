import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Panel — the standard hairline surface. Optional header with an
 * indigo-faint icon chip, title, subtitle, and a right-aligned action slot.
 */
export function Panel({
  title,
  subtitle,
  icon: Icon,
  right,
  interactive = false,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  icon?: React.ComponentType<{ className?: string }>
  right?: ReactNode
  interactive?: boolean
  className?: string
  bodyClassName?: string
  children?: ReactNode
}) {
  const hasHeader = title || subtitle || right || Icon
  return (
    <section className={cn(interactive ? 'card-modern' : 'card-static', className)}>
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <span className="h-8 w-8 rounded-cs-sm flex items-center justify-center bg-cs-indigo-faint text-cs-indigo shrink-0">
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h3 className="section-title truncate">{title}</h3>}
              {subtitle && <p className="mt-0.5 text-xs text-cs-muted">{subtitle}</p>}
            </div>
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

export default Panel
