'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { Search, Filter, Loader2, X, Download, RefreshCcw, Clock, Shield, AlertTriangle, Clipboard, Usb, File, ChevronDown, ChevronUp } from 'lucide-react'
import { getEvents as fetchEvents } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'

const eventTypeIcons: Record<string, any> = {
  clipboard: Clipboard,
  usb: Usb,
  file: File,
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
  const [limit, setLimit] = useState(50)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['log-explorer', eventType, severity, classification, limit],
    queryFn: () => fetchEvents({
      limit,
      event_type: eventType !== 'all' ? eventType : undefined,
      severity: severity !== 'all' ? severity : undefined,
    }),
    staleTime: 0,
    retry: false,
  })

  const rawEvents = data?.events || (Array.isArray(data) ? data : [])

  // Client-side filters
  const events = rawEvents.filter((e: any) => {
    if (classification !== 'all') {
      const cat = (e.classification_category || e.classification_level || 'Public').toLowerCase()
      if (cat !== classification.toLowerCase()) return false
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const searchFields = [
        e.description, e.event_type, e.agent_id, e.user_email,
        e.file_path, e.detected_content, e.classification_level,
        ...(e.classification_rules_matched || []),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!searchFields.includes(q)) return false
    }
    return true
  })

  const stats = {
    total: events.length,
    clipboard: events.filter((e: any) => e.event_type === 'clipboard').length,
    usb: events.filter((e: any) => e.event_type === 'usb').length,
    file: events.filter((e: any) => e.event_type === 'file').length,
    blocked: events.filter((e: any) => e.blocked || e.action_taken === 'block').length,
  }

  const exportLogs = () => {
    const csv = [
      ['Timestamp', 'Event Type', 'Severity', 'Classification', 'Action', 'Description', 'Agent', 'User'].join(','),
      ...events.map((e: any) => [
        e.timestamp, e.event_type, e.severity,
        e.classification_category || e.classification_level || 'Public',
        e.action_taken || 'logged',
        `"${(e.description || '').replace(/"/g, '""')}"`,
        e.agent_id, e.user_email,
      ].join(','))
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `dlp-logs-${new Date().toISOString().slice(0,10)}.csv`
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Log Explorer</h1>
            <p className="text-gray-400 text-sm mt-1">Search and analyze DLP events across all channels</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 bg-gray-800 text-gray-400 rounded-lg border border-gray-700 hover:text-white text-sm">
              <RefreshCcw className="w-4 h-4" /> Refresh
            </button>
            <button onClick={exportLogs} className="flex items-center gap-2 px-3 py-2 bg-gray-800 text-gray-400 rounded-lg border border-gray-700 hover:text-white text-sm">
              <Download className="w-4 h-4" /> Export CSV
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-white' },
            { label: 'Clipboard', value: stats.clipboard, color: 'text-purple-400' },
            { label: 'USB', value: stats.usb, color: 'text-blue-400' },
            { label: 'File', value: stats.file, color: 'text-yellow-400' },
            { label: 'Blocked', value: stats.blocked, color: 'text-red-400' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
              <p className="text-gray-400 text-xs uppercase">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Search + Filters */}
        <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search events by description, agent, user, file path, classification rules..."
              className="w-full pl-10 pr-4 py-2.5 bg-gray-900/50 border border-gray-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="w-4 h-4 text-gray-500 hover:text-white" />
              </button>
            )}
          </div>
          <div className="flex gap-3 flex-wrap">
            <select value={eventType} onChange={(e) => setEventType(e.target.value)} className="bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
              <option value="all">All Types</option>
              <option value="clipboard">Clipboard</option>
              <option value="usb">USB</option>
              <option value="file">File</option>
            </select>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select value={classification} onChange={(e) => setClassification(e.target.value)} className="bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
              <option value="all">All Classifications</option>
              <option value="Restricted">Restricted</option>
              <option value="Confidential">Confidential</option>
              <option value="Internal">Internal</option>
              <option value="Public">Public</option>
            </select>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500">
              <option value={25}>25 results</option>
              <option value={50}>50 results</option>
              <option value={100}>100 results</option>
              <option value={200}>200 results</option>
            </select>
          </div>
        </div>

        {/* Results */}
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
        ) : error ? (
          <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-6 text-center">
            <p className="text-red-400">Failed to load events</p>
          </div>
        ) : events.length === 0 ? (
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-12 text-center">
            <Search className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No events match your filters</p>
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event: any, idx: number) => {
              const IconComp = eventTypeIcons[event.event_type] || AlertTriangle
              const isExpanded = expandedEvent === (event.id || idx.toString())
              const category = event.classification_category || event.classification_level || 'Public'

              return (
                <div key={event.id || idx} className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden">
                  <div
                    onClick={() => setExpandedEvent(isExpanded ? null : (event.id || idx.toString()))}
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-700/30 transition-all"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={`p-2 rounded-lg ${event.blocked ? 'bg-red-900/30 text-red-400' : 'bg-gray-900/30 text-gray-400'}`}>
                        <IconComp className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-white font-medium text-sm truncate">
                          {event.description || `${event.event_type} event`}
                        </p>
                        <p className="text-gray-500 text-xs truncate">
                          {event.user_email} | {event.agent_id?.slice(0, 12)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${
                        category === 'Restricted' ? 'bg-red-900/30 border-red-500/50 text-red-400' :
                        category === 'Confidential' ? 'bg-orange-900/30 border-orange-500/50 text-orange-400' :
                        category === 'Internal' ? 'bg-yellow-900/30 border-yellow-500/50 text-yellow-400' :
                        'bg-gray-900/30 border-gray-500/50 text-gray-400'
                      }`}>{category}</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium border ${severityColors[event.severity] || severityColors.low}`}>{event.severity}</span>
                      {event.blocked && <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-900/30 border border-red-500/50 text-red-400">Blocked</span>}
                      <span className="text-gray-500 text-xs whitespace-nowrap">{formatDateTimeIST(event.timestamp)}</span>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-gray-700 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                        <div>
                          <label className="text-xs text-gray-500">Event Type</label>
                          <p className="text-white text-sm capitalize">{event.event_subtype || event.event_type}</p>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Action</label>
                          <p className="text-white text-sm">{event.action_taken || 'logged'}</p>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Confidence</label>
                          <p className="text-white text-sm font-bold">{((event.classification_score || 0) * 100).toFixed(0)}%</p>
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Agent</label>
                          <p className="text-white text-sm font-mono text-xs">{event.agent_id}</p>
                        </div>
                      </div>
                      {event.classification_rules_matched && event.classification_rules_matched.length > 0 && (
                        <div>
                          <label className="text-xs text-gray-500">Matched Rules</label>
                          <div className="flex gap-1.5 mt-1 flex-wrap">
                            {event.classification_rules_matched.map((r: string, i: number) => (
                              <span key={i} className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-900/40 text-purple-300 border border-purple-500/40">{r}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {event.detected_content && (
                        <div>
                          <label className="text-xs text-gray-500">Detected Content</label>
                          <pre className="mt-1 text-xs text-gray-300 bg-gray-900/50 rounded-lg p-3 border border-gray-700 whitespace-pre-wrap">{event.detected_content}</pre>
                        </div>
                      )}
                      <details>
                        <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Raw JSON</summary>
                        <pre className="mt-2 text-xs text-gray-400 bg-gray-900/50 rounded-lg p-3 overflow-x-auto border border-gray-700">
                          {JSON.stringify(event, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
