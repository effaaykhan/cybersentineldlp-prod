

import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Search, Loader2, X, Download, RefreshCcw, ChevronDown, ChevronUp, Filter, FileText } from 'lucide-react'
import { getEvents as fetchEvents } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import Pagination from '@/components/ui/Pagination'
import toast from 'react-hot-toast'

const TIME_PRESETS = [
  { label: '5m', value: 5 }, { label: '10m', value: 10 }, { label: '15m', value: 15 },
  { label: '30m', value: 30 }, { label: '1h', value: 60 }, { label: '24h', value: 1440 },
  { label: '7d', value: 10080 }, { label: '30d', value: 43200 }, { label: '90d', value: 129600 },
]

const classificationColors: Record<string, string> = {
  Restricted: 'bg-cs-crit/[0.07] text-cs-crit ring-1 ring-inset ring-cs-crit/25',
  Confidential: 'bg-cs-high/[0.07] text-cs-high ring-1 ring-inset ring-cs-high/25',
  Internal: 'bg-cs-med/[0.09] text-cs-med ring-1 ring-inset ring-cs-med/30',
  Public: 'bg-cs-panel-2 text-cs-ink-2 ring-1 ring-inset ring-cs-muted-2/30',
}
const severityColors: Record<string, string> = {
  critical: 'bg-cs-crit/[0.07] text-cs-crit ring-1 ring-inset ring-cs-crit/25',
  high: 'bg-cs-high/[0.07] text-cs-high ring-1 ring-inset ring-cs-high/25',
  medium: 'bg-cs-med/[0.09] text-cs-med ring-1 ring-inset ring-cs-med/30',
  low: 'bg-cs-ok/[0.08] text-cs-ok ring-1 ring-inset ring-cs-ok/25',
}

