'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { AlertTriangle, Search, Filter, Clock, User, MessageSquare, ChevronDown, ChevronUp, Plus, Loader2, X, Shield } from 'lucide-react'
import { getIncidents, getIncident, createIncident, updateIncident, getIncidentComments, addIncidentComment } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'
import toast from 'react-hot-toast'

const severityMap: Record<number, { label: string; color: string }> = {
  0: { label: 'Info', color: 'bg-gray-900/30 border-gray-500/50 text-gray-400' },
  1: { label: 'Low', color: 'bg-green-900/30 border-green-500/50 text-green-400' },
  2: { label: 'Medium', color: 'bg-yellow-900/30 border-yellow-500/50 text-yellow-400' },
  3: { label: 'High', color: 'bg-orange-900/30 border-orange-500/50 text-orange-400' },
  4: { label: 'Critical', color: 'bg-red-900/30 border-red-500/50 text-red-400' },
}

const statusColors: Record<string, string> = {
  open: 'bg-red-900/30 border-red-500/50 text-red-400',
  investigating: 'bg-yellow-900/30 border-yellow-500/50 text-yellow-400',
  resolved: 'bg-green-900/30 border-green-500/50 text-green-400',
  closed: 'bg-gray-900/30 border-gray-500/50 text-gray-400',
}

