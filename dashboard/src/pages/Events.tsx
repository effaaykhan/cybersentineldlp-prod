import { useState, useMemo, useEffect } from 'react'
import { extractErrorDetail } from '@/utils/errorUtils'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Search, Filter, FileText, Calendar, Shield, AlertTriangle, Ban, X, ArrowRight, File, HardDrive, Usb, ChevronDown, ChevronUp, Trash2, Clipboard, Eye, Bell, Download, RefreshCcw, Loader2, Plus, Edit, Trash, Move, Copy, FilePlus, FileEdit, FileX, FolderOpen, Printer , Globe} from 'lucide-react'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { searchEvents, getAllAgents, clearAllEvents, type Event } from '@/lib/api'
import { formatDate, cn, truncate, formatDateTimeIST, formatAgentLabel } from '@/lib/utils'
import { Dot } from '@/components/ui/Dot'
import { ActionPill } from '@/components/ui/ActionPill'
import Pagination from '@/components/ui/Pagination'
import toast from 'react-hot-toast'
import Dialog, { ConfirmDialog } from '@/components/ui/Modal'

// Event Detail Modal Component
function EventDetailModal({
  event,
  onClose,
  isBlockedTransfer,
  formatFileSize,
  getDriveLetter,
  agentLabel,
}: {
  event: any
  onClose: () => void
  isBlockedTransfer: boolean
  formatFileSize: (bytes: number) => string
  getDriveLetter: (path: string) => string
  agentLabel: string
}) {
  const [showRawData, setShowRawData] = useState(false)

  // Helper function to get action icon
  const getActionIcon = (action: string) => {
    switch (action) {
      case 'blocked': return <Ban className="w-4 h-4" />
      case 'alerted': return <Bell className="w-4 h-4" />
      case 'quarantined': return <Download className="w-4 h-4" />
      default: return <Eye className="w-4 h-4" />
    }
  }

  // Helper functions for OneDrive/Google Drive event subtypes
  const getEventSubtypeIcon = (subtype: string) => {
    const normalized = subtype?.toLowerCase() || ''
    if (normalized.includes('created')) return <FilePlus className="w-4 h-4" />
    if (normalized.includes('modified') || normalized.includes('updated')) return <FileEdit className="w-4 h-4" />
    if (normalized.includes('deleted')) return <FileX className="w-4 h-4" />
    if (normalized.includes('moved') || normalized.includes('renamed')) return <Move className="w-4 h-4" />
    if (normalized.includes('copied')) return <Copy className="w-4 h-4" />
    return <File className="w-4 h-4" />
  }

  const getEventSubtypeColor = (subtype: string) => {
    const normalized = subtype?.toLowerCase() || ''
    if (normalized.includes('created')) return 'text-cs-ok bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))]'
    if (normalized.includes('modified') || normalized.includes('updated')) return 'text-cs-indigo bg-cs-indigo-faint border-[color-mix(in_srgb,var(--cs-indigo)_30%,var(--cs-panel))]'
    if (normalized.includes('deleted')) return 'text-cs-crit bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))]'
    if (normalized.includes('moved') || normalized.includes('renamed')) return 'text-cs-high bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))]'
    if (normalized.includes('copied')) return 'text-cs-indigo bg-cs-indigo-faint border-cs-indigo/25'
    return 'text-cs-ink-2 bg-cs-hair-2 border-cs-hair'
  }

  const getEventSubtypeLabel = (subtype: string, changeType?: string) => {
    if (!subtype) return 'File Activity'
    const normalized = subtype.toLowerCase()
    if (normalized.includes('created')) return 'File Created'
    if (normalized.includes('modified') || normalized.includes('updated')) return 'File Modified'
    if (normalized.includes('deleted')) return 'File Deleted'
    if (normalized.includes('moved')) return 'File Moved'
    if (normalized.includes('renamed')) return 'File Renamed'
    if (normalized.includes('copied')) return 'File Copied'
    if (changeType) {
      return changeType.charAt(0).toUpperCase() + changeType.slice(1)
    }
    return 'File Activity'
  }

  if (isBlockedTransfer) {
    // User-friendly display for blocked transfers
    const blocked = event.blocked !== false // Default to true if not specified
    const sourcePath = event.file_path || ''
    const destPath = event.destination || ''
    const fileName = event.file_name || sourcePath.split(/[/\\]/).pop() || 'Unknown'
    const fileSize = event.file_size ? formatFileSize(event.file_size) : 'Unknown size'
    const driveLetter = getDriveLetter(destPath)

    return (
      <Dialog
        open
        onClose={onClose}
        size="xl"
        bodyClassName="px-6 py-6"
        header={
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-cs-card border ${blocked ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))]' : 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))]'}`}>
                <Shield className={`w-8 h-8 ${blocked ? 'text-cs-crit' : 'text-cs-high'}`} />
              </div>
              <div>
                <h3 className="text-2xl font-bold tracking-tight text-cs-ink">
                  {blocked ? 'File Transfer Blocked' : 'Transfer Attempt Detected'}
                </h3>
                <p className="text-cs-muted text-sm mt-1 font-mono tabular-nums">{formatDateTimeIST(event.timestamp)}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 self-start rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                         focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
            >
              <X className="h-[18px] w-[18px]" />
            </button>
          </div>
        }
      >
          <div className="space-y-6">
            {/* Status Badge */}
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border text-sm font-medium ${
                blocked
                  ? 'bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))] text-cs-ok'
                  : 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] text-cs-crit'
              }`}>
                <Ban className="w-4 h-4" />
                {blocked ? 'Successfully Blocked' : 'Block Failed'}
              </span>
              <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border text-sm font-medium uppercase ${
                event.severity === 'critical'
                  ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] text-cs-crit'
                  : 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))] text-cs-high'
              }`}>
                <Dot level={event.severity} />
                {event.severity}
              </span>
            </div>

            {/* Transfer Flow Visualization */}
            <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
              <div className="flex items-center justify-between gap-4">
                {/* Source */}
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <File className="w-5 h-5 text-cs-indigo" />
                    <label className="text-sm text-cs-ink-2 uppercase font-medium">Source</label>
                  </div>
                  <div className="bg-cs-panel rounded-cs-sm p-4 border border-cs-hair">
                    <p className="text-cs-ink font-semibold text-lg mb-1">{fileName}</p>
                    <p className="text-cs-ink-2 text-sm font-mono truncate" title={sourcePath}>
                      {sourcePath}
                    </p>
                    <p className="text-cs-muted text-xs mt-2 font-mono tabular-nums">{fileSize}</p>
                  </div>
                </div>

                {/* Arrow */}
                <div className="flex flex-col items-center gap-2">
                  <ArrowRight className="w-6 h-6 text-cs-muted-2" />
                  <span className="text-xs text-cs-muted font-medium">Copied to</span>
                </div>

                {/* Destination */}
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <HardDrive className="w-5 h-5 text-cs-crit" />
                    <label className="text-sm text-cs-ink-2 uppercase font-medium">Destination</label>
                  </div>
                  <div className="bg-cs-panel rounded-cs-sm p-4 border border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))]">
                    <div className="flex items-center gap-2 mb-1">
                      <Usb className="w-4 h-4 text-cs-crit" />
                      <p className="text-cs-crit font-semibold font-mono tabular-nums">{driveLetter || 'Destination'}</p>
                    </div>
                    <p className="text-cs-ink-2 text-sm font-mono truncate" title={destPath}>
                      {destPath}
                    </p>
                    <p className="text-cs-crit text-xs mt-2 font-medium">Blocked</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Event Details Grid */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Agent</label>
                <p className="text-cs-ink font-medium" title={event.agent_id}>
                  {agentLabel}
                </p>
              </div>
              <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">User</label>
                <p className="text-cs-ink font-medium">{event.user_email}</p>
              </div>
              <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Transfer Type</label>
                <p className="text-cs-ink font-medium capitalize">{event.transfer_type || 'File Transfer'}</p>
              </div>
              <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Action Taken</label>
                <ActionPill action={event.action_taken || event.action || 'blocked'} />
              </div>
            </div>

            {/* File Hash (if available) */}
            {event.file_hash && (
              <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <label className="text-xs text-cs-ink-2 uppercase font-medium mb-2 block">File Hash (SHA256)</label>
                <p className="text-cs-ink-2 font-mono tabular-nums text-xs break-all">{event.file_hash}</p>
              </div>
            )}

            {/* Raw JSON Data (Expandable) */}
            <div className="border-t border-cs-hair pt-4">
              <button
                onClick={() => setShowRawData(!showRawData)}
                className="flex items-center gap-2 text-cs-ink-2 hover:text-cs-ink transition-colors w-full"
              >
                {showRawData ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                <span className="text-sm font-medium">View Raw Event Data</span>
              </button>
              {showRawData && (
                <div className="mt-4 bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                  <pre className="text-xs text-cs-ink-2 font-mono overflow-x-auto">
                    {JSON.stringify(event, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
      </Dialog>
    )
  }

/* Vocabulary for browser-extension events. Mirrors
   app/core/web_activity.ACTIVITY_LABELS so a report and the dashboard call the
   same thing by the same name. */
const WEB_ACTIVITY_LABEL: Record<string, string> = {
  upload: 'Upload',
  download: 'Download',
  attach: 'Attach',
  send: 'Send',
  post: 'Post / Generate',
  ai_response: 'AI response',
}

const WEB_CATEGORY_LABEL: Record<string, string> = {
  webmail: 'Webmail',
  cloud_storage: 'Cloud storage',
  collaboration: 'Collaboration',
  genai: 'Generative AI',
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-cs-sm border border-cs-hair bg-cs-panel px-3 py-2">
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium text-cs-ink" title={String(value)}>
        {value}
      </div>
    </div>
  )
}

  // Enhanced display for different event types
  const eventType = event.event_type?.toLowerCase() || 'file'
  const isClipboard = eventType === 'clipboard'
  const isFile = eventType === 'file' && !isBlockedTransfer
  // Anything the browser extension reported: a prompt, an upload, a send.
  // These had no branch at all, so a redacted GenAI prompt — the event with the
  // most to say — rendered as a severity chip and a one-line description.
  const isWeb = !!(event.activity || event.app_category || event.app_name)
  
  // Get content to display
  const displayContent = isClipboard 
    ? (event.clipboard_content || event.content || '')
    : (event.content || event.content_redacted || '')
  
  // Get classification labels
  const classificationLabels = event.classification_labels || []
  const classification = event.classification || []
  
  // Get matched policies
  const matchedPolicies = event.matched_policies || []
  
  // Get file metadata
  const fileName = event.file_name || (event.file_path ? event.file_path.split(/[/\\]/).pop() : 'Unknown')
  const fileSize = event.file_size ? formatFileSize(event.file_size) : null
  const fileExtension = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : null

  return (
    <Dialog
      open
      onClose={onClose}
      size="2xl"
      bodyClassName="px-6 py-6"
      header={
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-cs-card border ${
              event.severity === 'critical' ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))]' :
              event.severity === 'high' ? 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))]' :
              'bg-[color-mix(in_srgb,var(--cs-med)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-med)_30%,var(--cs-panel))]'
            }`}>
              {isClipboard ? (
                <Clipboard className={`w-8 h-8 ${event.severity === 'critical' ? 'text-cs-crit' : 'text-cs-high'}`} />
              ) : (
                <File className={`w-8 h-8 ${event.severity === 'critical' ? 'text-cs-crit' : 'text-cs-high'}`} />
              )}
            </div>
            <div>
              <h3 className="text-2xl font-bold tracking-tight text-cs-ink">
                {isClipboard ? 'Clipboard Violation' : isFile ? (
                  // Show action type and file name prominently for file events
                  event.event_subtype ? (
                    <>
                      {getEventSubtypeLabel(event.event_subtype, event.details?.change_type)}
                      {fileName && fileName !== 'Unknown' && (
                        <span className="text-cs-ink-2 font-normal">: {fileName}</span>
                      )}
                    </>
                  ) : event.description || (fileName ? `File Event: ${fileName}` : 'File Event')
                ) : 'Event Details'}
              </h3>
              <p className="text-cs-muted text-sm mt-1 font-mono tabular-nums">{formatDateTimeIST(event.timestamp)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 self-start rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      }
    >
        <div className="space-y-6">
          {/* Severity, Action, and Quarantine Badges */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Prominent Action Type Badge for OneDrive/Google Drive */}
            {event.event_subtype && (event.source === 'onedrive_cloud' || event.source === 'google_drive_cloud') && (
              <span className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-cs-sm border text-base font-semibold ${getEventSubtypeColor(event.event_subtype)}`}>
                {getEventSubtypeIcon(event.event_subtype)}
                {getEventSubtypeLabel(event.event_subtype, event.details?.change_type)}
              </span>
            )}
            <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border text-sm font-medium uppercase ${
              event.severity === 'critical' ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] text-cs-crit' :
              event.severity === 'high' ? 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))] text-cs-high' :
              event.severity === 'medium' ? 'bg-[color-mix(in_srgb,var(--cs-med)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-med)_30%,var(--cs-panel))] text-cs-med' :
              'bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))] text-cs-ok'
            }`}>
              <Dot level={event.severity} />
              {event.severity}
            </span>
            <span className="inline-flex items-center gap-2">
              {getActionIcon(event.action_taken || event.action || (event.quarantined ? 'quarantined' : 'logged'))}
              <ActionPill action={event.action_taken || (event.quarantined ? 'quarantined' : event.action) || 'logged'} />
            </span>
            {event.quarantined && (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-cs-sm border text-xs font-medium bg-cs-indigo-faint border-[color-mix(in_srgb,var(--cs-indigo)_30%,var(--cs-panel))] text-cs-indigo uppercase">
                <Download className="w-3 h-3" />
                Quarantined
              </span>
            )}
          </div>

          {/* Activity Details Section - For OneDrive/Google Drive events */}
          {(event.source === 'onedrive_cloud' || event.source === 'google_drive_cloud') && event.event_subtype && (
            <div className="bg-cs-indigo-faint rounded-cs-card p-6 border border-[color-mix(in_srgb,var(--cs-indigo)_20%,var(--cs-panel))]">
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-cs-sm ${getEventSubtypeColor(event.event_subtype)}`}>
                  {getEventSubtypeIcon(event.event_subtype)}
                </div>
                <label className="text-sm text-cs-ink-2 uppercase font-semibold">Activity Details</label>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Action Performed</label>
                    <div className={`inline-flex items-center gap-2 px-3 py-2 rounded-cs-sm border text-sm font-medium ${getEventSubtypeColor(event.event_subtype)}`}>
                      {getEventSubtypeIcon(event.event_subtype)}
                      {getEventSubtypeLabel(event.event_subtype, event.details?.change_type)}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Timestamp</label>
                    <p className="text-cs-ink font-medium font-mono tabular-nums">{formatDateTimeIST(event.timestamp)}</p>
                  </div>
                </div>
                {event.user_email && event.user_email !== 'unknown@onedrive' && (
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Performed By</label>
                    <p className="text-cs-ink font-medium">{event.user_email}</p>
                  </div>
                )}
                {event.details?.change_type && (
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Change Type</label>
                    <p className="text-cs-ink font-mono text-sm bg-cs-panel px-3 py-1.5 rounded-cs-sm border border-cs-hair inline-block">
                      {event.details.change_type}
                    </p>
                  </div>
                )}
                {/* Show additional context for moved/renamed files */}
                {(event.event_subtype?.includes('moved') || event.event_subtype?.includes('renamed')) && event.details?.raw_delta_item && (
                  <div className="bg-cs-panel rounded-cs-sm p-4 border border-cs-hair">
                    <label className="text-xs text-cs-muted mb-2 block uppercase font-medium">Additional Context</label>
                    {event.details.raw_delta_item.parentReference && (
                      <div className="space-y-2">
                        <div>
                          <span className="text-xs text-cs-ink-2">Current Location: </span>
                          <span className="text-cs-ink font-mono text-sm">{event.details.raw_delta_item.parentReference.path || 'Root'}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Clipboard Event - Show Clipboard Content */}
          {isClipboard && displayContent && (
            <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
              <div className="flex items-center gap-2 mb-4">
                <Clipboard className="w-5 h-5 text-cs-indigo" />
                <label className="text-sm text-cs-ink-2 uppercase font-medium">Clipboard Content</label>
              </div>
              <div className="bg-cs-panel rounded-cs-sm p-4 border border-cs-hair">
                <p className="text-cs-ink font-mono text-sm whitespace-pre-wrap break-words">
                  {displayContent}
                </p>
              </div>
            </div>
          )}

          {/* Web activity — where it went, what was in it, and what left */}
          {isWeb && (
            <div className="rounded-cs-card border border-cs-hair bg-cs-panel-2 p-6">
              <div className="mb-4 flex items-center gap-2">
                <Globe className="h-5 w-5 text-cs-indigo" />
                <label className="text-sm font-medium uppercase text-cs-ink-2">
                  {WEB_ACTIVITY_LABEL[event.activity || ''] || 'Web activity'}
                  {event.app_name ? ` — ${event.app_name}` : ''}
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Fact label="Destination" value={event.app_name || event.page_host || '—'} />
                <Fact label="Category" value={WEB_CATEGORY_LABEL[event.app_category || ''] || event.app_category || '—'} />
                <Fact label="Activity" value={WEB_ACTIVITY_LABEL[event.activity || ''] || event.activity || '—'} />
              </div>

              {event.page_url && (
                <div className="mt-3">
                  <div className="eyebrow mb-1">Page</div>
                  <p className="break-all font-mono text-xs text-cs-ink-2">{event.page_url}</p>
                </div>
              )}

              {(event.matched_rules?.length || event.policy_reason) && (
                <div className="mt-4 border-t border-cs-hair pt-4">
                  <div className="eyebrow mb-1.5">Why</div>
                  {event.matched_rules?.length ? (
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      {event.matched_rules.map((r: string) => (
                        <span key={r} className="badge badge-info">{r}</span>
                      ))}
                    </div>
                  ) : null}
                  {event.policy_reason && (
                    <p className="text-sm leading-relaxed text-cs-ink-2">{event.policy_reason}</p>
                  )}
                </div>
              )}

              {/*
                The before and after.

                This is the whole point of a redaction event and the only place
                in the product where both halves exist: what the person typed,
                and what actually reached the vendor. Showing one without the
                other leaves the reader to take the verdict on trust.
              */}
              {event.masked_text ? (
                <div className="mt-4 border-t border-cs-hair pt-4">
                  {!!event.mask_summary?.length && (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      <span className="eyebrow">Replaced</span>
                      {event.mask_summary.map((m: { type: string; count: number }) => (
                        <span key={m.type} className="badge badge-warning">
                          {m.count} × {m.type.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div>
                      <div className="eyebrow mb-1">What was typed</div>
                      <div className="rounded-cs-sm border border-cs-crit/25 bg-cs-crit/[0.05] p-3">
                        <p className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-cs-ink">
                          {event.text_content || event.content}
                        </p>
                      </div>
                    </div>
                    <div>
                      <div className="eyebrow mb-1">
                        What reached {event.app_name || 'the site'}
                      </div>
                      <div className="rounded-cs-sm border border-cs-ok/25 bg-cs-ok/[0.06] p-3">
                        <p className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-cs-ink">
                          {event.masked_text}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                (event.text_content || event.content) && (
                  <div className="mt-4 border-t border-cs-hair pt-4">
                    <div className="eyebrow mb-1">
                      {event.blocked ? 'What was stopped' : 'What was submitted'}
                    </div>
                    <div className="rounded-cs-sm border border-cs-hair bg-cs-panel p-3">
                      <p className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-cs-ink">
                        {event.text_content || event.content}
                      </p>
                    </div>
                    {event.text_truncated && (
                      <p className="mt-1 text-[11.5px] text-cs-muted">
                        Capped at the inspection limit — the message was longer than this.
                      </p>
                    )}
                  </div>
                )
              )}

              {!!event.attachment_names?.length && (
                <div className="mt-4 border-t border-cs-hair pt-4">
                  <div className="eyebrow mb-1.5">Attachments</div>
                  <div className="flex flex-wrap gap-1.5">
                    {event.attachment_names.map((n: string) => (
                      <span key={n} className="badge badge-info font-mono">{n}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* File Event - Show File Info, Quarantine Status, and Content */}
          {isFile && (
            <>
              {/* File Information */}
              <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
                <div className="flex items-center gap-2 mb-4">
                  <File className="w-5 h-5 text-cs-indigo" />
                  <label className="text-sm text-cs-ink-2 uppercase font-medium">File Information</label>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-cs-muted mb-1 block">File Name</label>
                    <p className="text-cs-ink font-semibold text-lg">{fileName}</p>
                  </div>
                  {event.file_path && (
                    <div>
                      <label className="text-xs text-cs-muted mb-1 block">File Path</label>
                      <p className="text-cs-ink font-mono text-sm break-all">{event.file_path}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-4">
                    {fileSize && (
                      <div>
                        <label className="text-xs text-cs-muted mb-1 block">Size</label>
                        <p className="text-cs-ink font-medium font-mono tabular-nums">{fileSize}</p>
                      </div>
                    )}
                    {fileExtension && (
                      <div>
                        <label className="text-xs text-cs-muted mb-1 block">Extension</label>
                        <p className="text-cs-ink font-medium font-mono tabular-nums">.{fileExtension}</p>
                      </div>
                    )}
                    {event.file_hash && (
                      <div>
                        <label className="text-xs text-cs-muted mb-1 block">Hash (SHA256)</label>
                        <p className="text-cs-ink font-mono tabular-nums text-xs break-all" title={event.file_hash}>
                          {event.file_hash.substring(0, 16)}...
                        </p>
                      </div>
                    )}
                    {event.quarantined && event.quarantine_path && (
                      <div className="col-span-3">
                        <label className="text-xs text-cs-indigo mb-1 block uppercase font-medium">Quarantine Path</label>
                        <p className="text-cs-indigo font-mono tabular-nums text-xs break-all">
                          {event.quarantine_path}
                        </p>
                        {event.quarantine_timestamp && (
                          <p className="text-cs-indigo text-xs mt-1">
                            Quarantined at: <span className="font-mono tabular-nums">{formatDateTimeIST(event.quarantine_timestamp)}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* File Content Snippet */}
              {displayContent && (
                <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
                  <div className="flex items-center gap-2 mb-4">
                    <Eye className="w-5 h-5 text-cs-indigo" />
                    <label className="text-sm text-cs-ink-2 uppercase font-medium">Content That Triggered Violation</label>
                  </div>
                  <div className="bg-cs-panel rounded-cs-sm p-4 border border-cs-hair max-h-64 overflow-y-auto">
                    <pre className="text-cs-ink font-mono text-xs whitespace-pre-wrap break-words">
                      {displayContent.length > 2000 ? displayContent.substring(0, 2000) + '\n\n... (truncated)' : displayContent}
                    </pre>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Classification Level and Confidence Score */}
          {(event.classification_level || event.classification_score || event.document_type_label) && (
            <div className="bg-cs-indigo-faint rounded-cs-card p-6 border border-[color-mix(in_srgb,var(--cs-indigo)_20%,var(--cs-panel))]">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-5 h-5 text-cs-indigo" />
                <label className="text-sm text-cs-ink-2 uppercase font-semibold">Classification Result</label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {event.document_type_label && (
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Document Type</label>
                    <span className="inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border text-base font-bold bg-[color-mix(in_srgb,var(--cs-indigo)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-indigo)_30%,var(--cs-panel))] text-cs-indigo">
                      <FileText className="w-4 h-4" />
                      {event.document_type_label}
                    </span>
                  </div>
                )}
                {event.classification_level && (
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Classification Level</label>
                    <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border text-base font-bold ${
                      event.classification_level === 'Restricted' ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] text-cs-crit' :
                      event.classification_level === 'Confidential' ? 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))] text-cs-high' :
                      event.classification_level === 'Internal' ? 'bg-[color-mix(in_srgb,var(--cs-med)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-med)_30%,var(--cs-panel))] text-cs-med' :
                      'bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))] text-cs-ok'
                    }`}>
                      {event.classification_level}
                    </span>
                  </div>
                )}
                {event.classification_score != null && event.classification_score > 0 && (
                  <div>
                    <label className="text-xs text-cs-ink-2 mb-1 block">Confidence Score</label>
                    <p className="font-mono text-2xl font-semibold tabular-nums text-cs-ink">
                      {Math.round(event.classification_score * 100)}%
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Classification Labels - What Was Detected */}
          {classificationLabels.length > 0 && (
            <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-cs-med" />
                <label className="text-sm text-cs-ink-2 uppercase font-medium">Detected Sensitive Data</label>
              </div>
              <div className="flex flex-wrap gap-2">
                {classificationLabels.map((label: string, idx: number) => {
                  const conf = classification[idx]?.confidence || event.classification_score || 1.0
                  // "Indian Aadhaar Number" says what it is; "PII" says what
                  // kind. Both are already on the detection — showing only the
                  // rule name makes two very different findings ("Credit Card
                  // Number", "Medical Terms") read as the same kind of thing.
                  const category = classification[idx]?.sensitive_data?.category
                  const count = classification[idx]?.sensitive_data?.count
                  return (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-cs-sm border bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] text-cs-crit text-sm font-medium"
                    >
                      <Shield className="w-4 h-4" />
                      {label}
                      {category && <span className="text-xs opacity-75">{category}</span>}
                      {count > 1 && <span className="text-xs opacity-75 font-mono tabular-nums">x{count}</span>}
                      {conf < 1.0 && <span className="text-xs opacity-75 font-mono tabular-nums">({Math.round(conf * 100)}%)</span>}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Matched Policies */}
          {matchedPolicies.length > 0 && (
            <div className="bg-cs-hair-2 rounded-cs-card p-6 border border-cs-hair">
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-5 h-5 text-cs-indigo" />
                <label className="text-sm text-cs-ink-2 uppercase font-medium">Matched Policies</label>
              </div>
              <div className="space-y-3">
                {matchedPolicies.map((policy: any, idx: number) => (
                  <div key={idx} className="bg-cs-panel rounded-cs-sm p-4 border border-cs-hair">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-cs-ink font-semibold">{policy.policy_name || 'Unknown Policy'}</p>
                        {/*
                          A policy that examined this activity and let it
                          through is listed here too — it is the answer to "why
                          was this allowed?". Saying so explicitly matters: the
                          badge on the right shows the POLICY's severity, so a
                          high-severity rule sitting on a low-severity allowed
                          event reads as though it fired unless the card says
                          plainly that it did not.
                        */}
                        {policy.enforced === false && (
                          <span className="mt-1 inline-flex items-center gap-1.5 rounded-cs-sm bg-cs-hair-2 px-2 py-0.5 text-xs text-cs-muted">
                            Considered — did not act
                          </span>
                        )}
                        {policy.reason && (
                          <p className="mt-2 text-xs leading-relaxed text-cs-ink-2">{policy.reason}</p>
                        )}
                        {policy.matched_rules && policy.matched_rules.length > 0 && (
                          <div className="mt-2 space-y-1">
                            <p className="text-xs text-cs-muted">Matched Rules:</p>
                            {policy.matched_rules.map((rule: any, ruleIdx: number) => (
                              <p key={ruleIdx} className="text-xs text-cs-ink-2 font-mono ml-2">
                                • {rule.field} {rule.operator} {Array.isArray(rule.value) ? rule.value.join(', ') : rule.value}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-cs-sm text-xs font-medium ${
                          policy.severity === 'critical' ? 'bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] text-cs-crit' :
                          policy.severity === 'high' ? 'bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] text-cs-high' :
                          'bg-[color-mix(in_srgb,var(--cs-med)_12%,var(--cs-panel))] text-cs-med'
                        }`}>
                          <Dot level={policy.severity} />
                          {policy.severity}
                        </span>
                        {policy.priority && (
                          <span className="text-xs text-cs-muted">Priority: <span className="num">{policy.priority}</span></span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Content Changes (file_modified diff) */}
          {Array.isArray(event.content_changes) && event.content_changes.length > 0 && (
            <div className="border border-cs-hair rounded-cs-sm overflow-hidden">
              <div className="bg-cs-hair-2 px-4 py-2 flex items-center justify-between text-xs text-cs-ink-2">
                <span className="font-semibold uppercase tracking-wide">Content Changes</span>
                <span className="font-mono tabular-nums">
                  <span className="text-cs-ok">+{event.lines_added ?? 0}</span>
                  {' '}
                  <span className="text-cs-crit">-{event.lines_removed ?? 0}</span>
                  {event.content_changes_truncated && (
                    <span className="ml-2 text-cs-med">(truncated)</span>
                  )}
                </span>
              </div>
              <div className="max-h-80 overflow-y-auto font-mono text-xs">
                {event.content_changes.map((c: any, idx: number) => {
                  const isAdd = c.action === 'added'
                  return (
                    <div
                      key={idx}
                      className={`px-3 py-1 flex gap-3 border-b border-cs-hair-2 ${
                        isAdd ? 'bg-[color-mix(in_srgb,var(--cs-ok)_10%,var(--cs-panel))]' : 'bg-[color-mix(in_srgb,var(--cs-crit)_10%,var(--cs-panel))]'
                      }`}
                    >
                      <span className="text-cs-muted w-12 shrink-0 text-right select-none tabular-nums">
                        {c.line ?? ''}
                      </span>
                      <span className={`w-3 shrink-0 ${isAdd ? 'text-cs-ok' : 'text-cs-crit'}`}>
                        {isAdd ? '+' : '-'}
                      </span>
                      <span className={`whitespace-pre-wrap break-words ${
                        isAdd ? 'text-cs-ok' : 'text-cs-crit'
                      }`}>
                        {c.content || ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Standard Event Details Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
              <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Event Type</label>
              <p className="text-cs-ink font-medium capitalize">
                {event.event_subtype ? event.event_subtype.replace(/_/g, ' ') : event.event_type}
              </p>
            </div>
            <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
              <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">User</label>
              <p className="text-cs-ink font-medium">{event.user_email}</p>
            </div>
            <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
              <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Agent</label>
              <p className="text-cs-ink font-medium" title={event.agent_id}>
                {agentLabel}
              </p>
            </div>
            <div className="bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
              <label className="text-xs text-cs-ink-2 uppercase font-medium mb-1 block">Description</label>
              <p className="text-cs-ink font-medium text-sm">{event.description || 'N/A'}</p>
            </div>
          </div>

          {/* USB Device Details — shown for USB events that carry device metadata */}
          {event.event_type?.toLowerCase() === 'usb' &&
            (event.device_name || event.product_name || event.serial_number ||
             event.volume_label || event.manufacturer || event.vendor_id) && (
            <div className="rounded-cs-card border border-cs-hair overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 bg-cs-hair-2 border-b border-cs-hair">
                <Usb className="w-4 h-4 text-cs-muted" />
                <span className="text-xs font-semibold text-cs-ink-2 uppercase tracking-wide">USB Device Details</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-cs-hair">
                {[
                  ['Device', event.product_name || event.device_name],
                  ['Manufacturer', event.manufacturer],
                  ['Serial Number', event.serial_number],
                  ['Volume Label', event.volume_label],
                  ['Volume Serial', event.volume_serial],
                  ['Filesystem', event.file_system],
                  ['Drive Letter', event.drive_letter],
                  ['Capacity', event.capacity_bytes ? formatFileSize(Number(event.capacity_bytes)) : null],
                  ['Vendor ID', event.vendor_id ? `VID_${event.vendor_id}` : null],
                  ['Product ID', event.product_id ? `PID_${event.product_id}` : null],
                ]
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div key={label as string} className="bg-cs-panel p-3">
                      <label className="text-[11px] text-cs-muted uppercase font-medium mb-0.5 block">{label}</label>
                      <p className="text-cs-ink text-sm font-medium font-mono tabular-nums break-words">{value}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Printer Details — shown for print events */}
          {event.event_type?.toLowerCase() === 'print' && event.printer_name && (
            <div className="rounded-cs-card border border-cs-hair overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 bg-cs-hair-2 border-b border-cs-hair">
                <Printer className="w-4 h-4 text-cs-muted" />
                <span className="text-xs font-semibold text-cs-ink-2 uppercase tracking-wide">Printer Details</span>
              </div>
              <div className="grid grid-cols-2 gap-px bg-cs-hair">
                <div className="bg-cs-panel p-3">
                  <label className="text-[11px] text-cs-muted uppercase font-medium mb-0.5 block">Printer</label>
                  <p className="text-cs-ink text-sm font-medium break-words">{event.printer_name}</p>
                </div>
                <div className="bg-cs-panel p-3">
                  <label className="text-[11px] text-cs-muted uppercase font-medium mb-0.5 block">Decision</label>
                  <p className="text-sm font-medium">
                    {event.block_reason === 'printer_control'
                      ? <span className="text-cs-crit">Blocked — printer control policy</span>
                      : event.block_reason === 'content'
                      ? <span className="text-cs-crit">Blocked — sensitive content</span>
                      : <span className="text-cs-emerald">Allowed</span>}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* File Hashes — MD5/SHA-256 of the inspected/"violated" file (print channel etc.) */}
          {(event.file_md5 || event.file_sha256) && (
            <div className="rounded-cs-card border border-cs-hair overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 bg-cs-hair-2 border-b border-cs-hair">
                <FileText className="w-4 h-4 text-cs-muted" />
                <span className="text-xs font-semibold text-cs-ink-2 uppercase tracking-wide">File Hashes</span>
              </div>
              <div className="divide-y divide-cs-hair">
                {event.file_md5 && (
                  <div className="bg-cs-panel p-3">
                    <label className="text-[11px] text-cs-muted uppercase font-medium mb-0.5 block">MD5</label>
                    <p className="text-cs-ink font-mono tabular-nums text-xs break-all select-all">{event.file_md5}</p>
                  </div>
                )}
                {event.file_sha256 && (
                  <div className="bg-cs-panel p-3">
                    <label className="text-[11px] text-cs-muted uppercase font-medium mb-0.5 block">SHA-256</label>
                    <p className="text-cs-ink font-mono tabular-nums text-xs break-all select-all">{event.file_sha256}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Raw JSON Data (Expandable) */}
          <div className="border-t border-cs-hair pt-4">
            <button
              onClick={() => setShowRawData(!showRawData)}
              className="flex items-center gap-2 text-cs-ink-2 hover:text-cs-ink transition-colors w-full"
            >
              {showRawData ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              <span className="text-sm font-medium">View Raw Event Data</span>
            </button>
            {showRawData && (
              <div className="mt-4 bg-cs-hair-2 rounded-cs-sm p-4 border border-cs-hair">
                <pre className="text-xs text-cs-ink-2 font-mono overflow-x-auto">
                  {JSON.stringify(event, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
    </Dialog>
  )
}

export default function Events() {
  const [searchParams, setSearchParams] = useSearchParams()
  const agentParam = searchParams.get('agent')

  // Phase 3: dashboard drill-down params. Read from URL; forward to backend.
  const dashboardFilters = useMemo(() => {
    const get = (k: string) => searchParams.get(k) || undefined
    return {
      module: get('module'),
      event_type: get('event_type'),
      classification: get('classification'),
      action: get('action'),
      severity: get('severity'),
      channel: get('channel'),
      start_date: get('start_date'),
      end_date: get('end_date'),
      time_range: get('time_range'),
    }
  }, [searchParams])

  const activeDashboardFilters = useMemo(
    () => Object.entries(dashboardFilters).filter(([, v]) => !!v),
    [dashboardFilters],
  )

  const [kqlQuery, setKqlQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState(agentParam || '')
  const [showFilters, setShowFilters] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // When the user clicks an agent from the Agents tab, we land here
  // with ?agent=<id>. The id is forwarded to the backend as a dedicated
  // ``agent`` query param (expanded to current + previous_agent_ids
  // server-side) — NOT stuffed into the free-text search box, since the
  // search box does substring matching on a single agent_id field and
  // would silently miss events emitted under a reinstall's prior UUID.
  useEffect(() => {
    if (agentParam) {
      setKqlQuery('')
      setActiveQuery('')
    }
  }, [agentParam])

  // Fetch agents to map agent_id to agent name. We use /agents/all so the
  // fallback map covers OFFLINE agents too — /agents/ only returns those
  // with a recent heartbeat, so an event from a powered-off laptop would
  // otherwise render as "Unknown Agent" even though the agent exists.
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'all-for-events'],
    queryFn: getAllAgents,
    refetchInterval: 30000, // Refresh every 30s
  })

  // Create agent lookup map keyed by both agent_id AND hostname/name, so
  // legacy events that recorded the hostname as agent_id still resolve.
  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; agent_code?: number }>()
    if (agentsData && Array.isArray(agentsData)) {
      agentsData.forEach((agent: any) => {
        if (!agent?.name) return
        const entry = { name: agent.name, agent_code: agent.agent_code }
        if (agent.agent_id) map.set(agent.agent_id, entry)
        // Also index by name so a legacy event whose agent_id is actually
        // the hostname (e.g. "WIN-DESK-01") still finds the agent record.
        map.set(agent.name, entry)
      })
    }
    return map
  }, [agentsData])

  // Resolve an event's agent label using server enrichment first, then
  // the local agentMap. Returns "NAME (NNN)" or "Unknown Agent".
  const getEventAgentLabel = (event: Event): string => {
    const hostname = (event as any).hostname || (event as any).agent_hostname
    const fallback =
      (event.agent_id ? agentMap.get(event.agent_id) : undefined) ||
      (hostname ? agentMap.get(hostname) : undefined)
    return formatAgentLabel(
      event.agent_name,
      event.agent_code ?? fallback?.agent_code,
      fallback?.name,
    )
  }

  // Helper function to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  // Check if event is a blocked transfer
  const isBlockedTransfer = (event: any): boolean => {
    // Check if it's a file event with transfer-related indicators
    if (event.event_type !== 'file') return false
    
    // Check for transfer-related fields
    const hasTransferSubtype = event.event_subtype === 'transfer_blocked' || event.event_subtype === 'transfer_attempt'
    const hasTransferType = event.transfer_type === 'usb_copy'
    const hasDestination = event.destination && event.destination !== null
    const hasBlockedField = event.blocked === true || event.blocked === false // Explicitly set
    const descriptionMatches = event.description?.toLowerCase().includes('transfer blocked') || 
                                event.description?.toLowerCase().includes('file transfer')
    
    // Must have file_path and at least one transfer indicator
    return event.file_path && (
      (hasTransferSubtype && hasDestination) ||
      (hasTransferType && hasDestination) ||
      (hasBlockedField && hasDestination && descriptionMatches)
    )
  }

  // Extract USB drive letter from destination path
  const getDriveLetter = (path: string): string => {
    if (!path) return ''
    const match = path.match(/^([A-Z]):/)
    return match ? match[1] + ':' : ''
  }

  // Helper functions for OneDrive/Google Drive event subtypes
  const getEventSubtypeIcon = (subtype: string) => {
    const normalized = subtype?.toLowerCase() || ''
    if (normalized.includes('created')) return <FilePlus className="w-4 h-4" />
    if (normalized.includes('modified') || normalized.includes('updated')) return <FileEdit className="w-4 h-4" />
    if (normalized.includes('deleted')) return <FileX className="w-4 h-4" />
    if (normalized.includes('moved') || normalized.includes('renamed')) return <Move className="w-4 h-4" />
    if (normalized.includes('copied')) return <Copy className="w-4 h-4" />
    return <File className="w-4 h-4" />
  }

  const getEventSubtypeColor = (subtype: string) => {
    const normalized = subtype?.toLowerCase() || ''
    if (normalized.includes('created')) return 'text-cs-ok bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))]'
    if (normalized.includes('modified') || normalized.includes('updated')) return 'text-cs-indigo bg-cs-indigo-faint border-[color-mix(in_srgb,var(--cs-indigo)_30%,var(--cs-panel))]'
    if (normalized.includes('deleted')) return 'text-cs-crit bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))]'
    if (normalized.includes('moved') || normalized.includes('renamed')) return 'text-cs-high bg-[color-mix(in_srgb,var(--cs-high)_12%,var(--cs-panel))] border-[color-mix(in_srgb,var(--cs-high)_30%,var(--cs-panel))]'
    if (normalized.includes('copied')) return 'text-cs-indigo bg-cs-indigo-faint border-cs-indigo/25'
    return 'text-cs-ink-2 bg-cs-hair-2 border-cs-hair'
  }

  const getEventSubtypeLabel = (subtype: string, changeType?: string) => {
    if (!subtype) return 'File Activity'
    const normalized = subtype.toLowerCase()
    if (normalized.includes('created')) return 'File Created'
    if (normalized.includes('modified') || normalized.includes('updated')) return 'File Modified'
    if (normalized.includes('deleted')) return 'File Deleted'
    if (normalized.includes('moved')) return 'File Moved'
    if (normalized.includes('renamed')) return 'File Renamed'
    if (normalized.includes('copied')) return 'File Copied'
    if (changeType) {
      return changeType.charAt(0).toUpperCase() + changeType.slice(1)
    }
    return 'File Activity'
  }

  // Fetch events — forward dashboard drill-down filters as query params
  // (backend merges them into the Mongo filter alongside ABAC).
  // Any change to the search/agent/filter set collapses the result set to a
  // new page 1 — otherwise you could sit on "page 40" of a filter that now has
  // only 2 pages and see an empty list.
  useEffect(() => {
    setPage(1)
  }, [activeQuery, agentParam, dashboardFilters])

  const {
    data,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['events', activeQuery, agentParam, dashboardFilters, page, pageSize],
    queryFn: () => {
      const params: Record<string, any> = {
        limit: pageSize,
        skip: (page - 1) * pageSize,
      }
      if (activeQuery) params.search = activeQuery
      if (agentParam) params.agent = agentParam
      // Only include filter params that are actually set.
      for (const [k, v] of Object.entries(dashboardFilters)) {
        if (v) params[k] = v
      }
      return searchEvents(params)
    },
    refetchInterval: 15000,
    // Keep the current page visible while the next one loads — no flash to a
    // blank list on every page change.
    placeholderData: keepPreviousData,
  })

  const events = data?.events || []
  const total = data?.total || 0

  const handleSearch = () => {
    setActiveQuery(kqlQuery)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  /*
    Deleting every event is the most destructive thing this console can do, and
    it used to be guarded by window.confirm() — a browser dialog that looks
    like it belongs to a different application, cannot say how many records are
    about to go, and is styled identically whether it is asking about a typo or
    about the entire audit trail.
  */
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const handleClearLogs = async () => {
    setClearing(true)
    try {
      const result = await clearAllEvents()
      toast.success(`Deleted ${result.deleted_count} events`)
      refetch()
      setConfirmClear(false)
    } catch (error: any) {
      toast.error(extractErrorDetail(error, 'Failed to delete events'))
    } finally {
      setClearing(false)
    }
  }

  const handleManualRefresh = async () => {
    setIsRefreshing(true)
    try {
      // Refresh events from database
      await refetch()
      toast.success('Events refreshed.')
    } catch (error: any) {
      console.error('Manual refresh error:', error)
      toast.error(extractErrorDetail(error, 'Failed to refresh events'))
    } finally {
      setIsRefreshing(false)
    }
  }

  // Quick filter examples
  const quickFilters = [
    { label: 'Critical Events', query: 'event.severity:critical' },
    { label: 'Blocked Events', query: 'blocked:true' },
    { label: 'File Events', query: 'event.type:file' },
    { label: 'USB Events', query: 'event.type:usb' },
    { label: 'Clipboard Events', query: 'event.type:clipboard' },
    { label: 'With Classifications', query: 'classification:*' },
  ]

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <p className="eyebrow mb-1.5">Monitoring</p>
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Events</h1>
        <p className="mt-1 text-sm text-cs-ink-2">
          Search and analyze DLP events by keyword
        </p>
      </div>

      {/* Active dashboard drill-down filters */}
      {activeDashboardFilters.length > 0 && (
        <div className="bg-cs-indigo-faint border border-[color-mix(in_srgb,var(--cs-indigo)_25%,var(--cs-panel))] rounded-cs-card px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-cs-indigo font-medium">
              Drill-down from dashboard:
            </span>
            {activeDashboardFilters.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-cs-sm bg-cs-panel border border-[color-mix(in_srgb,var(--cs-indigo)_25%,var(--cs-panel))] text-xs font-medium text-cs-indigo"
              >
                {k}=<span className="font-mono tabular-nums">{v}</span>
              </span>
            ))}
          </div>
          <button
            onClick={() => {
              const next = new URLSearchParams(searchParams)
              for (const [k] of activeDashboardFilters) next.delete(k)
              setSearchParams(next, { replace: true })
            }}
            className="text-xs text-cs-indigo hover:text-cs-indigo-d hover:underline font-medium"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Search Bar */}
      <div className="card">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-cs-muted-2" />
            <input
              type="text"
              placeholder='Search events (e.g., usb, clipboard, google drive, block, etc.)'
              className="input pl-10"
              value={kqlQuery}
              onChange={(e) => setKqlQuery(e.target.value)}
              onKeyPress={handleKeyPress}
            />
          </div>
          <button onClick={handleSearch} className="btn-primary">
            Search
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="btn-secondary"
          >
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>

        {/* Quick Filters */}
        {showFilters && (
          <div className="mt-4 pt-4 border-t border-cs-hair">
            <p className="text-sm font-medium text-cs-ink-2 mb-2">
              Quick Filters:
            </p>
            <div className="flex flex-wrap gap-2">
              {quickFilters.map((filter) => (
                <button
                  key={filter.label}
                  onClick={() => {
                    setKqlQuery(filter.query)
                    setActiveQuery(filter.query)
                  }}
                  className="px-3 py-1 text-sm border border-cs-hair rounded-cs-sm text-cs-ink-2 hover:bg-cs-hair-2 transition-colors"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* KQL Help */}
        <div className="mt-4 pt-4 border-t border-cs-hair">
          <p className="text-xs text-cs-ink-2">
            <strong>KQL Examples:</strong> field:value, field:"exact value",
            field:* (wildcard), field:(value1 OR value2), field &gt; 100, NOT field:value
          </p>
        </div>
      </div>

      {/* Results */}
      <div className="card p-0">
        {/* Results Header */}
        <div className="px-6 py-4 border-b border-cs-hair flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="section-title">Search Results</h3>
            <p className="text-sm text-cs-ink-2 mt-1">
              <span className="num">{total.toLocaleString()}</span> events found
              {activeQuery && (
                <span className="ml-2">
                  for query: <code className="text-xs font-mono bg-cs-hair-2 px-1 py-0.5 rounded-cs-sm">{activeQuery}</code>
                </span>
              )}
            </p>
          </div>
          {/*
            Both of these are utilities, not the point of the page — the point
            is the results underneath. They used to be a solid indigo pill and a
            solid red one, which made "delete every event" the brightest object
            on the screen and gave it exactly the same weight as "refresh".
          */}
          <div className="flex items-center gap-1">
            <button
              onClick={handleManualRefresh}
              className="btn btn-ghost"
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              Refresh
            </button>
            <button
              onClick={() => setConfirmClear(true)}
              className="btn btn-ghost text-cs-crit hover:bg-cs-crit/[0.07] hover:text-cs-crit"
              disabled={events.length === 0}
            >
              <Trash2 className="h-4 w-4" />
              Delete all events
            </button>
          </div>
        </div>

        {/* Results List */}
        <div className="divide-y divide-cs-hair">
          {isLoading ? (
            <LoadingSpinner />
          ) : error ? (
            <div className="p-6">
              <ErrorMessage message="Failed to load events" retry={() => refetch()} />
            </div>
          ) : events.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="h-12 w-12 text-cs-muted-2 mx-auto mb-3" />
              <p className="text-cs-ink-2 font-medium">No events found</p>
              <p className="text-sm text-cs-muted mt-1">
                Try adjusting your search query
              </p>
            </div>
          ) : (
            events.map((event) => (
              <div
                key={event.id || event.event_id}
                className="p-4 hover:bg-cs-hair-2 cursor-pointer transition-colors"
                onClick={() => setSelectedEvent(event)}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div
                    className={cn(
                      'p-2 rounded-cs-sm',
                      event.blocked
                        ? 'bg-[color-mix(in_srgb,var(--cs-crit)_14%,var(--cs-panel))]'
                        : event.severity === 'critical'
                        ? 'bg-[color-mix(in_srgb,var(--cs-crit)_10%,var(--cs-panel))]'
                        : event.severity === 'high'
                        ? 'bg-[color-mix(in_srgb,var(--cs-high)_10%,var(--cs-panel))]'
                        : 'bg-cs-indigo-faint'
                    )}
                  >
                    {event.event_type === 'file' ? (
                      <FileText className="h-5 w-5 text-cs-ink-2" />
                    ) : event.event_type === 'usb' ? (
                      <Shield className="h-5 w-5 text-cs-ink-2" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-cs-ink-2" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {/* Event Title */}
                    {event.title && (
                      <h4 className="font-semibold text-cs-ink mb-2 text-base">
                        {event.title}
                      </h4>
                    )}

                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {/* Show action type prominently for OneDrive/Google Drive events */}
                      {event.event_subtype && (event.source === 'onedrive_cloud' || event.source === 'google_drive_cloud') && (
                        <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-cs-sm border text-sm font-semibold ${getEventSubtypeColor(event.event_subtype)}`}>
                          {getEventSubtypeIcon(event.event_subtype)}
                          {getEventSubtypeLabel(event.event_subtype, event.details?.change_type)}
                        </span>
                      )}
                      <span className="badge inline-flex items-center gap-1.5 capitalize">
                        <Dot level={event.severity} />
                        {event.severity}
                      </span>
                      <span className="badge badge-info">
                        {event.event_type}
                      </span>
                      {event.blocked && (
                        <ActionPill action="blocked" />
                      )}
                      {event.classification_labels && event.classification_labels.length > 0 && (
                        <span className="badge bg-cs-indigo-faint text-cs-indigo ring-[color-mix(in_srgb,var(--cs-indigo)_25%,var(--cs-panel))]">
                          {event.classification_labels[0]}
                        </span>
                      )}
                      {event.document_type_label && (
                        <span className="badge inline-flex items-center gap-1 bg-cs-indigo-faint text-cs-indigo ring-[color-mix(in_srgb,var(--cs-indigo)_25%,var(--cs-panel))]">
                          <FileText className="h-3 w-3" />
                          {event.document_type_label}
                        </span>
                      )}
                      {event.block_reason === 'printer_control' && (
                        <span className="badge inline-flex items-center gap-1 bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] text-cs-crit ring-[color-mix(in_srgb,var(--cs-crit)_25%,var(--cs-panel))]">
                          <Printer className="h-3 w-3" />
                          Printer blocked
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-sm text-cs-ink-2">
                      <span>
                        <span className="text-cs-muted">Agent:</span>{' '}
                        <span className="font-medium text-cs-ink" title={event.agent_id}>
                          {getEventAgentLabel(event)}
                        </span>
                      </span>
                      <span className="text-cs-muted-2">•</span>
                      <span className="font-mono tabular-nums">{formatDate(event.timestamp, 'PPpp')}</span>
                      <span className="text-cs-muted-2">•</span>
                      <code className="text-xs font-mono tabular-nums bg-cs-hair-2 px-1 py-0.5 rounded-cs-sm">
                        {event.id || event.event_id}
                      </code>
                    </div>

                    {/* Event Details */}
                    {event.file_path && (
                      <p className="mt-2 text-sm text-cs-ink-2">
                        <strong>File:</strong>{' '}
                        {(event.source === 'onedrive_cloud' || event.source === 'google_drive_cloud') && event.event_subtype ? (
                          <>
                            <span className="font-medium">{getEventSubtypeLabel(event.event_subtype, event.details?.change_type)}:</span>{' '}
                            {event.file_name || truncate(event.file_path, 60)}
                          </>
                        ) : (
                          truncate(event.file_path, 80)
                        )}
                      </p>
                    )}

                    {Array.isArray(event.matched_policies) &&
                      event.matched_policies.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {event.matched_policies
                            .map((policy: any) => policy?.policy_name)
                            .filter(Boolean)
                            .map((name: string) => (
                              <span
                                key={`${event.id}-policy-${name}`}
                                className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-cs-pill bg-cs-indigo-faint text-cs-indigo ring-1 ring-inset ring-[color-mix(in_srgb,var(--cs-indigo)_25%,var(--cs-panel))]"
                              >
                                {name}
                              </span>
                            ))}
                        </div>
                      )}

                    {(event.manufacturer || event.product_name || event.device_name ||
                      event.serial_number || event.usb?.manufacturer || event.usb?.product_name) && (
                      <p className="mt-2 text-sm text-cs-ink-2">
                        <strong>USB:</strong>{' '}
                        {[event.manufacturer || event.usb?.manufacturer,
                          event.product_name || event.usb?.product_name || event.device_name || event.usb?.device_name]
                          .filter(Boolean).join(' ') || '—'}
                        {(event.serial_number || event.usb?.serial_number) && (
                          <span className="font-mono tabular-nums"> ({event.serial_number || event.usb?.serial_number})</span>
                        )}
                      </p>
                    )}

                    {event.policy && (
                      <p className="mt-2 text-sm text-cs-ink-2">
                        <strong>Policy:</strong> {event.policy.policy_name} (
                        {event.policy.action})
                      </p>
                    )}

                    {event.content_redacted && (
                      <div className="mt-2 p-2 bg-cs-hair-2 rounded-cs-sm text-xs font-mono">
                        {truncate(event.content_redacted, 200)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {!isLoading && !error && total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            itemLabel="events"
            isFetching={isFetching}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
          />
        )}
      </div>

      {/* Event Detail Modal */}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={handleClearLogs}
        title="Delete all events?"
        confirmLabel="Delete all events"
        busy={clearing}
      >
        <p>
          This permanently removes{' '}
          <span className="num font-semibold text-cs-ink">{total.toLocaleString()}</span> event
          {total === 1 ? '' : 's'} from the database, including the evidence behind any incidents
          that reference them.
        </p>
        <p className="mt-2 text-cs-muted">There is no undo.</p>
      </ConfirmDialog>

      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          isBlockedTransfer={isBlockedTransfer(selectedEvent)}
          formatFileSize={formatFileSize}
          getDriveLetter={getDriveLetter}
          agentLabel={getEventAgentLabel(selectedEvent)}
        />
      )}
    </div>
  )
}