export default function LogExplorerPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [eventType, setEventType] = useState('all')
  const [severity, setSeverity] = useState('all')
  const [classification, setClassification] = useState('all')
  const [timePreset, setTimePreset] = useState<number | null>(null)
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [limit, setLimit] = useState(1000)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['log-explorer', eventType, severity, limit],
    queryFn: () => fetchEvents({ limit, event_type: eventType !== 'all' ? eventType : undefined, severity: severity !== 'all' ? severity : undefined }),
    staleTime: 0, retry: false,
  })

  const rawEvents = data?.events || (Array.isArray(data) ? data : [])

  const events = useMemo(() => rawEvents.filter((e: any) => {
    if (classification !== 'all') { const cat = (e.classification_category || e.classification_level || 'Public'); if (cat.toLowerCase() !== classification.toLowerCase()) return false }
    if (timePreset) { if (new Date(e.timestamp).getTime() < Date.now() - timePreset * 60000) return false }
    if (startTime && new Date(e.timestamp).getTime() < new Date(startTime).getTime()) return false
    if (endTime && new Date(e.timestamp).getTime() > new Date(endTime).getTime()) return false
    if (agentFilter && !(e.agent_id || '').toLowerCase().includes(agentFilter.toLowerCase())) return false
    if (userFilter && !(e.user_email || '').toLowerCase().includes(userFilter.toLowerCase())) return false
    if (searchQuery) { const q = searchQuery.toLowerCase(); const fields = [e.description, e.event_type, e.agent_id, e.user_email, e.file_path, e.detected_content, ...(e.classification_rules_matched || [])].filter(Boolean).join(' ').toLowerCase(); if (!fields.includes(q)) return false }
    return true
  }), [rawEvents, classification, timePreset, startTime, endTime, agentFilter, userFilter, searchQuery])

  const stats = useMemo(() => ({
    total: events.length,
    clipboard: events.filter((e: any) => e.event_type === 'clipboard').length,
    usb: events.filter((e: any) => e.event_type === 'usb').length,
    blocked: events.filter((e: any) => e.blocked || e.action_taken === 'block').length,
  }), [events])

  // Any filter change collapses back to page 1 (stats/export still cover the
  // whole filtered set; only the rendered rows are paginated).
  useEffect(() => {
    setPage(1)
  }, [searchQuery, eventType, severity, classification, timePreset, startTime, endTime, agentFilter, userFilter])

  const pagedEvents = events.slice((page - 1) * pageSize, page * pageSize)

  const exportCSV = () => {
    const rows = [['Timestamp','Type','Severity','Classification','Action','Blocked','Rules','Description','Agent','User'].join(','),
      ...events.map((e: any) => [e.timestamp, e.event_type, e.severity, e.classification_category || e.classification_level || 'Public', e.action_taken || 'logged', e.blocked ? 'Yes' : 'No', (e.classification_rules_matched || []).join('; '), `"${(e.description || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`, e.agent_id, e.user_email].join(','))]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dlp-logs-${new Date().toISOString().slice(0,10)}.csv`; a.click()
    toast.success(`Exported ${events.length} events`)
  }
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dlp-logs-${new Date().toISOString().slice(0,10)}.json`; a.click()
    toast.success(`Exported ${events.length} events`)
  }

  const clearFilters = () => { setSearchQuery(''); setEventType('all'); setSeverity('all'); setClassification('all'); setTimePreset(null); setStartTime(''); setEndTime(''); setAgentFilter(''); setUserFilter('') }
  const hasFilters = searchQuery || eventType !== 'all' || severity !== 'all' || classification !== 'all' || timePreset || startTime || endTime || agentFilter || userFilter

  return (
    <>
      <div className="space-y-6 p-6 bg-cs-panel-2 min-h-screen">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow mb-1.5">Investigate</p>
            <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Log Explorer</h1>
            <p className="text-cs-muted text-sm mt-1">Search, filter, and investigate DLP events</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => refetch()} className="btn-secondary flex items-center gap-2"><RefreshCcw className="w-4 h-4" /> Refresh</button>
            <button onClick={exportCSV} className="btn-secondary flex items-center gap-2"><Download className="w-4 h-4" /> CSV</button>
            <button onClick={exportJSON} className="btn-secondary flex items-center gap-2"><FileText className="w-4 h-4" /> JSON</button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Results', value: stats.total, color: 'text-cs-ink' },
            { label: 'Clipboard', value: stats.clipboard, color: 'text-primary-600' },
            { label: 'USB', value: stats.usb, color: 'text-cs-ink' },
            { label: 'Blocked', value: stats.blocked, color: 'text-cs-crit' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-cs-card p-4 border border-cs-hair shadow-card">
              <p className="eyebrow">{s.label}</p>
              <p className={`font-mono text-2xl font-semibold tabular-nums mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Search + Filters */}
        <div className="bg-white rounded-cs-card border border-cs-hair shadow-card overflow-hidden">
          <div className="p-4 border-b border-cs-hair-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cs-muted z-10" />
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by description, agent, user, file path, classification rules..."
                className="input w-full pl-10 pr-20" />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                {hasFilters && <button onClick={clearFilters} className="px-2 py-1 text-xs text-cs-muted hover:text-cs-ink-2">Clear</button>}
                <button onClick={() => setShowFilters(!showFilters)} className={`p-1.5 rounded-cs-sm ${showFilters ? 'text-primary-600 bg-primary-50' : 'text-cs-muted hover:bg-cs-hair-2'}`}><Filter className="w-4 h-4" /></button>
              </div>
            </div>
          </div>

          {showFilters && (
            <div className="p-4 space-y-4 border-b border-cs-hair-2 bg-cs-panel-2">
              <div>
                <label className="eyebrow block mb-2">Time Range</label>
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={() => setTimePreset(null)} className={`px-3 py-1.5 rounded-cs-sm text-xs font-medium border ${!timePreset ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-cs-ink-2 border-cs-hair hover:border-cs-muted-2'}`}>All Time</button>
                  {TIME_PRESETS.map((p) => (
                    <button key={p.value} onClick={() => { setTimePreset(p.value); setStartTime(''); setEndTime('') }}
                      className={`px-3 py-1.5 rounded-cs-sm text-xs font-medium border ${timePreset === p.value ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-cs-ink-2 border-cs-hair hover:border-cs-muted-2'}`}>{p.label}</button>
                  ))}
                </div>
                <div className="flex gap-3 mt-2">
                  <div className="flex-1"><label className="text-xs text-cs-muted block mb-1">Start</label><input type="datetime-local" value={startTime} onChange={(e) => { setStartTime(e.target.value); setTimePreset(null) }} className="input w-full py-1.5" /></div>
                  <div className="flex-1"><label className="text-xs text-cs-muted block mb-1">End</label><input type="datetime-local" value={endTime} onChange={(e) => { setEndTime(e.target.value); setTimePreset(null) }} className="input w-full py-1.5" /></div>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div><label className="text-xs text-cs-muted block mb-1">Event Type</label><select value={eventType} onChange={(e) => setEventType(e.target.value)} className="input w-full"><option value="all">All</option><option value="clipboard">Clipboard</option><option value="usb">USB</option><option value="file">File</option></select></div>
                <div><label className="text-xs text-cs-muted block mb-1">Severity</label><select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input w-full"><option value="all">All</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
                <div><label className="text-xs text-cs-muted block mb-1">Classification</label><select value={classification} onChange={(e) => setClassification(e.target.value)} className="input w-full"><option value="all">All</option><option value="Restricted">Restricted</option><option value="Confidential">Confidential</option><option value="Internal">Internal</option><option value="Public">Public</option></select></div>
                <div><label className="text-xs text-cs-muted block mb-1">Agent</label><input value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} placeholder="Agent ID..." className="input w-full font-mono" /></div>
                <div><label className="text-xs text-cs-muted block mb-1">User</label><input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="Email..." className="input w-full font-mono" /></div>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div>
        ) : error ? (
          <div className="bg-cs-crit/[0.07] border border-cs-crit/25 rounded-cs-card p-6 text-center"><p className="text-cs-crit">Failed to load events</p></div>
        ) : events.length === 0 ? (
          <div className="bg-white border border-cs-hair shadow-card rounded-cs-card p-12 text-center"><Search className="w-12 h-12 text-cs-muted-2 mx-auto mb-3" /><p className="text-cs-muted">No events match your filters</p></div>
        ) : (
          <div className="bg-white rounded-cs-card border border-cs-hair shadow-card overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-cs-hair text-[11px] text-cs-muted uppercase tracking-wider font-semibold bg-cs-panel-2">
              <div className="col-span-1">Type</div><div className="col-span-3">Description</div><div className="col-span-2">Classification</div><div className="col-span-1">Severity</div><div className="col-span-1">Action</div><div className="col-span-2">User</div><div className="col-span-2">Time</div>
            </div>
            <div className="divide-y divide-cs-hair-2">
              {pagedEvents.map((event: any, idx: number) => {
                const isExpanded = expandedEvent === (event.id || idx.toString())
                const category = event.classification_category || event.classification_level || 'Public'
                return (
                  <div key={event.id || idx}>
                    <div onClick={() => setExpandedEvent(isExpanded ? null : (event.id || idx.toString()))} className="grid grid-cols-12 gap-2 px-4 py-3 hover:bg-cs-panel-2 cursor-pointer transition-colors items-center text-sm">
                      <div className="col-span-1"><span className="text-xs font-mono text-cs-ink-2 capitalize">{event.event_type}</span></div>
                      <div className="col-span-3 truncate text-cs-ink font-medium">{event.description || `${event.event_type} event`}</div>
                      <div className="col-span-2"><span className={`px-2 py-0.5 rounded-cs-sm text-xs font-medium ${classificationColors[category] || classificationColors.Public}`}>{category}</span></div>
                      <div className="col-span-1"><span className={`px-2 py-0.5 rounded-cs-sm text-xs font-medium ${severityColors[event.severity] || severityColors.low}`}>{event.severity}</span></div>
                      <div className="col-span-1"><span className={`text-xs font-medium ${event.blocked ? 'text-cs-crit' : 'text-cs-muted'}`}>{event.action_taken || 'logged'}</span></div>
                      <div className="col-span-2 truncate text-cs-muted text-xs font-mono">{event.user_email || '-'}</div>
                      <div className="col-span-2 flex items-center justify-between">
                        <span className="text-cs-muted text-xs font-mono tabular-nums">{formatDateTimeIST(event.timestamp)}</span>
                        {isExpanded ? <ChevronUp className="w-3 h-3 text-cs-muted" /> : <ChevronDown className="w-3 h-3 text-cs-muted" />}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 bg-cs-panel-2 space-y-3 border-t border-cs-hair-2">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3">
                          <div><label className="eyebrow">Event Type</label><p className="text-cs-ink text-sm capitalize">{event.event_subtype || event.event_type}</p></div>
                          <div><label className="eyebrow">Action</label><p className="text-cs-ink text-sm">{event.action_taken || 'logged'}</p></div>
                          <div><label className="eyebrow">Confidence</label><p className="text-cs-ink text-sm font-mono font-semibold tabular-nums">{((event.classification_score || 0) * 100).toFixed(0)}%</p></div>
                          <div><label className="eyebrow">Agent</label><p className="text-cs-ink text-xs font-mono">{event.agent_id}</p></div>
                        </div>
                        {event.classification_rules_matched && event.classification_rules_matched.length > 0 && (
                          <div><label className="eyebrow">Matched Rules</label><div className="flex gap-1.5 mt-1 flex-wrap">{event.classification_rules_matched.map((r: string, i: number) => (<span key={i} className="px-2 py-0.5 rounded-cs-sm text-xs font-medium bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-600/20">{r}</span>))}</div></div>
                        )}
                        {event.detected_content && (
                          <div><label className="eyebrow">Detected Content</label><pre className="mt-1 text-xs font-mono text-cs-ink-2 bg-white rounded-cs-sm p-3 border border-cs-hair whitespace-pre-wrap">{event.detected_content}</pre></div>
                        )}
                        <details><summary className="eyebrow cursor-pointer hover:text-cs-ink-2">Raw JSON</summary><pre className="mt-2 text-xs font-mono text-cs-ink-2 bg-white rounded-cs-sm p-3 overflow-x-auto border border-cs-hair whitespace-pre-wrap">{JSON.stringify(event, null, 2)}</pre></details>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={events.length}
              itemLabel="events"
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
            />
          </div>
        )}
      </div>
    </>
  )
}
