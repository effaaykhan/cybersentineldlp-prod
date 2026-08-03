import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PaginationProps {
  /** 1-based current page. */
  page: number
  pageSize: number
  /** Total number of records across all pages (from the API). */
  total: number
  onPageChange: (page: number) => void
  /** Omit to hide the "per page" selector. */
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
  /** Plural noun for the summary line, e.g. "events". */
  itemLabel?: string
  /** Shows a subtle spinner in the summary while the next page loads. */
  isFetching?: boolean
  className?: string
}

// Compact page window: always show first + last, the current page and its
// neighbours, and collapse the rest into an ellipsis. Keeps the control a fixed
// width whether there are 3 pages or 3,000.
function buildPageWindow(current: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const wanted = new Set<number>([1, totalPages, current, current - 1, current + 1])
  // Bias the ends so the row doesn't visually jump when near the start/finish.
  if (current <= 3) [2, 3, 4].forEach(p => wanted.add(p))
  if (current >= totalPages - 2) [totalPages - 1, totalPages - 2, totalPages - 3].forEach(p => wanted.add(p))

  const sorted = [...wanted].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b)
  const out: (number | 'gap')[] = []
  let prev = 0
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('gap')
    out.push(p)
    prev = p
  }
  return out
}

const arrowCls =
  'inline-flex items-center justify-center h-8 w-8 rounded-cs-sm border border-cs-hair ' +
  'text-cs-ink-2 hover:bg-cs-hair-2 hover:text-cs-ink transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-cs-ink-2'

export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
  itemLabel = 'items',
  isFetching = false,
  className,
}: PaginationProps) {
  if (total <= 0) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const from = (current - 1) * pageSize + 1
  const to = Math.min(current * pageSize, total)

  const go = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages)
    if (next !== current) onPageChange(next)
  }

  const win = buildPageWindow(current, totalPages)

  return (
    <div className={cn('flex items-center justify-between gap-4 px-6 py-4 border-t border-cs-hair flex-wrap', className)}>
      {/* Summary + page size */}
      <div className="flex items-center gap-4 text-sm text-cs-ink-2">
        <span>
          Showing <span className="num text-cs-ink">{from.toLocaleString()}</span>
          –<span className="num text-cs-ink">{to.toLocaleString()}</span>{' '}
          of <span className="num text-cs-ink">{total.toLocaleString()}</span> {itemLabel}
          {isFetching && (
            <Loader2 className="inline w-3.5 h-3.5 ml-2 animate-spin text-cs-muted align-[-2px]" />
          )}
        </span>
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5 text-cs-muted">
            Per page
            <select
              value={pageSize}
              onChange={e => onPageSizeChange(Number(e.target.value))}
              className="bg-cs-hair-2 border border-cs-hair rounded-cs-sm px-2 py-1 text-cs-ink text-sm focus:outline-none focus:ring-2 focus:ring-cs-indigo/40"
            >
              {pageSizeOptions.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Pager (hidden when a single page) */}
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button className={arrowCls} onClick={() => go(1)} disabled={current <= 1} title="First page" aria-label="First page">
            <ChevronsLeft className="w-4 h-4" />
          </button>
          <button className={arrowCls} onClick={() => go(current - 1)} disabled={current <= 1} title="Previous page" aria-label="Previous page">
            <ChevronLeft className="w-4 h-4" />
          </button>

          {win.map((p, i) =>
            p === 'gap' ? (
              <span key={`gap-${i}`} className="px-1.5 text-cs-muted select-none">…</span>
            ) : (
              <button
                key={p}
                onClick={() => go(p)}
                aria-current={p === current ? 'page' : undefined}
                className={cn(
                  'min-w-[2rem] h-8 px-2 rounded-cs-sm text-sm font-medium border transition-colors num',
                  p === current
                    ? 'bg-cs-indigo border-cs-indigo text-white'
                    : 'border-cs-hair text-cs-ink-2 hover:bg-cs-hair-2 hover:text-cs-ink',
                )}
              >
                {p}
              </button>
            ),
          )}

          <button className={arrowCls} onClick={() => go(current + 1)} disabled={current >= totalPages} title="Next page" aria-label="Next page">
            <ChevronRight className="w-4 h-4" />
          </button>
          <button className={arrowCls} onClick={() => go(totalPages)} disabled={current >= totalPages} title="Last page" aria-label="Last page">
            <ChevronsRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
