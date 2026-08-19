import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getEvent } from '@/lib/api'
import LoadingSpinner from '../LoadingSpinner'
import { cn, formatAgentLabel } from '@/lib/utils'
import Modal, { ModalFooter } from '@/components/ui/Modal'

interface AlertDetailsModalProps {
  alert: any
  isOpen: boolean
  onClose: () => void
}

export default function AlertDetailsModal({ alert, isOpen, onClose }: AlertDetailsModalProps) {
  const [eventData, setEventData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen && alert) {
      fetchEventData()
    }
  }, [isOpen, alert])

  const fetchEventData = async () => {
    if (!alert?.event_id) {
      // If no event_id, use the alert data itself
      setEventData(alert)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const data = await getEvent(alert.event_id)
      setEventData(data)
    } catch (err: any) {
      console.error('Failed to fetch event data:', err)
      // Fallback to showing the alert data itself
      setEventData(alert)
    } finally {
      setLoading(false)
    }
  }

  // `alert` is null until a row is clicked, and everything below reads it
  // directly. This guard is NOT redundant with <Modal open={isOpen}>: the
  // header and footer are passed as JSX *props*, so React evaluates them —
  // including `alert.id` — before Modal ever gets to look at `open`. Without
  // this, the page threw "Cannot read properties of null (reading 'id')" on
  // first paint and rendered nothing at all.
  //
  // It replaces the `if (!isOpen) return null` that guarded this component
  // before the dialogs moved onto the shared overlay; moving `open` onto
  // Modal dropped the guard that was also, incidentally, protecting the
  // null `alert`. Keyed off `alert` rather than `isOpen` so it stays correct
  // regardless of how the open state is driven.
  //
  // Placed after the hooks above so hook order stays stable across renders.
  if (!alert) return null

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="2xl"
      header={
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
              Alert
            </div>
            <h3 className="mt-0.5 truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">
              Alert details
            </h3>
            <p className="mt-1 text-[12px] text-cs-muted">
              <code className="rounded bg-cs-panel-2 px-1.5 py-0.5 font-mono">{alert.id}</code>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      }
      footer={
        <ModalFooter>
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </ModalFooter>
      }
      bodyClassName="px-6 py-5"
    >
            {/* Alert Summary */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-cs-ink-2 mb-3">Alert Summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-cs-ink-2">Severity:</span>
                  <span
                    className={cn(
                      'badge',
                      alert.severity === 'critical'
                        ? 'badge-danger'
                        : alert.severity === 'high'
                        ? 'badge-warning'
                        : alert.severity === 'medium'
                        ? 'badge-info'
                        : 'badge-success'
                    )}
                  >
                    {alert.severity}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-cs-ink-2">Title:</span>
                  <span className="ml-2">{alert.title}</span>
                </div>
                <div>
                  <span className="font-medium text-cs-ink-2">Description:</span>
                  <span className="ml-2">{alert.description}</span>
                </div>
                <div>
                  <span className="font-medium text-cs-ink-2">Created:</span>
                  <span className="ml-2">{new Date(alert.created_at).toLocaleString()}</span>
                </div>
                <div>
                  <span className="font-medium text-cs-ink-2">Agent:</span>
                  <span
                    className="ml-2"
                    title={eventData?.agent_id || alert.agent_id}
                  >
                    {formatAgentLabel(
                      eventData?.agent_name,
                      eventData?.agent_code,
                    )}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-cs-ink-2">Event ID:</span>
                  <span className="ml-2 font-mono text-xs">{alert.event_id}</span>
                </div>
              </div>
            </div>

            {/* Classification Details */}
            {(alert.classification_category || alert.classification_level || alert.classification_rules_matched?.length > 0) && (
              <div className="mb-6 bg-cs-indigo-faint border border-cs-indigo/25 rounded-cs-sm p-4">
                <h3 className="text-sm font-semibold text-cs-indigo mb-3">Classification Details</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="font-medium text-cs-ink-2">Category:</span>
                    <span className={cn(
                      'ml-2 px-2 py-0.5 rounded text-xs font-bold uppercase',
                      (alert.classification_category || alert.classification_level) === 'Restricted' ? 'bg-cs-crit/10 text-cs-crit' :
                      (alert.classification_category || alert.classification_level) === 'Confidential' ? 'bg-cs-high/10 text-cs-high' :
                      (alert.classification_category || alert.classification_level) === 'Internal' ? 'bg-cs-med/12 text-cs-med' :
                      'bg-cs-ok/12 text-cs-ok'
                    )}>
                      {alert.classification_category || alert.classification_level || 'Public'}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium text-cs-ink-2">Confidence:</span>
                    <span className="ml-2 font-bold">{((alert.classification_score || 0) * 100).toFixed(0)}%</span>
                  </div>
                  <div>
                    <span className="font-medium text-cs-ink-2">Action:</span>
                    <span className={cn(
                      'ml-2 px-2 py-0.5 rounded text-xs font-medium uppercase',
                      alert.action_taken === 'block' ? 'bg-cs-crit/10 text-cs-crit' :
                      alert.action_taken === 'alert' ? 'bg-cs-med/12 text-cs-med' :
                      'bg-cs-ok/12 text-cs-ok'
                    )}>
                      {alert.action_taken || 'allowed'}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium text-cs-ink-2">Blocked:</span>
                    <span className={cn(
                      'ml-2 px-2 py-0.5 rounded text-xs font-medium',
                      alert.blocked ? 'bg-cs-crit/10 text-cs-crit' : 'bg-cs-ok/12 text-cs-ok'
                    )}>
                      {alert.blocked ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
                {alert.classification_rules_matched && alert.classification_rules_matched.length > 0 && (
                  <div className="mt-3">
                    <span className="font-medium text-cs-ink-2 text-sm">Matched Rules:</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {alert.classification_rules_matched.map((rule: string, idx: number) => (
                        <span key={idx} className="px-2 py-0.5 rounded-full text-xs font-medium bg-cs-indigo-faint text-cs-indigo">
                          {rule}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {alert.detected_content && (
                  <div className="mt-3">
                    <span className="font-medium text-cs-ink-2 text-sm">Detected Content:</span>
                    <pre className="mt-1 text-xs text-cs-ink-2 bg-white rounded p-2 border border-cs-hair whitespace-pre-wrap">{alert.detected_content}</pre>
                  </div>
                )}
              </div>
            )}

            {/* Raw Event Log */}
            <div>
              <h3 className="text-sm font-semibold text-cs-ink-2 mb-3">Raw Event Log</h3>

              {loading && (
                <div className="flex justify-center py-8">
                  <LoadingSpinner size="md" />
                </div>
              )}

              {error && (
                <div className="bg-cs-crit/[0.07] border border-cs-crit/25 rounded-cs-sm p-4">
                  <p className="text-sm text-cs-crit">{error}</p>
                </div>
              )}

              {!loading && !error && eventData && (
                <div className="bg-cs-panel-2 rounded-cs-sm p-4 overflow-x-auto">
                  <pre className="text-xs text-cs-ink font-mono whitespace-pre-wrap break-words">
                    {JSON.stringify(eventData, null, 2)}
                  </pre>
                </div>
              )}

              {!loading && !error && !eventData && (
                <div className="bg-cs-med/[0.09] border border-cs-med/30 rounded-cs-sm p-4">
                  <p className="text-sm text-cs-med">No event data available</p>
                </div>
              )}
            </div>
    </Modal>
  )
}
