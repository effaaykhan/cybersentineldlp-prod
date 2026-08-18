import { useState } from 'react'
import { X, ChevronDown, ChevronUp } from 'lucide-react'
import { Policy } from '@/types/policy'
import { getPolicyTypeIcon, getPolicyTypeLabel, getSeverityColorLight } from '@/utils/policyUtils'
import Modal, { ModalFooter } from '@/components/ui/Modal'

interface PolicyDetailsModalProps {
  isOpen: boolean
  policy: Policy | null
  onClose: () => void
}

export default function PolicyDetailsModal({ isOpen, policy, onClose }: PolicyDetailsModalProps) {
  const [showJson, setShowJson] = useState(false)

  if (!isOpen || !policy) return null

  const Icon = getPolicyTypeIcon(policy.type)
  const severityColor = getSeverityColorLight(policy.severity)

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      header={
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-cs-sm ${severityColor.bg}`}>
            <Icon className={`h-5 w-5 ${severityColor.icon}`} />
          </div>
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
              {getPolicyTypeLabel(policy.type)}
            </div>
            <h3 className="mt-0.5 truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">
              {policy.name}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
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
      <div className="space-y-6">
          {/* Basic Information */}
          <div>
            <h4 className="text-lg font-semibold text-cs-ink mb-4">Basic Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-cs-muted-2">Status</label>
                <p className="mt-1">
                  {policy.enabled ? (
                    <span className="badge badge-success">Active</span>
                  ) : (
                    <span className="badge bg-cs-hair-2 text-cs-muted-2">Inactive</span>
                  )}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-cs-muted-2">Severity</label>
                <p className="mt-1">
                  <span className={`badge ${severityColor.badge}`}>{policy.severity}</span>
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-cs-muted-2">Priority</label>
                <p className="mt-1 text-cs-ink font-medium">{policy.priority}</p>
              </div>
              {policy.violations !== undefined && (
                <div>
                  <label className="text-sm font-medium text-cs-muted-2">Violations</label>
                  <p className="mt-1 text-cs-ink font-medium">{policy.violations}</p>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          {policy.description && (
            <div>
              <label className="text-sm font-medium text-cs-muted-2">Description</label>
              <p className="mt-1 text-cs-ink">{policy.description}</p>
            </div>
          )}

          {/* Scope */}
          <div>
            <label className="text-sm font-medium text-cs-muted-2">Scope</label>
            <p className="mt-1 text-cs-ink">
              {policy.agentIds && policy.agentIds.length > 0
                ? `Selected agents (${policy.agentIds.length}): ${policy.agentIds.join(', ')}`
                : 'All agents'}
            </p>
          </div>

          {/* Configuration */}
          <div>
            <h4 className="text-lg font-semibold text-cs-ink mb-4">Configuration</h4>
            <div className="bg-cs-panel-2 rounded-cs-sm p-4 border border-cs-hair">
              <pre className="text-sm text-cs-ink-2 whitespace-pre-wrap">
                {JSON.stringify(policy.config, null, 2)}
              </pre>
            </div>
          </div>

          {/* Metadata */}
          <div>
            <h4 className="text-lg font-semibold text-cs-ink mb-4">Metadata</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-cs-muted-2">Created</label>
                <p className="mt-1 text-cs-ink">{formatDate(policy.createdAt)}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-cs-muted-2">Last Updated</label>
                <p className="mt-1 text-cs-ink">{formatDate(policy.updatedAt)}</p>
              </div>
              {policy.createdBy && (
                <div>
                  <label className="text-sm font-medium text-cs-muted-2">Created By</label>
                  <p className="mt-1 text-cs-ink">{policy.createdBy}</p>
                </div>
              )}
              {policy.lastViolation && (
                <div>
                  <label className="text-sm font-medium text-cs-muted-2">Last Violation</label>
                  <p className="mt-1 text-cs-ink">{formatDate(policy.lastViolation)}</p>
                </div>
              )}
            </div>
          </div>

          {/* Raw JSON Data (Expandable) */}
          <div className="border-t border-cs-hair pt-4">
            <button
              onClick={() => setShowJson(!showJson)}
              className="flex items-center gap-2 text-cs-muted-2 hover:text-cs-ink transition-colors w-full"
            >
              {showJson ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              <span className="text-sm font-medium">View Raw JSON Data</span>
            </button>
            {showJson && (
              <div className="mt-4 bg-cs-panel-2 rounded-cs-sm p-4 border border-cs-hair">
                <pre className="text-xs text-cs-ink-2 overflow-x-auto">
                  {JSON.stringify(policy, null, 2)}
                </pre>
              </div>
            )}
          </div>
      </div>
    </Modal>
  )
}
