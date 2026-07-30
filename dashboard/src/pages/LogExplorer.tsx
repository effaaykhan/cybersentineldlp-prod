import { useState, useEffect } from 'react'
import { Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Filter, Usb } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import { searchEvents } from '@/lib/api'
import { formatDateTimeIST, formatAgentLabel } from '@/lib/utils'

// USB device metadata rides on an event both as top-level keys and mirrored
// under a nested `usb` object (server DLPEvent uses extra="allow"). Read either.
type UsbInfo = {
  manufacturer?: string; model?: string; serial?: string
  vid?: string; pid?: string; volumeLabel?: string; driveLetter?: string; deviceName?: string
}
function usbInfo(ev: any): UsbInfo | null {
  const u = ev?.usb || {}
  const pick = (a: any, b: any) => ((a ?? b) || undefined)
  const info: UsbInfo = {
    manufacturer: pick(ev?.manufacturer, u.manufacturer),
    model: pick(ev?.product_name, u.product_name),
    serial: pick(ev?.serial_number, u.serial_number),
    vid: pick(ev?.vendor_id, u.vendor_id),
    pid: pick(ev?.product_id, u.product_id),
    volumeLabel: pick(ev?.volume_label, u.volume_label),
    driveLetter: pick(ev?.drive_letter, u.drive_letter),
    deviceName: pick(ev?.device_name, u.device_name),
  }
  const has = info.manufacturer || info.model || info.serial || info.vid || info.volumeLabel || info.deviceName
  return has ? info : null
}
const usbSummary = (i: UsbInfo) =>
  [i.manufacturer, i.model || i.deviceName].filter(Boolean).join(' ') || i.deviceName || i.serial || 'USB device'
const usbVidPid = (i: UsbInfo) => (i.vid || i.pid ? `${i.vid || '????'}:${i.pid || '????'}` : null)

const SEVERITY_OPTIONS = ['info', 'low', 'medium', 'high', 'critical']
const EVENT_TYPES = ['file_transfer', 'clipboard', 'usb', 'google_drive', 'onedrive', 'email', 'network', 'process']

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-gray-500/20 text-gray-300',
  low: 'bg-blue-500/20 text-blue-300',
  medium: 'bg-yellow-500/20 text-yellow-300',
  high: 'bg-orange-500/20 text-orange-300',
  critical: 'bg-red-500/20 text-red-300',
}

