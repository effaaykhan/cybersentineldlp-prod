

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import { Flame, Shield, Clock, User, ChevronDown, ChevronUp, Loader2, X, AlertTriangle, CheckCircle, Eye, RefreshCcw } from 'lucide-react'
import { getAutoIncidents, getAutoIncident, updateAutoIncident } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import toast from 'react-hot-toast'

const severityMap: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: 'Info', color: 'text-gray-400', bg: 'bg-gray-900/30 border-gray-600' },
  1: { label: 'Low', color: 'text-green-400', bg: 'bg-green-900/30 border-green-500/50' },
  2: { label: 'Medium', color: 'text-yellow-400', bg: 'bg-yellow-900/30 border-yellow-500/50' },
  3: { label: 'High', color: 'text-orange-400', bg: 'bg-orange-900/30 border-orange-500/50' },
  4: { label: 'Critical', color: 'text-red-400', bg: 'bg-red-900/30 border-red-500/50' },
}

const statusConfig: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  open: { label: 'Open', icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-900/30 border-red-500/50' },
  investigating: { label: 'Investigating', icon: Eye, color: 'text-yellow-400', bg: 'bg-yellow-900/30 border-yellow-500/50' },
  resolved: { label: 'Resolved', icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-900/30 border-green-500/50' },
}

function IncidentCard({ incident, onClick }: { incident: any; onClick: () => void }) {
  const sev = severityMap[incident.severity] || severityMap[2]
  return (
    <div onClick={onClick} className="bg-gray-900 rounded-xl border border-gray-800 p-4 hover:border-purple-500/40 cursor-pointer transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-white font-medium text-sm truncate">{incident.title}</h4>
          <p className="text-gray-500 text-xs mt-1 truncate">{incident.description}</p>
        </div>
        <span className={`px-2.5 py-1 rounded-lg border text-xs font-semibold uppercase flex-shrink-0 ${sev.bg}`}>{sev.label}</span>
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
        {incident.user_email && <span className="flex items-center gap-1"><User className="w-3 h-3" />{incident.user_email}</span>}
        {incident.agent_id && <span className="truncate max-w-[120px]">Agent: {incident.agent_id.slice(0, 8)}</span>}
        {incident.event_count > 1 && <span className="text-orange-400">{incident.event_count} events</span>}
        <span className="ml-auto flex items-center gap-1"><Clock className="w-3 h-3" />{formatDateTimeIST(incident.created_at)}</span>
      </div>
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

  if (isLoading) return <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
  if (!incident) return null

  const sev = severityMap[incident.severity] || severityMap[2]
  const relatedEvents = incident.related_events || []

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-2xl border border-gray-700 w-full max-w-4xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div>
            <h2 className="text-xl font-bold text-white">{incident.title}</h2>
            <div className="flex gap-2 mt-2">
              <span className={`px-3 py-1 rounded-lg border text-xs font-semibold uppercase ${sev.bg}`}>{sev.label}</span>
              <span className={`px-3 py-1 rounded-lg border text-xs font-semibold uppercase ${(statusConfig[incident.status] || statusConfig.open).bg}`}>{incident.status}</span>
              {incident.classification_level && (
                <span className={`px-3 py-1 rounded-lg border text-xs font-semibold uppercase ${
                  incident.classification_level === 'Restricted' ? 'bg-red-900/30 border-red-500/50 text-red-400' :
                  incident.classification_level === 'Confidential' ? 'bg-orange-900/30 border-orange-500/50 text-orange-400' :
                  'bg-gray-900/30 border-gray-600 text-gray-400'
                }`}>{incident.classification_level}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg"><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <div className="p-6 space-y-6">
          {/* Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <label className="text-xs text-gray-500 block">User</label>
              <p className="text-white text-sm font-medium truncate">{incident.user_email || 'Unknown'}</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <label className="text-xs text-gray-500 block">Agent</label>
              <p className="text-white text-sm font-mono truncate">{incident.agent_id?.slice(0, 12) || 'N/A'}</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <label className="text-xs text-gray-500 block">Events</label>
              <p className="text-white text-sm font-bold">{incident.event_count || 1}</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
              <label className="text-xs text-gray-500 block">Created</label>
              <p className="text-white text-sm">{formatDateTimeIST(incident.created_at)}</p>
            </div>
          </div>

          {/* Description */}
          {incident.description && (
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <label className="text-xs text-gray-500 uppercase block mb-2">Description</label>
              <p className="text-gray-300 text-sm">{incident.description}</p>
            </div>
          )}

          {/* Status Actions */}
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
            <label className="text-xs text-gray-500 uppercase block mb-3">Update Status</label>
            <div className="flex gap-2">
              {['open', 'investigating', 'resolved'].map((s) => {
                const cfg = statusConfig[s]
                return (
                  <button
                    key={s}
                    onClick={() => statusMutation.mutate(s)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                      incident.status === s ? cfg.bg + ' ' + cfg.color : 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                    }`}
                  >
                    <cfg.icon className="w-4 h-4" />
                    {cfg.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Related Events */}
          {relatedEvents.length > 0 && (
            <div>
              <label className="text-xs text-gray-500 uppercase block mb-3">Related Events ({relatedEvents.length})</label>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {relatedEvents.map((ev: any, idx: number) => (
                  <div key={idx} className="bg-gray-900 rounded-lg p-3 border border-gray-800 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm truncate">{ev.description || ev.event_type}</p>
                      <p className="text-gray-500 text-xs">{ev.event_type} | {ev.action_taken || 'logged'}</p>
                    </div>
                    <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                      {ev.classification_level && (
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          ev.classification_level === 'Restricted' ? 'bg-red-900/30 text-red-400' : 'bg-gray-900/30 text-gray-400'
                        }`}>{ev.classification_level}</span>
                      )}
                      <span className="text-gray-600 text-xs">{formatDateTimeIST(ev.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function IncidentsPage() {
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['auto-incidents'],
    queryFn: () => getAutoIncidents({ limit: 200 }),
    staleTime: 0,
    refetchInterval: 15000,
    retry: false,
  })

  const incidents = data?.incidents || []
  const stats = data?.stats || { total: 0, open: 0, investigating: 0, resolved: 0 }

  const openIncidents = incidents.filter((i: any) => i.status === 'open').sort((a: any, b: any) => (b.severity || 0) - (a.severity || 0))
  const investigatingIncidents = incidents.filter((i: any) => i.status === 'investigating')
  const resolvedIncidents = incidents.filter((i: any) => i.status === 'resolved')

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Incidents</h1>
            <p className="text-gray-400 text-sm mt-1">Auto-generated from blocked and critical DLP events</p>
          </div>
          <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 bg-gray-900 text-gray-400 rounded-lg border border-gray-800 hover:text-white text-sm">
            <RefreshCcw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-white', icon: Flame },
            { label: 'Open', value: stats.open, color: 'text-red-400', icon: AlertTriangle },
            { label: 'Investigating', value: stats.investigating, color: 'text-yellow-400', icon: Eye },
            { label: 'Resolved', value: stats.resolved, color: 'text-green-400', icon: CheckCircle },
          ].map((s) => (
            <div key={s.label} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="flex items-center justify-between">
                <p className="text-gray-500 text-xs uppercase">{s.label}</p>
                <s.icon className={`w-4 h-4 ${s.color}`} />
              </div>
              <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
        ) : incidents.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
            <Shield className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500">No incidents. Events with blocked or critical classification will auto-generate incidents.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* OPEN */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <h2 className="text-sm font-semibold text-red-400 uppercase">Open ({openIncidents.length})</h2>
              </div>
              <div className="space-y-3">
                {openIncidents.length === 0 ? (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 text-center"><p className="text-gray-600 text-sm">No open incidents</p></div>
                ) : openIncidents.map((inc: any) => (
                  <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => setSelectedIncident(inc.id || inc.event_id)} />
                ))}
              </div>
            </div>

            {/* INVESTIGATING */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Eye className="w-4 h-4 text-yellow-400" />
                <h2 className="text-sm font-semibold text-yellow-400 uppercase">Investigating ({investigatingIncidents.length})</h2>
              </div>
              <div className="space-y-3">
                {investigatingIncidents.length === 0 ? (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 text-center"><p className="text-gray-600 text-sm">No active investigations</p></div>
                ) : investigatingIncidents.map((inc: any) => (
                  <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => setSelectedIncident(inc.id || inc.event_id)} />
                ))}
              </div>
            </div>

            {/* RESOLVED */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-4 h-4 text-green-400" />
                <h2 className="text-sm font-semibold text-green-400 uppercase">Resolved ({resolvedIncidents.length})</h2>
              </div>
              <div className="space-y-3">
                {resolvedIncidents.length === 0 ? (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 text-center"><p className="text-gray-600 text-sm">No resolved incidents</p></div>
                ) : resolvedIncidents.map((inc: any) => (
                  <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => setSelectedIncident(inc.id || inc.event_id)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {selectedIncident && <IncidentDetail incidentId={selectedIncident} onClose={() => setSelectedIncident(null)} />}
      </div>
    </>
  )
}
