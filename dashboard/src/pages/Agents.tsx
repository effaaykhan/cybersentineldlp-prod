import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Server, RefreshCw, Trash2, X, Eraser } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import {
  getAllAgents,
  deleteAgent,
  cleanupStaleAgents,
  type Agent,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'

type LifecycleTier = 'active' | 'disconnected'
type FilterType = 'all' | LifecycleTier

// Resolve an agent's status to the binary active/disconnected model.
// Anything that isn't a fresh heartbeat is "disconnected" — including
// legacy cached payloads that only carry the boolean ``is_active``.
const resolveTier = (agent: Agent): LifecycleTier => {
  if (agent.lifecycle_status === 'active') return 'active'
  if (agent.lifecycle_status === 'disconnected') return 'disconnected'
  return agent.is_active ? 'active' : 'disconnected'
}

const TIER_BADGE: Record<LifecycleTier, { label: string; className: string; dot: string }> = {
  active: {
    label: 'Active',
    className: 'bg-green-100 text-green-800',
    dot: 'bg-green-600',
  },
  disconnected: {
    label: 'Disconnected',
    className: 'bg-yellow-100 text-yellow-800',
    dot: 'bg-yellow-500',
  },
}

const TIER_HINT: Record<LifecycleTier, string> = {
  active: 'Heartbeat received recently',
  disconnected: 'No recent heartbeat',
}

interface ConfirmState {
  agent: Agent
}

interface CleanupCandidate {
  agent_id: string
  name?: string
  agent_code?: number
  last_seen?: string | null
}

interface CleanupPreview {
  cutoff: string
  older_than_days: number
  would_remove_count: number
  candidates: CleanupCandidate[]
}

export default function Agents() {
  const [filter, setFilter] = useState<FilterType>('all')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupDays, setCleanupDays] = useState(30)
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Fetch all agents (including disconnected ones) with frequent refresh
  const {
    data: agents,
    isLoading,
    error,
    refetch,
  } = useQuery<Agent[]>({
    queryKey: ['allAgents'],
    queryFn: getAllAgents,
    refetchInterval: 5000,
    staleTime: 0,
  })

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => deleteAgent(agentId),
    onSuccess: (_, agentId) => {
      toast.success(`Agent ${agentId.slice(0, 8)}… removed`)
      queryClient.invalidateQueries({ queryKey: ['allAgents'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setConfirm(null)
    },
    onError: () => {
      toast.error('Failed to remove agent')
    },
  })

  // Two-step cleanup flow: dry-run preview first so the admin sees the
  // affected set, then a second click with dry_run=false actually applies.
  const cleanupPreviewMutation = useMutation({
    mutationFn: (days: number) => cleanupStaleAgents(days, true),
    onSuccess: (data) => {
      setCleanupPreview(data)
    },
    onError: () => {
      toast.error('Failed to fetch cleanup preview')
    },
  })

  const cleanupApplyMutation = useMutation({
    mutationFn: (days: number) => cleanupStaleAgents(days, false),
    onSuccess: (data) => {
      const removed = data?.removed_count ?? 0
      toast.success(
        removed === 0
          ? 'No stale agents found'
          : `Removed ${removed} stale agent${removed === 1 ? '' : 's'}`,
      )
      queryClient.invalidateQueries({ queryKey: ['allAgents'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      setCleanupOpen(false)
      setCleanupPreview(null)
    },
    onError: () => {
      toast.error('Failed to apply cleanup')
    },
  })

  if (isLoading) {
    return <LoadingSpinner size="lg" />
  }

  if (error) {
    return (
      <ErrorMessage
        message="Failed to load agents"
        retry={() => refetch()}
      />
    )
  }

  const list: Agent[] = Array.isArray(agents) ? agents : []

  const counts: Record<LifecycleTier, number> = {
    active: 0,
    disconnected: 0,
  }
  list.forEach((a) => {
    counts[resolveTier(a)] += 1
  })

  const filteredAgents = list.filter((agent) => {
    if (filter === 'all') return true
    return resolveTier(agent) === filter
  })

  const handleAgentClick = (agentId: string) => {
    navigate(`/events?agent=${agentId}`)
  }

  const confirmTitle = 'Remove Agent'
  const confirmBody =
    'This soft-deletes the agent record. Event history is preserved, but the agent will no longer appear in this list. If the agent is still installed and heartbeating, it will automatically reappear on its next heartbeat.'
  const confirmCta = 'Remove'
  const confirmCtaClass = 'bg-red-600 hover:bg-red-700 text-white'

  const isMutating = deleteMutation.isPending

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow mb-1.5">Fleet</p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Agents</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage and monitor DLP agents (includes agent history)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setCleanupOpen(true)
              setCleanupPreview(null)
            }}
            className="btn-secondary"
            title="Soft-delete agents that have been silent for N days"
          >
            <Eraser className="h-4 w-4" />
            Cleanup Stale
          </button>
          <button
            onClick={() => refetch()}
            className="btn-secondary"
            disabled={isLoading}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Lifecycle Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div
          className={`card cursor-pointer hover:shadow-card-hover transition-shadow ${filter === 'all' ? 'ring-2 ring-primary-500' : ''}`}
          onClick={() => setFilter('all')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Server className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <p className="text-sm text-slate-600">Total</p>
              <p className="font-mono text-2xl font-semibold tabular-nums text-slate-900">{list.length}</p>
              <p className="text-xs text-slate-500 mt-1">All agents</p>
            </div>
          </div>
        </div>
        {(['active', 'disconnected'] as LifecycleTier[]).map((tier) => {
          const meta = TIER_BADGE[tier]
          return (
            <div
              key={tier}
              className={`card cursor-pointer hover:shadow-card-hover transition-shadow ${filter === tier ? 'ring-2 ring-primary-500' : ''}`}
              onClick={() => setFilter(tier)}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${meta.className}`}>
                  <Server className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-slate-600">{meta.label}</p>
                  <p className="font-mono text-2xl font-semibold tabular-nums text-slate-900">{counts[tier]}</p>
                  <p className="text-xs text-slate-500 mt-1">{TIER_HINT[tier]}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Agents Table */}
      <div className="card p-0">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Agent ID</th>
                <th>Name</th>
                <th>OS</th>
                <th>IP Address</th>
                <th>Last Seen</th>
                <th>Registered</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12">
                    <Server className="h-12 w-12 text-slate-400 mx-auto mb-3" />
                    <p className="text-slate-600 font-medium">
                      {filter === 'all' ? 'No agents registered' : `No ${TIER_BADGE[filter].label.toLowerCase()} agents`}
                    </p>
                    <p className="text-sm text-slate-500 mt-1">
                      {filter === 'all'
                        ? 'Agents will appear here once they register with the server'
                        : 'Click "Total" to see all agents'}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredAgents.map((agent) => {
                  const tier = resolveTier(agent)
                  const badge = TIER_BADGE[tier]
                  return (
                    <tr
                      key={agent.agent_id}
                      className="cursor-pointer hover:bg-slate-50 transition-colors"
                    >
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span
                          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${badge.className}`}
                          title={TIER_HINT[tier]}
                        >
                          <span className={`w-2 h-2 rounded-full mr-1.5 ${badge.dot}`}></span>
                          {badge.label}
                        </span>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <code
                          className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded font-mono tabular-nums"
                          title={agent.agent_id}
                        >
                          {typeof agent.agent_code === 'number'
                            ? String(agent.agent_code).padStart(3, '0')
                            : agent.agent_id}
                        </code>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <div>
                          <div className="font-medium text-slate-900">{agent.name}</div>
                          {agent.hostname && (
                            <div className="text-xs text-slate-500">{agent.hostname}</div>
                          )}
                        </div>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <div className="flex items-center gap-2">
                          <span>{agent.os}</span>
                          {agent.os_version && (
                            <span className="text-xs text-slate-500">{agent.os_version}</span>
                          )}
                        </div>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <code className="text-xs font-mono tabular-nums text-slate-700">{agent.ip_address}</code>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span
                          className="text-sm font-mono tabular-nums text-slate-600"
                          title={agent.last_seen}
                        >
                          {agent.last_seen
                            ? `${formatRelativeTime(agent.last_seen)}`
                            : 'Never'}
                        </span>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span className="text-sm font-mono tabular-nums text-slate-600">
                          {formatRelativeTime(agent.created_at)}
                        </span>
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirm({ agent })
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                            disabled={isMutating}
                            title="Soft-delete this agent (event history is preserved)"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cleanup-stale modal — admin sweeps agents not seen for >N days */}
      {cleanupOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black bg-opacity-50"
            onClick={() => {
              if (cleanupApplyMutation.isPending) return
              setCleanupOpen(false)
              setCleanupPreview(null)
            }}
          />
          <div className="relative bg-white rounded-xl border border-slate-200 shadow-card max-w-lg w-full mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h2 className="text-lg font-semibold text-slate-900">Cleanup Stale Agents</h2>
              <button
                onClick={() => {
                  if (cleanupApplyMutation.isPending) return
                  setCleanupOpen(false)
                  setCleanupPreview(null)
                }}
                className="p-1 hover:bg-slate-100 rounded transition-colors"
                disabled={cleanupApplyMutation.isPending}
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 text-sm">
              <p className="text-slate-600">
                Soft-deletes agents whose last heartbeat is older than the
                threshold below. Event history is preserved.
              </p>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-slate-700">
                  Older than
                </label>
                <input
                  type="number"
                  min={1}
                  value={cleanupDays}
                  onChange={(e) => {
                    const next = Number(e.target.value)
                    setCleanupDays(Number.isFinite(next) && next > 0 ? next : 1)
                    setCleanupPreview(null)
                  }}
                  className="w-24 px-2 py-1 font-mono tabular-nums bg-white border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500"
                  disabled={cleanupApplyMutation.isPending}
                />
                <span className="text-sm text-slate-700">days</span>
                <button
                  onClick={() => cleanupPreviewMutation.mutate(cleanupDays)}
                  className="btn-secondary ml-auto disabled:opacity-50"
                  disabled={cleanupPreviewMutation.isPending || cleanupApplyMutation.isPending}
                >
                  {cleanupPreviewMutation.isPending ? 'Previewing…' : 'Preview'}
                </button>
              </div>
              {cleanupPreview && (
                <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 max-h-60 overflow-y-auto">
                  <p className="font-medium text-slate-800 mb-2">
                    {cleanupPreview.would_remove_count === 0
                      ? 'No agents match — nothing to remove.'
                      : `${cleanupPreview.would_remove_count} agent${cleanupPreview.would_remove_count === 1 ? '' : 's'} would be soft-deleted:`}
                  </p>
                  {cleanupPreview.candidates.length > 0 && (
                    <ul className="space-y-1 text-xs">
                      {cleanupPreview.candidates.map((c) => (
                        <li key={c.agent_id} className="flex items-center gap-2">
                          {typeof c.agent_code === 'number' && (
                            <span className="font-mono tabular-nums text-slate-500">
                              {String(c.agent_code).padStart(3, '0')}
                            </span>
                          )}
                          <span className="font-medium">{c.name || c.agent_id}</span>
                          <span className="font-mono tabular-nums text-slate-500 ml-auto">
                            {c.last_seen ? formatRelativeTime(c.last_seen) : 'Never'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="px-6 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => {
                  setCleanupOpen(false)
                  setCleanupPreview(null)
                }}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100"
                disabled={cleanupApplyMutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={() => cleanupApplyMutation.mutate(cleanupDays)}
                className="btn-danger disabled:opacity-50"
                disabled={
                  !cleanupPreview ||
                  cleanupPreview.would_remove_count === 0 ||
                  cleanupApplyMutation.isPending
                }
                title={
                  !cleanupPreview
                    ? 'Run a preview first'
                    : cleanupPreview.would_remove_count === 0
                      ? 'Nothing to remove'
                      : 'Soft-delete the listed agents'
                }
              >
                {cleanupApplyMutation.isPending ? 'Removing…' : 'Apply Cleanup'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal — shared for both Remove and Decommission actions */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black bg-opacity-50"
            onClick={() => !isMutating && setConfirm(null)}
          />
          <div className="relative bg-white rounded-xl border border-slate-200 shadow-card max-w-md w-full mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h2 className="text-lg font-semibold text-slate-900">{confirmTitle}</h2>
              <button
                onClick={() => !isMutating && setConfirm(null)}
                className="p-1 hover:bg-slate-100 rounded transition-colors"
                disabled={isMutating}
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm">
              <p className="text-slate-700">
                <span className="font-medium">{confirm.agent.name}</span>
                {typeof confirm.agent.agent_code === 'number' && (
                  <span className="ml-2 font-mono tabular-nums text-xs text-slate-500">
                    ({String(confirm.agent.agent_code).padStart(3, '0')})
                  </span>
                )}
              </p>
              <p className="text-slate-600">{confirmBody}</p>
            </div>
            <div className="px-6 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100"
                disabled={isMutating}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirm.agent.agent_id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${confirmCtaClass} disabled:opacity-50`}
                disabled={isMutating}
              >
                {isMutating ? 'Working…' : confirmCta}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
