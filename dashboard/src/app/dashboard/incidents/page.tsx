

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'

import { Shield, Clock, User, Loader2, X, AlertTriangle, CheckCircle, Eye, RefreshCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { getAutoIncidents, getAutoIncident, updateAutoIncident } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import Pagination from '@/components/ui/Pagination'
import toast from 'react-hot-toast'

const severityMap: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: 'Info', color: 'text-slate-500', bg: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/20' },
  1: { label: 'Low', color: 'text-green-700', bg: 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20' },
  2: { label: 'Medium', color: 'text-amber-700', bg: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20' },
  3: { label: 'High', color: 'text-orange-700', bg: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20' },
  4: { label: 'Critical', color: 'text-red-700', bg: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20' },
}

const statusConfig: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  open: { label: 'Open', icon: AlertTriangle, color: 'text-red-700', bg: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20' },
  investigating: { label: 'Investigating', icon: Eye, color: 'text-amber-700', bg: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20' },
  resolved: { label: 'Resolved', icon: CheckCircle, color: 'text-green-700', bg: 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20' },
}

function IncidentCard({ incident, onClick }: { incident: any; onClick: () => void }) {
  const sev = severityMap[incident.severity] || severityMap[2]
  return (
    <div onClick={onClick} className="bg-white rounded-xl border border-slate-200 shadow-card p-4 hover:shadow-card-hover hover:border-slate-300 cursor-pointer transition-shadow duration-200 ease-out">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-slate-900 font-semibold text-sm truncate">{incident.title}</h4>
          <p className="text-slate-500 text-xs mt-1 truncate">{incident.description}</p>
        </div>
        <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase flex-shrink-0 ${sev.bg}`}>{sev.label}</span>
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
        {incident.user_email && <span className="flex items-center gap-1"><User className="w-3 h-3" />{incident.user_email}</span>}
        {incident.event_count > 1 && (
          <span
            title="Number of events grouped into this incident."
            className="font-mono tabular-nums text-orange-600 font-medium"
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
    case 'Restricted': return 'bg-red-50 text-red-700 ring-red-600/20'
    case 'Confidential': return 'bg-orange-50 text-orange-700 ring-orange-600/20'
    case 'Internal': return 'bg-amber-50 text-amber-700 ring-amber-600/20'
    default: return 'bg-slate-100 text-slate-600 ring-slate-400/20'
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
  if (empty) return <p className="text-xs text-slate-400 italic">No content captured for this event.</p>
  return (
    <div>
      <label className="eyebrow block mb-1">Content</label>
      <pre className="text-xs font-mono text-slate-700 bg-white rounded p-2 border border-slate-200 whitespace-pre-wrap max-h-64 overflow-y-auto">{text}</pre>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-slate-400">Repeated lines collapsed as “×N”.</span>
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
    <div className={`rounded-lg border overflow-hidden ${isTrigger ? 'border-red-300 ring-1 ring-red-200 bg-red-50/40' : 'border-slate-200 bg-white'}`}>
      <div onClick={() => setOpen(!open)} className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-50 transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isTrigger && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-700 text-white flex-shrink-0" title="First event in this incident">First</span>}
            <p className="text-slate-900 text-sm font-medium truncate">{ev.description || ev.event_type}</p>
          </div>
          <p className="text-slate-500 text-xs mt-0.5">
            {ev.event_type}
            {' · '}
            <span className={ev.blocked ? 'text-red-600 font-medium' : 'text-slate-500'}>{ev.action_taken || (ev.blocked ? 'blocked' : 'logged')}</span>
            {' · '}
            <span className="font-mono tabular-nums">{formatDateTimeIST(ev.timestamp)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 ml-3 flex-shrink-0">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${classificationBadge(cls)}`}>{cls}</span>
          {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </div>
      {open && (
        <div className="border-t border-slate-200 p-3 bg-slate-50 space-y-3">
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
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">Raw event JSON</summary>
            <pre className="mt-2 text-xs font-mono text-slate-600 bg-white rounded p-2 border border-slate-200 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">{JSON.stringify(ev, null, 2)}</pre>
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

  if (isLoading) return <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div>
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
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-4xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">{incident.title}</h2>
            <div className="flex gap-2 mt-2">
              <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ${sev.bg}`}>{sev.label}</span>
              <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ${(statusConfig[incident.status] || statusConfig.open).bg}`}>{incident.status}</span>
              {incident.classification_level && (
                <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ring-1 ring-inset ${classificationBadge(incident.classification_level)}`}>{incident.classification_level}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-500" /></button>
        </div>

        <div className="p-6 space-y-6">
          {/* Plain-language summary */}
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <p className="text-sm text-slate-700">{incident.description}</p>
            <p className="text-xs text-slate-500 mt-2">
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
              <div key={item.label} className="bg-slate-50 rounded-lg p-3 border border-slate-200" title={item.hint || undefined}>
                <label className="eyebrow block">{item.label}</label>
                <p className={`text-slate-900 text-sm font-medium truncate mt-0.5 ${item.mono ? 'font-mono tabular-nums' : ''}`}>{item.value}</p>
              </div>
            ))}
          </div>

          {/* Status Actions */}
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <label className="eyebrow block mb-3">Update Status</label>
            <div className="flex gap-2">
              {['open', 'investigating', 'resolved'].map((s) => {
                const cfg = statusConfig[s]
                return (
                  <button key={s} onClick={() => statusMutation.mutate(s)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-150 ${
                      incident.status === s ? cfg.bg : 'bg-white border border-slate-300 text-slate-500 hover:text-slate-700 hover:border-slate-400'
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
              <p className="text-sm text-slate-400 italic">The events for this incident are no longer available.</p>
            ) : (
              <div className="space-y-2">
                {orderedEvents.map((ev, idx) => <RelatedEventCard key={ev.id || idx} ev={ev} />)}
                {eventCount > shownCount && (
                  <p className="text-xs text-slate-400 pt-1">Showing the {shownCount} most recent of {eventCount} events.</p>
                )}
              </div>
            )}
          </div>

          {/* Raw Incident JSON */}
          <details className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
            <summary className="px-4 py-3 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-100">View raw incident data</summary>
            <pre className="px-4 pb-4 text-xs font-mono text-slate-600 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">{JSON.stringify(incident, null, 2)}</pre>
          </details>
        </div>
      </div>
    </div>
  )
}

const COL_SIZE = 12

const COLUMN_META: Record<'open' | 'investigating' | 'resolved', {
  title: string; Icon: any; head: string; icon: string; empty: string
}> = {
  open:          { title: 'Open',          Icon: AlertTriangle, head: 'text-red-700',   icon: 'text-red-600',   empty: 'No open incidents' },
  investigating: { title: 'Investigating', Icon: Eye,           head: 'text-amber-700', icon: 'text-amber-600', empty: 'No active investigations' },
  resolved:      { title: 'Resolved',      Icon: CheckCircle,   head: 'text-green-700', icon: 'text-green-600', empty: 'No resolved incidents' },
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
          <div className="bg-slate-50 rounded-xl border border-slate-200 p-6 text-center"><p className="text-slate-400 text-sm">{meta.empty}</p></div>
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
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Incidents</h1>
            <p className="text-slate-500 text-sm mt-1">Auto-generated from blocked and critical DLP events</p>
          </div>
          <button onClick={refetchAll} className="btn-secondary">
            <RefreshCcw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-slate-900' },
            { label: 'Open', value: stats.open, color: 'text-red-700' },
            { label: 'Investigating', value: stats.investigating, color: 'text-amber-700' },
            { label: 'Resolved', value: stats.resolved, color: 'text-green-700' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 border border-slate-200 shadow-card">
              <p className="eyebrow">{s.label}</p>
              <p className={`font-mono text-2xl font-semibold tabular-nums mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div>
        ) : stats.total === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-12 text-center">
            <Shield className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">No incidents. Blocked or critical events will auto-generate incidents.</p>
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
