

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'

import { Shield, Clock, User, Loader2, X, AlertTriangle, CheckCircle, Eye, RefreshCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { getAutoIncidents, getAutoIncident, updateAutoIncident } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import Pagination from '@/components/ui/Pagination'
import toast from 'react-hot-toast'
import Dialog from '@/components/ui/Modal'

const severityMap: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: 'Info', color: 'text-cs-muted', bg: 'bg-cs-hair-2 text-cs-ink-2 ring-1 ring-inset ring-cs-muted-2/30' },
  1: { label: 'Low', color: 'text-cs-ok', bg: 'bg-cs-ok/[0.08] text-cs-ok ring-1 ring-inset ring-cs-ok/25' },
  2: { label: 'Medium', color: 'text-cs-med', bg: 'bg-cs-med/[0.09] text-cs-med ring-1 ring-inset ring-cs-med/30' },
  3: { label: 'High', color: 'text-cs-high', bg: 'bg-cs-high/[0.07] text-cs-high ring-1 ring-inset ring-cs-high/25' },
  4: { label: 'Critical', color: 'text-cs-crit', bg: 'bg-cs-crit/[0.07] text-cs-crit ring-1 ring-inset ring-cs-crit/25' },
}

const statusConfig: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  open: { label: 'Open', icon: AlertTriangle, color: 'text-cs-crit', bg: 'bg-cs-crit/[0.07] text-cs-crit ring-1 ring-inset ring-cs-crit/25' },
  investigating: { label: 'Investigating', icon: Eye, color: 'text-cs-med', bg: 'bg-cs-med/[0.09] text-cs-med ring-1 ring-inset ring-cs-med/30' },
  resolved: { label: 'Resolved', icon: CheckCircle, color: 'text-cs-ok', bg: 'bg-cs-ok/[0.08] text-cs-ok ring-1 ring-inset ring-cs-ok/25' },
}

function IncidentCard({ incident, onClick }: { incident: any; onClick: () => void }) {
  const sev = severityMap[incident.severity] || severityMap[2]
  return (
    <div onClick={onClick} className="bg-white rounded-cs-card border border-cs-hair shadow-card p-4 hover:shadow-card-hover hover:border-cs-muted-2 cursor-pointer transition-shadow duration-200 ease-out">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-cs-ink font-semibold text-sm truncate">{incident.title}</h4>
          <p className="text-cs-muted text-xs mt-1 truncate">{incident.description}</p>
        </div>
        <span className={`px-2.5 py-1 rounded-cs-sm text-xs font-semibold uppercase flex-shrink-0 ${sev.bg}`}>{sev.label}</span>
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-cs-muted">
        {incident.user_email && <span className="flex items-center gap-1"><User className="w-3 h-3" />{incident.user_email}</span>}
        {incident.event_count > 1 && (
          <span
            title="Number of events grouped into this incident."
            className="font-mono tabular-nums text-cs-high font-medium"
          >
            {incident.event_count} events
          </span>
        )}
        <span className="ml-auto flex items-center gap-1"><Clock className="w-3 h-3" /><span className="font-mono tabular-nums">{formatDateTimeIST(incident.created_at)}</span></span>
      </div>
    </div>
  )
}

function classificationBadge(level: string): string {
  switch (level) {
    case 'Restricted': return 'bg-cs-crit/[0.07] text-cs-crit ring-cs-crit/25'
    case 'Confidential': return 'bg-cs-high/[0.07] text-cs-high ring-cs-high/25'
    case 'Internal': return 'bg-cs-med/[0.09] text-cs-med ring-cs-med/30'
    default: return 'bg-cs-hair-2 text-cs-ink-2 ring-cs-muted-2/30'
  }
}

// Clipboard/detected content in these events is frequently thousands of
// duplicated lines (e.g. the same IP repeated 80×). Collapse consecutive
// identical lines to "line ×N" and cap the length so the modal stays readable.
function summarizeContent(raw: string, maxChars: number): { text: string; truncated: boolean; empty: boolean } {
  if (!raw || !raw.trim()) return { text: '', truncated: false, empty: true }
  const lines = raw.split(/\r?\n/)
  const collapsed: string[] = []
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    const n = j - i
    collapsed.push(n > 1 ? `${lines[i]}  ×${n}` : lines[i])
    i = j
  }
  let text = collapsed.join('\n')
  const truncated = text.length > maxChars
  if (truncated) text = text.slice(0, maxChars).trimEnd() + ' …'
  return { text, truncated, empty: false }
}

