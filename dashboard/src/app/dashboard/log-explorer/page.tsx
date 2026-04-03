'use client'

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { Search, Loader2, X, Download, RefreshCcw, Clock, AlertTriangle, Clipboard, Usb, File, ChevronDown, ChevronUp, Filter, FileText } from 'lucide-react'
import { getEvents as fetchEvents } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import toast from 'react-hot-toast'

const TIME_PRESETS = [
  { label: '5m', value: 5 },
  { label: '10m', value: 10 },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 },
  { label: '30d', value: 43200 },
  { label: '90d', value: 129600 },
]

const classificationColors: Record<string, string> = {
  Restricted: 'bg-red-900/30 border-red-500/50 text-red-400',
  Confidential: 'bg-orange-900/30 border-orange-500/50 text-orange-400',
  Internal: 'bg-yellow-900/30 border-yellow-500/50 text-yellow-400',
  Public: 'bg-gray-900/30 border-gray-600 text-gray-400',
}

const severityColors: Record<string, string> = {
  critical: 'bg-red-900/30 border-red-500/50 text-red-400',
  high: 'bg-orange-900/30 border-orange-500/50 text-orange-400',
  medium: 'bg-yellow-900/30 border-yellow-500/50 text-yellow-400',
  low: 'bg-green-900/30 border-green-500/50 text-green-400',
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
  const [limit, setLimit] = useState(100)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(true)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['log-explorer', eventType, severity, limit],
    queryFn: () => fetchEvents({
      limit,
      event_type: eventType !== 'all' ? eventType : undefined,
      severity: severity !== 'all' ? severity : undefined,
    }),
    staleTime: 0,
    retry: false,
  })

  const rawEvents = data?.events || (Array.isArray(data) ? data : [])

  // Client-side filtering
  const events = useMemo(() => {
    return rawEvents.filter((e: any) => {
      // Classification filter
      if (classification !== 'all') {
        const cat = (e.classification_category || e.classification_level || 'Public')
        if (cat.toLowerCase() !== classification.toLowerCase()) return false
      }
      // Time preset filter
      if (timePreset) {
        const eventTime = new Date(e.timestamp).getTime()
        const cutoff = Date.now() - timePreset * 60 * 1000
        if (eventTime < cutoff) return false
      }
      // Custom time range
      if (startTime) {
        const eventTime = new Date(e.timestamp).getTime()
        if (eventTime < new Date(startTime).getTime()) return false
      }
      if (endTime) {
        const eventTime = new Date(e.timestamp).getTime()
        if (eventTime > new Date(endTime).getTime()) return false
      }
      // Agent filter
      if (agentFilter && !(e.agent_id || '').toLowerCase().includes(agentFilter.toLowerCase())) return false
      // User filter
      if (userFilter && !(e.user_email || '').toLowerCase().includes(userFilter.toLowerCase())) return false
      // Search
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const fields = [
          e.description, e.event_type, e.event_subtype, e.agent_id, e.user_email,
          e.file_path, e.detected_content, e.classification_level, e.action_taken,
          ...(e.classification_rules_matched || []),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!fields.includes(q)) return false
      }
      return true
    })
  }, [rawEvents, classification, timePreset, startTime, endTime, agentFilter, userFilter, searchQuery])

  const stats = useMemo(() => ({
    total: events.length,
    clipboard: events.filter((e: any) => e.event_type === 'clipboard').length,
    usb: events.filter((e: any) => e.event_type === 'usb').length,
    file: events.filter((e: any) => e.event_type === 'file').length,
    blocked: events.filter((e: any) => e.blocked || e.action_taken === 'block').length,
  }), [events])

  // Export
  const exportCSV = () => {
    const headers = ['Timestamp', 'Event Type', 'Severity', 'Classification', 'Action', 'Blocked', 'Rules Matched', 'Description', 'Agent', 'User']
    const rows = events.map((e: any) => [
      e.timestamp, e.event_type, e.severity,
      e.classification_category || e.classification_level || 'Public',
      e.action_taken || 'logged', e.blocked ? 'Yes' : 'No',
      (e.classification_rules_matched || []).join('; '),
      `"${(e.description || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
      e.agent_id, e.user_email,
    ])
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `dlp-logs-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${events.length} events to CSV`)
  }

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `dlp-logs-${new Date().toISOString().slice(0, 10)}.json`; a.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${events.length} events to JSON`)
  }

  const clearFilters = () => {
    setSearchQuery(''); setEventType('all'); setSeverity('all'); setClassification('all')
    setTimePreset(null); setStartTime(''); setEndTime(''); setAgentFilter(''); setUserFilter('')
  }

  const hasFilters = searchQuery || eventType !== 'all' || severity !== 'all' || classification !== 'all' || timePreset || startTime || endTime || agentFilter || userFilter

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Log Explorer</h1>
            <p className="text-gray-400 text-sm mt-1">Search, filter, and investigate DLP events</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 bg-gray-900 text-gray-400 rounded-lg border border-gray-800 hover:text-white text-sm">
              <RefreshCcw className="w-4 h-4" /> Refresh
            </button>
            <button onClick={exportCSV} className="flex items-center gap-2 px-3 py-2 bg-gray-900 text-gray-400 rounded-lg border border-gray-800 hover:text-white text-sm">
              <Download className="w-4 h-4" /> CSV
            </button>
            <button onClick={exportJSON} className="flex items-center gap-2 px-3 py-2 bg-gray-900 text-gray-400 rounded-lg border border-gray-800 hover:text-white text-sm">
              <FileText className="w-4 h-4" /> JSON
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: 'Results', value: stats.total, color: 'text-white' },
            { label: 'Clipboard', value: stats.clipboard, color: 'text-purple-400' },
            { label: 'USB', value: stats.usb, color: 'text-blue-400' },
            { label: 'File', value: stats.file, color: 'text-yellow-400' },
            { label: 'Blocked', value: stats.blocked, color: 'text-red-400' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <p className="text-gray-500 text-xs uppercase">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Search + Filters */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {/* Search bar */}
          <div className="p-4 border-b border-gray-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by description, agent, user, file path, classification rules..."
                className="w-full pl-10 pr-20 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                {hasFilters && (
                  <button onClick={clearFilters} className="px-2 py-1 text-xs text-gray-500 hover:text-white">Clear</button>
                )}
                <button onClick={() => setShowFilters(!showFilters)} className={`p-1.5 rounded ${showFilters ? 'text-purple-400' : 'text-gray-500'}`}>
                  <Filter className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Time Range */}
          {showFilters && (
            <div className="p-4 space-y-4 border-b border-gray-800">
              {/* Time presets */}
              <div>
                <label className="text-xs text-gray-500 uppercase block mb-2">Time Range</label>
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={() => setTimePreset(null)} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${!timePreset ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-white'}`}>All Time</button>
                  {TIME_PRESETS.map((p) => (
                    <button key={p.value} onClick={() => { setTimePreset(p.value); setStartTime(''); setEndTime('') }} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${timePreset === p.value ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-white'}`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {/* Custom range */}
                <div className="flex gap-3 mt-2">
                  <div className="flex-1">
                    <label className="text-xs text-gray-600 block mb-1">Start</label>
                    <input type="datetime-local" value={startTime} onChange={(e) => { setStartTime(e.target.value); setTimePreset(null) }}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-purple-500" />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-600 block mb-1">End</label>
                    <input type="datetime-local" value={endTime} onChange={(e) => { setEndTime(e.target.value); setTimePreset(null) }}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-purple-500" />
                  </div>
                </div>
              </div>

              {/* Filters row */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Event Type</label>
                  <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
                    <option value="all">All</option><option value="clipboard">Clipboard</option><option value="usb">USB</option><option value="file">File</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Severity</label>
                  <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
                    <option value="all">All</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Classification</label>
                  <select value={classification} onChange={(e) => setClassification(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
                    <option value="all">All</option><option value="Restricted">Restricted</option><option value="Confidential">Confidential</option><option value="Internal">Internal</option><option value="Public">Public</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Agent</label>
                  <input value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} placeholder="Agent ID..." className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">User</label>
                  <input value={userFilter} onChange={(e) => setUserFilter(e.target.value)} placeholder="Email..." className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
        ) : error ? (
          <div className="bg-gray-900 border border-red-500/30 rounded-xl p-6 text-center"><p className="text-red-400">Failed to load events</p></div>
        ) : events.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
            <Search className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500">No events match your filters</p>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            {/* Table Header */}
            <div className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-gray-800 text-xs text-gray-500 uppercase font-medium">
              <div className="col-span-1">Type</div>
              <div className="col-span-3">Description</div>
              <div className="col-span-2">Classification</div>
              <div className="col-span-1">Severity</div>
              <div className="col-span-1">Action</div>
              <div className="col-span-2">User</div>
              <div className="col-span-2">Time</div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-gray-800">
              {events.map((event: any, idx: number) => {
                const isExpanded = expandedEvent === (event.id || idx.toString())
                const category = event.classification_category || event.classification_level || 'Public'

                return (
                  <div key={event.id || idx}>
                    <div
                      onClick={() => setExpandedEvent(isExpanded ? null : (event.id || idx.toString()))}
                      className="grid grid-cols-12 gap-2 px-4 py-3 hover:bg-gray-800/50 cursor-pointer transition-colors items-center text-sm"
                    >
                      <div className="col-span-1">
                        <span className="text-xs text-gray-400 capitalize">{event.event_type}</span>
                      </div>
                      <div className="col-span-3 truncate text-white">{event.description || `${event.event_type} event`}</div>
                      <div className="col-span-2">
                        <span className={`px-2 py-0.5 rounded border text-xs font-medium ${classificationColors[category] || classificationColors.Public}`}>{category}</span>
                      </div>
                      <div className="col-span-1">
                        <span className={`px-2 py-0.5 rounded border text-xs font-medium ${severityColors[event.severity] || severityColors.low}`}>{event.severity}</span>
                      </div>
                      <div className="col-span-1">
                        <span className={`text-xs font-medium ${event.blocked ? 'text-red-400' : 'text-gray-500'}`}>{event.action_taken || 'logged'}</span>
                      </div>
                      <div className="col-span-2 truncate text-gray-400 text-xs">{event.user_email || '-'}</div>
                      <div className="col-span-2 flex items-center justify-between">
                        <span className="text-gray-500 text-xs">{formatDateTimeIST(event.timestamp)}</span>
                        {isExpanded ? <ChevronUp className="w-3 h-3 text-gray-600" /> : <ChevronDown className="w-3 h-3 text-gray-600" />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 pb-4 bg-gray-800/30 space-y-3">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3">
                          <div><label className="text-xs text-gray-600">Event Type</label><p className="text-white text-sm capitalize">{event.event_subtype || event.event_type}</p></div>
                          <div><label className="text-xs text-gray-600">Action</label><p className="text-white text-sm">{event.action_taken || 'logged'}</p></div>
                          <div><label className="text-xs text-gray-600">Confidence</label><p className="text-white text-sm font-bold">{((event.classification_score || 0) * 100).toFixed(0)}%</p></div>
                          <div><label className="text-xs text-gray-600">Agent</label><p className="text-white text-xs font-mono">{event.agent_id}</p></div>
                        </div>
                        {event.classification_rules_matched && event.classification_rules_matched.length > 0 && (
                          <div>
                            <label className="text-xs text-gray-600">Matched Rules</label>
                            <div className="flex gap-1.5 mt-1 flex-wrap">
                              {event.classification_rules_matched.map((r: string, i: number) => (
                                <span key={i} className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-900/40 text-purple-300 border border-purple-500/40">{r}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {event.detected_content && (
                          <div>
                            <label className="text-xs text-gray-600">Detected Content</label>
                            <pre className="mt-1 text-xs text-gray-300 bg-gray-900 rounded-lg p-3 border border-gray-800 whitespace-pre-wrap">{event.detected_content}</pre>
                          </div>
                        )}
                        {event.file_path && (
                          <div><label className="text-xs text-gray-600">File Path</label><p className="text-white text-sm font-mono">{event.file_path}</p></div>
                        )}
                        <details className="text-xs">
                          <summary className="text-gray-600 cursor-pointer hover:text-gray-400">Raw JSON</summary>
                          <pre className="mt-2 text-gray-400 bg-gray-900 rounded-lg p-3 overflow-x-auto border border-gray-800">{JSON.stringify(event, null, 2)}</pre>
                        </details>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