function IncidentDetail({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const [newComment, setNewComment] = useState('')
  const [newStatus, setNewStatus] = useState('')
  const queryClient = useQueryClient()

  const { data: incident, isLoading } = useQuery({
    queryKey: ['incident', incidentId],
    queryFn: () => getIncident(incidentId),
  })

  const { data: comments = [] } = useQuery({
    queryKey: ['incident-comments', incidentId],
    queryFn: () => getIncidentComments(incidentId),
  })

  const updateMutation = useMutation({
    mutationFn: (payload: any) => updateIncident(incidentId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['incidents'] })
      queryClient.invalidateQueries({ queryKey: ['incident', incidentId] })
      toast.success('Incident updated')
    },
    onError: () => toast.error('Failed to update incident'),
  })

  const commentMutation = useMutation({
    mutationFn: (comment: string) => addIncidentComment(incidentId, comment),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['incident-comments', incidentId] })
      setNewComment('')
      toast.success('Comment added')
    },
    onError: () => toast.error('Failed to add comment'),
  })

  if (isLoading) return <div className="flex justify-center p-8"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
  if (!incident) return <div className="text-gray-400 p-8">Incident not found</div>

  const sev = severityMap[incident.severity] || severityMap[2]

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-2xl border border-gray-700 w-full max-w-3xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div>
            <h2 className="text-xl font-bold text-white">{incident.title || `Incident #${incident.id?.slice(0, 8)}`}</h2>
            <div className="flex gap-2 mt-2">
              <span className={`px-3 py-1 rounded-lg border text-xs font-medium uppercase ${sev.color}`}>{sev.label}</span>
              <span className={`px-3 py-1 rounded-lg border text-xs font-medium uppercase ${statusColors[incident.status] || statusColors.open}`}>{incident.status}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg"><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <div className="p-6 space-y-6">
          {incident.description && (
            <div>
              <label className="text-xs text-gray-400 uppercase font-medium block mb-1">Description</label>
              <p className="text-gray-300 text-sm">{incident.description}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-900/30 rounded-lg p-4 border border-gray-700">
              <label className="text-xs text-gray-400 uppercase font-medium block mb-1">Event ID</label>
              <p className="text-white font-mono text-xs">{incident.event_id || 'N/A'}</p>
            </div>
            <div className="bg-gray-900/30 rounded-lg p-4 border border-gray-700">
              <label className="text-xs text-gray-400 uppercase font-medium block mb-1">Created</label>
              <p className="text-white text-sm">{formatDateTimeIST(incident.created_at)}</p>
            </div>
          </div>

          {/* Status Update */}
          <div className="bg-gray-900/30 rounded-lg p-4 border border-gray-700">
            <label className="text-xs text-gray-400 uppercase font-medium block mb-2">Update Status</label>
            <div className="flex gap-2">
              {['open', 'investigating', 'resolved', 'closed'].map((s) => (
                <button
                  key={s}
                  onClick={() => updateMutation.mutate({ status: s })}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium uppercase transition-all ${
                    incident.status === s ? statusColors[s] : 'border-gray-600 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Comments */}
          <div>
            <label className="text-xs text-gray-400 uppercase font-medium block mb-3">
              <MessageSquare className="w-4 h-4 inline mr-1" /> Comments ({Array.isArray(comments) ? comments.length : 0})
            </label>
            <div className="space-y-3 mb-4 max-h-48 overflow-y-auto">
              {Array.isArray(comments) && comments.map((c: any) => (
                <div key={c.id} className="bg-gray-900/30 rounded-lg p-3 border border-gray-700">
                  <p className="text-gray-300 text-sm">{c.comment}</p>
                  <p className="text-gray-500 text-xs mt-1">{formatDateTimeIST(c.created_at)}</p>
                </div>
              ))}
              {(!Array.isArray(comments) || comments.length === 0) && (
                <p className="text-gray-500 text-sm">No comments yet</p>
              )}
            </div>
            <div className="flex gap-2">
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                onKeyDown={(e) => e.key === 'Enter' && newComment.trim() && commentMutation.mutate(newComment.trim())}
              />
              <button
                onClick={() => newComment.trim() && commentMutation.mutate(newComment.trim())}
                disabled={!newComment.trim()}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function IncidentsPage() {
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedIncident, setSelectedIncident] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ title: '', description: '', severity: 2 })
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['incidents', statusFilter],
    queryFn: () => getIncidents({ status: statusFilter !== 'all' ? statusFilter : undefined }),
    staleTime: 0,
    retry: false,
  })

  const createMutation = useMutation({
    mutationFn: (payload: any) => createIncident(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['incidents'] })
      setShowCreate(false)
      setCreateForm({ title: '', description: '', severity: 2 })
      toast.success('Incident created')
    },
    onError: () => toast.error('Failed to create incident'),
  })

  const incidents = Array.isArray(data) ? data : data?.incidents || data?.items || []
  const stats = {
    total: incidents.length,
    open: incidents.filter((i: any) => i.status === 'open').length,
    investigating: incidents.filter((i: any) => i.status === 'investigating').length,
    resolved: incidents.filter((i: any) => i.status === 'resolved').length,
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Incidents</h1>
            <p className="text-gray-400 text-sm mt-1">Security incident tracking and management</p>
          </div>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700">
            <Plus className="w-4 h-4" /> New Incident
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-white' },
            { label: 'Open', value: stats.open, color: 'text-red-400' },
            { label: 'Investigating', value: stats.investigating, color: 'text-yellow-400' },
            { label: 'Resolved', value: stats.resolved, color: 'text-green-400' },
          ].map((s) => (
            <div key={s.label} className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
              <p className="text-gray-400 text-xs uppercase">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-2">
          {['all', 'open', 'investigating', 'resolved', 'closed'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                statusFilter === s ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
        ) : error ? (
          <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-6 text-center">
            <p className="text-red-400">Failed to load incidents</p>
          </div>
        ) : incidents.length === 0 ? (
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-12 text-center">
            <Shield className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No incidents found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.map((incident: any) => {
              const sev = severityMap[incident.severity] || severityMap[2]
              return (
                <div
                  key={incident.id}
                  onClick={() => setSelectedIncident(incident.id)}
                  className="bg-gray-800/50 rounded-xl p-5 border border-gray-700 hover:border-purple-500/50 cursor-pointer transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h3 className="text-white font-medium">{incident.title || `Incident #${incident.id?.slice(0, 8)}`}</h3>
                      {incident.description && (
                        <p className="text-gray-400 text-sm mt-1 line-clamp-1">{incident.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <span className={`px-3 py-1 rounded-lg border text-xs font-medium uppercase ${sev.color}`}>{sev.label}</span>
                      <span className={`px-3 py-1 rounded-lg border text-xs font-medium uppercase ${statusColors[incident.status] || statusColors.open}`}>{incident.status}</span>
                      <span className="text-gray-500 text-xs">{formatDateTimeIST(incident.created_at)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Create Modal */}
        {showCreate && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-gray-800 rounded-2xl border border-gray-700 w-full max-w-lg p-6">
              <div className="flex justify-between mb-4">
                <h2 className="text-lg font-bold text-white">New Incident</h2>
                <button onClick={() => setShowCreate(false)}><X className="w-5 h-5 text-gray-400" /></button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Title</label>
                  <input value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} className="w-full bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Description</label>
                  <textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} rows={3} className="w-full bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
                </div>
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Severity</label>
                  <select value={createForm.severity} onChange={(e) => setCreateForm({ ...createForm, severity: Number(e.target.value) })} className="w-full bg-gray-900/50 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500">
                    <option value={0}>Info</option><option value={1}>Low</option><option value={2}>Medium</option><option value={3}>High</option><option value={4}>Critical</option>
                  </select>
                </div>
                <button onClick={() => createMutation.mutate(createForm)} disabled={!createForm.title} className="w-full py-2 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:opacity-50">
                  Create Incident
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedIncident && <IncidentDetail incidentId={selectedIncident} onClose={() => setSelectedIncident(null)} />}
      </div>
    </DashboardLayout>
  )
}