export default function LogExplorer() {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState('')
  const [eventType, setEventType] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [expandedRow, setExpandedRow] = useState<number | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(0)
  const limit = 50

  const fetchEvents = async () => {
    setLoading(true)
    try {
      const params: any = { skip: page * limit, limit }
      if (query) params.search = query
      if (severity) params.severity = severity
      if (eventType) params.event_type = eventType
      if (startDate) params.start_date = startDate
      if (endDate) params.end_date = endDate
      const data = await searchEvents(params)
      setEvents(Array.isArray(data) ? data : data?.events || [])
    } catch {
      toast.error('Failed to search events')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchEvents() }, [page])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(0)
    fetchEvents()
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-white flex items-center gap-2">
        <Search className="h-6 w-6" /> Log Explorer
      </h1>

      {/* Search Bar */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search events by keyword, file name, path..."
            className="w-full pl-10 pr-4 py-2.5 bg-[#1e2124] border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500" />
        </div>
        <button type="button" onClick={() => setShowFilters(!showFilters)}
          className="px-3 py-2 bg-[#1e2124] border border-gray-700 rounded-lg text-gray-300 hover:text-white">
          <Filter className="h-4 w-4" />
        </button>
        <button type="submit" className="px-5 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium">Search</button>
      </form>

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-[#1e2124] rounded-lg border border-gray-700 p-4 flex flex-wrap gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Severity</label>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}
              className="px-3 py-2 bg-[#2a2d2f] border border-gray-700 rounded-lg text-white text-sm">
              <option value="">All</option>
              {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Event Type</label>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)}
              className="px-3 py-2 bg-[#2a2d2f] border border-gray-700 rounded-lg text-white text-sm">
              <option value="">All</option>
              {EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 bg-[#2a2d2f] border border-gray-700 rounded-lg text-white text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">End Date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 bg-[#2a2d2f] border border-gray-700 rounded-lg text-white text-sm" />
          </div>
        </div>
      )}

      {/* Results */}
      {loading ? <LoadingSpinner /> : (
        <div className="bg-[#1e2124] rounded-lg border border-gray-700 overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="px-4 py-3 w-8"></th>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">File / Description</th>
              </tr>
            </thead>
            <tbody className="text-white">
              {events.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No events found</td></tr>
              ) : events.map((ev, i) => {
                const expanded = expandedRow === i
                const sevColor = SEVERITY_COLORS[(ev.severity || 'info').toLowerCase()] || SEVERITY_COLORS.info
                return (
                  <>
                    <tr key={ev.id || i} className="border-b border-gray-700/50 hover:bg-[#2a2d2f] cursor-pointer" onClick={() => setExpandedRow(expanded ? null : i)}>
                      <td className="px-4 py-3 text-gray-400">
                        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </td>
                      <td className="px-4 py-3 text-gray-400 whitespace-nowrap">{ev.timestamp ? formatDateTimeIST(ev.timestamp) : '-'}</td>
                      <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs font-medium bg-[#2a2d2f] text-gray-300">{ev.event_type || '-'}</span></td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${sevColor}`}>{ev.severity || 'info'}</span></td>
                      <td className="px-4 py-3 text-gray-300 text-xs" title={ev.agent_id}>
                        {ev.agent_name || ev.agent_code != null
                          ? formatAgentLabel(ev.agent_name, ev.agent_code)
                          : (ev.agent_id ? formatAgentLabel(undefined, undefined) : '-')}
                      </td>
                      <td className="px-4 py-3 text-gray-300 truncate max-w-xs">
                        {(() => {
                          const u = usbInfo(ev)
                          if (u && (ev.event_type || '').toLowerCase() === 'usb') {
                            return (
                              <span className="inline-flex items-center gap-1.5">
                                <Usb className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                                <span className="text-white">{usbSummary(u)}</span>
                                {u.serial && <span className="text-gray-500 font-mono text-xs">· {u.serial}</span>}
                              </span>
                            )
                          }
                          return ev.file_name || ev.description || ev.title || '-'
                        })()}
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${ev.id || i}-detail`} className="border-b border-gray-700/50">
                        <td colSpan={6} className="px-4 py-3 space-y-3">
                          {(() => {
                            const u = usbInfo(ev)
                            if (!u) return null
                            const fields: [string, string | null | undefined][] = [
                              ['Manufacturer', u.manufacturer],
                              ['Model', u.model || u.deviceName],
                              ['Serial Number', u.serial],
                              ['VID:PID', usbVidPid(u)],
                              ['Volume Label', u.volumeLabel],
                              ['Drive Letter', u.driveLetter],
                            ]
                            const shown = fields.filter(([, v]) => v)
                            return (
                              <div className="rounded-lg border border-gray-700 bg-[#232629] p-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
                                  <Usb className="h-3.5 w-3.5" /> USB Device
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
                                  {shown.map(([k, v]) => (
                                    <div key={k}>
                                      <div className="text-[11px] uppercase tracking-wide text-gray-500">{k}</div>
                                      <div className="text-sm text-gray-200 font-mono break-all">{v}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )
                          })()}
                          <pre className="p-3 bg-[#2a2d2f] rounded text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                            {JSON.stringify(ev, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {events.length > 0 ? `Showing ${page * limit + 1}-${page * limit + events.length}` : 'No results'}
        </span>
        <div className="flex gap-2">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
            className="px-3 py-1.5 bg-[#1e2124] border border-gray-700 rounded-lg text-sm text-white disabled:opacity-50 flex items-center gap-1">
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <button onClick={() => setPage(page + 1)} disabled={events.length < limit}
            className="px-3 py-1.5 bg-[#1e2124] border border-gray-700 rounded-lg text-sm text-white disabled:opacity-50 flex items-center gap-1">
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
