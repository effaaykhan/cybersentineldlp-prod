

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import { Shield, Clock, User, Loader2, X, AlertTriangle, CheckCircle, Eye, RefreshCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { getAutoIncidents, getAutoIncident, updateAutoIncident } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
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
        {incident.event_count > 1 && <span className="font-mono tabular-nums text-orange-600 font-medium">{incident.event_count} events</span>}
        <span className="ml-auto flex items-center gap-1"><Clock className="w-3 h-3" /><span className="font-mono tabular-nums">{formatDateTimeIST(incident.created_at)}</span></span>
      </div>
    </div>
  )
}

function IncidentDetail({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null)
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
  const relatedEvents = incident.related_events || []

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-4xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">{incident.title}</h2>
            <div className="flex gap-2 mt-2">
              <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ${sev.bg}`}>{sev.label}</span>
              <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ${(statusConfig[incident.status] || statusConfig.open).bg}`}>{incident.status}</span>
              {incident.classification_level && (
                <span className={`px-3 py-1 rounded-lg text-xs font-semibold uppercase ${
                  incident.classification_level === 'Restricted' ? 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20' :
                  incident.classification_level === 'Confidential' ? 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-600/20' :
                  'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/20'
                }`}>{incident.classification_level}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-500" /></button>
        </div>

        <div className="p-6 space-y-6">
          {/* Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'User', value: incident.user_email || 'Unknown', mono: false },
              { label: 'Agent', value: incident.agent_id?.slice(0, 12) || 'N/A', mono: true },
              { label: 'Events', value: incident.event_count || 1, mono: true },
              { label: 'Created', value: formatDateTimeIST(incident.created_at), mono: true },
            ].map((item) => (
              <div key={item.label} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                <label className="eyebrow block">{item.label}</label>
                <p className={`text-slate-900 text-sm font-medium truncate mt-0.5 ${item.mono ? 'font-mono tabular-nums' : ''}`}>{item.value}</p>
              </div>
            ))}
          </div>

          {/* Description */}
          {incident.description && (
            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
              <label className="eyebrow block mb-2">Description</label>
              <p className="text-slate-700 text-sm">{incident.description}</p>
            </div>
          )}

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

          {/* Raw Incident JSON */}
          <details className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
            <summary className="px-4 py-3 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-100">View Raw Incident Data</summary>
            <pre className="px-4 pb-4 text-xs font-mono text-slate-600 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(incident, null, 2)}</pre>
          </details>

          {/* Related Events */}
          {relatedEvents.length > 0 && (
            <div>
              <label className="eyebrow block mb-3">Related Events (<span className="font-mono tabular-nums">{relatedEvents.length}</span>)</label>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {relatedEvents.map((ev: any, idx: number) => (
                  <div key={idx} className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                    <div onClick={() => setExpandedEvent(expandedEvent === idx ? null : idx)}
                      className="flex items-center justify-between p-3 cursor-pointer hover:bg-slate-50 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-slate-900 text-sm font-medium truncate">{ev.description || ev.event_type}</p>
                        <p className="text-slate-500 text-xs">{ev.event_type} | {ev.action_taken || 'logged'} | <span className="font-mono tabular-nums">{formatDateTimeIST(ev.timestamp)}</span></p>
                      </div>
                      <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                        {ev.classification_level && (
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ring-1 ring-inset ${
                            ev.classification_level === 'Restricted' ? 'bg-red-50 text-red-700 ring-red-600/20' :
                            ev.classification_level === 'Confidential' ? 'bg-orange-50 text-orange-700 ring-orange-600/20' :
                            'bg-slate-100 text-slate-600 ring-slate-400/20'
                          }`}>{ev.classification_level}</span>
                        )}
                        {expandedEvent === idx ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </div>
                    </div>
                    {expandedEvent === idx && (
                      <div className="border-t border-slate-200 p-3 bg-slate-50">
                        {ev.detected_content && (
                          <div className="mb-3">
                            <label className="eyebrow block mb-1">Detected Content</label>
                            <pre className="text-xs font-mono text-slate-700 bg-white rounded p-2 border border-slate-200 whitespace-pre-wrap">{ev.detected_content}</pre>
                          </div>
                        )}
                        {ev.classification_rules_matched && ev.classification_rules_matched.length > 0 && (
                          <div className="mb-3">
                            <label className="eyebrow block mb-1">Matched Rules</label>
                            <div className="flex gap-1.5 flex-wrap">
                              {ev.classification_rules_matched.map((r: string, i: number) => (
                                <span key={i} className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-600/20">{r}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        <details>
                          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">Raw JSON</summary>
                          <pre className="mt-2 text-xs font-mono text-slate-600 bg-white rounded p-2 border border-slate-200 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(ev, null, 2)}</pre>
                        </details>
                      </div>
                    )}
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
      <div className="space-y-6 p-6 bg-white min-h-screen">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="eyebrow mb-1.5">Security Operations</p>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Incidents</h1>
            <p className="text-slate-500 text-sm mt-1">Auto-generated from blocked and critical DLP events</p>
          </div>
          <button onClick={() => refetch()} className="btn-secondary">
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
        ) : incidents.length === 0 ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-12 text-center">
            <Shield className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">No incidents. Blocked or critical events will auto-generate incidents.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* OPEN */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wider">Open (<span className="font-mono tabular-nums">{openIncidents.length}</span>)</h2>
              </div>
              <div className="space-y-3">
                {openIncidents.length === 0 ? (
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-6 text-center"><p className="text-slate-400 text-sm">No open incidents</p></div>
                ) : openIncidents.map((inc: any) => (
                  <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => setSelectedIncident(inc.id || inc.event_id)} />
                ))}
              </div>
            </div>

            {/* INVESTIGATING */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Eye className="w-4 h-4 text-amber-600" />
                <h2 className="text-sm font-semibold text-amber-700 uppercase tracking-wider">Investigating (<span className="font-mono tabular-nums">{investigatingIncidents.length}</span>)</h2>
              </div>
              <div className="space-y-3">
                {investigatingIncidents.length === 0 ? (
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-6 text-center"><p className="text-slate-400 text-sm">No active investigations</p></div>
                ) : investigatingIncidents.map((inc: any) => (
                  <IncidentCard key={inc.id || inc.event_id} incident={inc} onClick={() => setSelectedIncident(inc.id || inc.event_id)} />
                ))}
              </div>
            </div>

            {/* RESOLVED */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <h2 className="text-sm font-semibold text-green-700 uppercase tracking-wider">Resolved (<span className="font-mono tabular-nums">{resolvedIncidents.length}</span>)</h2>
              </div>
              <div className="space-y-3">
                {resolvedIncidents.length === 0 ? (
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-6 text-center"><p className="text-slate-400 text-sm">No resolved incidents</p></div>
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