function EventContent({ raw }: { raw: string }) {
  const [expanded, setExpanded] = useState(false)
  const { text, truncated, empty } = useMemo(
    () => summarizeContent(raw, expanded ? 100000 : 800),
    [raw, expanded],
  )
  if (empty) return <p className="text-xs text-cs-muted italic">No content captured for this event.</p>
  return (
    <div>
      <label className="eyebrow block mb-1">Content</label>
      <pre className="text-xs font-mono text-cs-ink-2 bg-white rounded p-2 border border-cs-hair whitespace-pre-wrap max-h-64 overflow-y-auto">{text}</pre>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-cs-muted">Repeated lines collapsed as “×N”.</span>
        {(truncated || expanded) && (
          <button onClick={() => setExpanded(!expanded)} className="text-xs text-primary-600 hover:underline">
            {expanded ? 'Show less' : 'Show full content'}
          </button>
        )}
      </div>
    </div>
  )
}

function RelatedEventCard({ ev }: { ev: any }) {
  const [open, setOpen] = useState(false)
  const isTrigger = !!ev.is_trigger
  const cls = ev.classification_level || ev.classification_category || 'Public'
  const rawContent = ev.detected_content || ev.clipboard_content || ev.content || ''
  return (
    <div className={`rounded-cs-sm border overflow-hidden ${isTrigger ? 'border-cs-crit/30 ring-1 ring-cs-crit/20 bg-cs-crit/[0.05]' : 'border-cs-hair bg-cs-panel'}`}>
      <div onClick={() => setOpen(!open)} className="flex items-center justify-between p-3 cursor-pointer hover:bg-cs-panel-2 transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isTrigger && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-cs-ink text-white flex-shrink-0" title="First event in this incident">First</span>}
            <p className="text-cs-ink text-sm font-medium truncate">{ev.description || ev.event_type}</p>
          </div>
          <p className="text-cs-muted text-xs mt-0.5">
            {ev.event_type}
            {' · '}
            <span className={ev.blocked ? 'text-cs-crit font-medium' : 'text-cs-muted'}>{ev.action_taken || (ev.blocked ? 'blocked' : 'logged')}</span>
            {' · '}
            <span className="font-mono tabular-nums">{formatDateTimeIST(ev.timestamp)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 ml-3 flex-shrink-0">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${classificationBadge(cls)}`}>{cls}</span>
          {open ? <ChevronUp className="w-4 h-4 text-cs-muted" /> : <ChevronDown className="w-4 h-4 text-cs-muted" />}
        </div>
      </div>
      {open && (
        <div className="border-t border-cs-hair p-3 bg-cs-panel-2 space-y-3">
          <EventContent raw={rawContent} />
          {ev.classification_rules_matched && ev.classification_rules_matched.length > 0 && (
            <div>
              <label className="eyebrow block mb-1">Matched Rules</label>
              <div className="flex gap-1.5 flex-wrap">
                {ev.classification_rules_matched.map((r: string, i: number) => (
                  <span key={i} className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-600/20">{r}</span>
                ))}
              </div>
            </div>
          )}
          <details>
            <summary className="text-xs text-cs-muted cursor-pointer hover:text-cs-ink-2">Raw event JSON</summary>
            <pre className="mt-2 text-xs font-mono text-cs-ink-2 bg-white rounded p-2 border border-cs-hair overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">{JSON.stringify(ev, null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  )
}

function IncidentDetail({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const queryClient = useQueryClient()

  const { data: incident, isLoading } = useQuery({
    queryKey: ['auto-incident', incidentId],
    queryFn: () => getAutoIncident(incidentId),
  })

  const statusMutation = useMutation({
    mutationFn: (newStatus: string) => updateAutoIncident(incidentId, { status: newStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auto-incidents'] })
      queryClient.invalidateQueries({ queryKey: ['auto-incident', incidentId] })
      toast.success('Status updated')
    },
    onError: () => toast.error('Failed to update'),
  })

  // While the incident loads, the dialog is already on screen with a spinner in
  // it. It used to be a bare scrim with a spinner floating in the middle and no
  // panel, which read as the console having hung.
  if (isLoading)
    return (
      <Dialog open onClose={onClose} size="2xl" label="Loading incident">
        <div className="flex items-center justify-center gap-3 py-16 text-cs-muted">
          <Loader2 className="h-5 w-5 animate-spin text-cs-indigo" />
          <span className="text-[13px]">Loading incident…</span>
        </div>
      </Dialog>
    )
  if (!incident) return null

  const sev = severityMap[incident.severity] || severityMap[2]
  const relatedEvents: any[] = incident.related_events || []
  // Primary/first event on top, then the rest by recency.
  const orderedEvents = [
    ...relatedEvents.filter((e) => e.is_trigger),
    ...relatedEvents.filter((e) => !e.is_trigger),
  ]
  const eventCount = incident.event_count || relatedEvents.length
  const shownCount = relatedEvents.length

  return (
    <Dialog
      open
      onClose={onClose}
      size="2xl"
      bodyClassName="px-6 py-6 space-y-6"
      header={
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">{incident.title}</h2>
            <div className="flex flex-wrap gap-2 mt-2">
              <span className={`px-3 py-1 rounded-cs-sm text-xs font-semibold uppercase ${sev.bg}`}>{sev.label}</span>
              <span className={`px-3 py-1 rounded-cs-sm text-xs font-semibold uppercase ${(statusConfig[incident.status] || statusConfig.open).bg}`}>{incident.status}</span>
              {incident.classification_level && (
                <span className={`px-3 py-1 rounded-cs-sm text-xs font-semibold uppercase ring-1 ring-inset ${classificationBadge(incident.classification_level)}`}>{incident.classification_level}</span>
              )}
            </div>
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
    >
          {/* Plain-language summary */}
          <div className="bg-cs-panel-2 rounded-cs-sm p-4 border border-cs-hair">
            <p className="text-sm text-cs-ink-2">{incident.description}</p>
            <p className="text-xs text-cs-muted mt-2">
              {eventCount > 1
                ? `This incident groups ${eventCount} related events of the same type from this user.`
                : 'This incident is based on a single event.'}
            </p>
          </div>

          {/* Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'User', value: incident.user_email || 'Unknown', mono: false, hint: '' },
              { label: 'Agent', value: incident.agent_id?.slice(0, 12) || 'N/A', mono: true, hint: incident.agent_id || '' },
              { label: 'Detected', value: formatDateTimeIST(incident.created_at), mono: true, hint: '' },
              { label: 'Events', value: eventCount, mono: true, hint: 'Number of events grouped into this incident.' },
            ].map((item) => (
              <div key={item.label} className="bg-cs-panel-2 rounded-cs-sm p-3 border border-cs-hair" title={item.hint || undefined}>
                <label className="eyebrow block">{item.label}</label>
                <p className={`text-cs-ink text-sm font-medium truncate mt-0.5 ${item.mono ? 'font-mono tabular-nums' : ''}`}>{item.value}</p>
              </div>
            ))}
          </div>

          {/* Status Actions */}
          <div className="bg-cs-panel-2 rounded-cs-sm p-4 border border-cs-hair">
            <label className="eyebrow block mb-3">Update Status</label>
            <div className="flex gap-2">
              {['open', 'investigating', 'resolved'].map((s) => {
                const cfg = statusConfig[s]
                return (
                  <button key={s} onClick={() => statusMutation.mutate(s)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-cs-sm text-sm font-medium transition-colors duration-150 ${
                      incident.status === s ? cfg.bg : 'bg-white border border-cs-hair text-cs-muted hover:text-cs-ink-2 hover:border-cs-muted-2'
                    }`}>
                    <cfg.icon className="w-4 h-4" />{cfg.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Events in this incident */}
          <div>
            <label className="eyebrow block mb-2">
              Events in this incident (<span className="font-mono tabular-nums">{eventCount}</span>)
            </label>
            {orderedEvents.length === 0 ? (
              <p className="text-sm text-cs-muted italic">The events for this incident are no longer available.</p>
            ) : (
              <div className="space-y-2">
                {orderedEvents.map((ev, idx) => <RelatedEventCard key={ev.id || idx} ev={ev} />)}
                {eventCount > shownCount && (
                  <p className="text-xs text-cs-muted pt-1">Showing the {shownCount} most recent of {eventCount} events.</p>
                )}
              </div>
            )}
          </div>

          {/* Raw Incident JSON */}
          <details className="bg-cs-panel-2 rounded-cs-sm border border-cs-hair overflow-hidden">
            <summary className="px-4 py-3 text-sm font-medium text-cs-ink-2 cursor-pointer hover:bg-cs-hair-2">View raw incident data</summary>
            <pre className="px-4 pb-4 text-xs font-mono text-cs-ink-2 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">{JSON.stringify(incident, null, 2)}</pre>
          </details>
    </Dialog>
  )
}

const COL_SIZE = 12

const COLUMN_META: Record<'open' | 'investigating' | 'resolved', {
  title: string; Icon: any; head: string; icon: string; empty: string
}> = {
  open:          { title: 'Open',          Icon: AlertTriangle, head: 'text-cs-crit',   icon: 'text-cs-crit',   empty: 'No open incidents' },
  investigating: { title: 'Investigating', Icon: Eye,           head: 'text-cs-med', icon: 'text-cs-med', empty: 'No active investigations' },
  resolved:      { title: 'Resolved',      Icon: CheckCircle,   head: 'text-cs-ok', icon: 'text-cs-ok', empty: 'No resolved incidents' },
}

// One kanban column, fetched and paginated INDEPENDENTLY by status. The old
// page fetched the 200 newest incidents and split them client-side, so when
// thousands were Open the Investigating/Resolved columns rendered empty even
// though those incidents existed — and "Open (200)" was a truncated slice, not
// the real count. Each column now queries its own status and shows the true
// stat count in the header.
function IncidentColumn({ statusKey, count, incidents, page, onPageChange, isFetching, onSelect }: {
  statusKey: 'open' | 'investigating' | 'resolved'
  count: number
  incidents: any[]
  page: number
  onPageChange: (p: number) => void
  isFetching: boolean
  onSelect: (id: string) => void
}) {
  const meta = COLUMN_META[statusKey]
  const Icon = meta.Icon
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`w-4 h-4 ${meta.icon}`} />
        <h2 className={`text-sm font-semibold ${meta.head} uppercase tracking-wider`}>
          {meta.title} (<span className="font-mono tabular-nums">{count}</span>)
        </h2>
      </div>
      <div className="space-y-3">
        {incidents.length === 0 ? (
          <div className="bg-cs-panel-2 rounded-cs-card border border-cs-hair p-6 text-center"><p className="text-cs-muted text-sm">{meta.empty}</p></div>
        ) : incidents.map((inc: any) => (
          <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => onSelect(inc.id || inc.event_id)} />
        ))}
      </div>
      {count > COL_SIZE && (
        <Pagination
          page={page}
          pageSize={COL_SIZE}
          total={count}
          itemLabel="incidents"
          isFetching={isFetching}
          onPageChange={onPageChange}
          className="border-t-0 px-0 py-3 mt-1 justify-center"
        />
      )}
    </div>
  )
}

export default function IncidentsPage() {
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null)
  const [openPage, setOpenPage] = useState(1)
  const [investigatingPage, setInvestigatingPage] = useState(1)
  const [resolvedPage, setResolvedPage] = useState(1)

  const openQ = useQuery({
    queryKey: ['auto-incidents', 'open', openPage],
    queryFn: () => getAutoIncidents({ status: 'open', limit: COL_SIZE, skip: (openPage - 1) * COL_SIZE }),
    staleTime: 0, refetchInterval: 15000, retry: false, placeholderData: keepPreviousData,
  })
  const invQ = useQuery({
    queryKey: ['auto-incidents', 'investigating', investigatingPage],
    queryFn: () => getAutoIncidents({ status: 'investigating', limit: COL_SIZE, skip: (investigatingPage - 1) * COL_SIZE }),
    staleTime: 0, refetchInterval: 15000, retry: false, placeholderData: keepPreviousData,
  })
  const resQ = useQuery({
    queryKey: ['auto-incidents', 'resolved', resolvedPage],
    queryFn: () => getAutoIncidents({ status: 'resolved', limit: COL_SIZE, skip: (resolvedPage - 1) * COL_SIZE }),
    staleTime: 0, refetchInterval: 15000, retry: false, placeholderData: keepPreviousData,
  })

  // The endpoint returns the same status-independent counts on every call, so
  // the header stats stay correct no matter which column drove the request.
  const stats = openQ.data?.stats || invQ.data?.stats || resQ.data?.stats
    || { total: 0, open: 0, investigating: 0, resolved: 0 }

  const openIncidents = openQ.data?.incidents || []
  const investigatingIncidents = invQ.data?.incidents || []
  const resolvedIncidents = resQ.data?.incidents || []

  const isLoading = openQ.isLoading && invQ.isLoading && resQ.isLoading

  // Keep each column's page in range when its total shrinks (a status change or
  // refresh can move the last card off the final page).
  useEffect(() => {
    const mp = Math.max(1, Math.ceil(stats.open / COL_SIZE))
    if (openPage > mp) setOpenPage(mp)
  }, [stats.open, openPage])
  useEffect(() => {
    const mp = Math.max(1, Math.ceil(stats.investigating / COL_SIZE))
    if (investigatingPage > mp) setInvestigatingPage(mp)
  }, [stats.investigating, investigatingPage])
  useEffect(() => {
    const mp = Math.max(1, Math.ceil(stats.resolved / COL_SIZE))
    if (resolvedPage > mp) setResolvedPage(mp)
  }, [stats.resolved, resolvedPage])

  const refetchAll = () => { openQ.refetch(); invQ.refetch(); resQ.refetch() }

  return (
    <>
      <div className="space-y-6 p-6 bg-white min-h-screen">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow mb-1.5">Security Operations</p>
            <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Incidents</h1>
            <p className="text-cs-muted text-sm mt-1">Auto-generated from blocked and critical DLP events</p>
          </div>
          <button onClick={refetchAll} className="btn-secondary">
            <RefreshCcw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-cs-ink' },
            { label: 'Open', value: stats.open, color: 'text-cs-crit' },
            { label: 'Investigating', value: stats.investigating, color: 'text-cs-med' },
            { label: 'Resolved', value: stats.resolved, color: 'text-cs-ok' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-cs-card p-4 border border-cs-hair shadow-card">
              <p className="eyebrow">{s.label}</p>
              <p className={`font-mono text-2xl font-semibold tabular-nums mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div>
        ) : stats.total === 0 ? (
          <div className="bg-cs-panel-2 border border-cs-hair rounded-cs-card p-12 text-center">
            <Shield className="w-12 h-12 text-cs-muted-2 mx-auto mb-3" />
            <p className="text-cs-muted">No incidents. Blocked or critical events will auto-generate incidents.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <IncidentColumn
              statusKey="open" count={stats.open} incidents={openIncidents}
              page={openPage} onPageChange={setOpenPage} isFetching={openQ.isFetching}
              onSelect={setSelectedIncident}
            />
            <IncidentColumn
              statusKey="investigating" count={stats.investigating} incidents={investigatingIncidents}
              page={investigatingPage} onPageChange={setInvestigatingPage} isFetching={invQ.isFetching}
              onSelect={setSelectedIncident}
            />
            <IncidentColumn
              statusKey="resolved" count={stats.resolved} incidents={resolvedIncidents}
              page={resolvedPage} onPageChange={setResolvedPage} isFetching={resQ.isFetching}
              onSelect={setSelectedIncident}
            />
          </div>
        )}

        {selectedIncident && <IncidentDetail incidentId={selectedIncident} onClose={() => setSelectedIncident(null)} />}
      </div>
    </>
  )
}
