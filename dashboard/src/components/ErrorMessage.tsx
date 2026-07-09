import { AlertCircle } from 'lucide-react'

interface ErrorMessageProps {
  message: string
  retry?: () => void
}

export default function ErrorMessage({ message, retry }: ErrorMessageProps) {
  return (
    <div
      className="card"
      style={{
        borderColor: 'color-mix(in srgb, var(--cs-crit) 30%, var(--cs-panel))',
        background: 'color-mix(in srgb, var(--cs-crit) 7%, var(--cs-panel))',
      }}
    >
      <div className="flex items-center gap-3">
        <AlertCircle className="h-5 w-5 flex-shrink-0" style={{ color: 'var(--cs-crit)' }} />
        <div className="flex-1">
          <p className="text-sm font-semibold" style={{ color: 'var(--cs-crit)' }}>Error</p>
          <p className="mt-1 text-sm text-cs-ink-2">{message}</p>
        </div>
        {retry && (
          <button
            onClick={retry}
            className="px-4 py-2 text-sm font-medium rounded-cs-sm transition-colors hover:bg-cs-hair-2"
            style={{ color: 'var(--cs-crit)' }}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
