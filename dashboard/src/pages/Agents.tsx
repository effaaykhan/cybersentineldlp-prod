import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Server, RefreshCw, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { Dot } from '@/components/ui/Dot'
import Pagination from '@/components/ui/Pagination'
import {
  getAllAgents,
  deleteAgent,
  type Agent,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/Modal'

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

const TIER_BADGE: Record<
  LifecycleTier,
  { label: string; badgeClass: string; iconClass: string; dotLevel: string }
> = {
  active: {
    label: 'Active',
    badgeClass: 'badge-success',
    iconClass: 'bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] text-cs-ok',
    dotLevel: 'active',
  },
  disconnected: {
    label: 'Disconnected',
    badgeClass: 'badge-warning',
    iconClass: 'bg-[color-mix(in_srgb,var(--cs-med)_16%,var(--cs-panel))] text-cs-med',
    dotLevel: 'medium',
  },
}

const TIER_HINT: Record<LifecycleTier, string> = {
  active: 'Heartbeat received recently',
  disconnected: 'No recent heartbeat',
}

interface ConfirmState {
  agent: Agent
}

export default function Agents() {
  const [filter, setFilter] = useState<FilterType>('all')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
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

  // Reset to the first page whenever the lifecycle filter narrows the list
  useEffect(() => {
    setPage(1)
  }, [filter])

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

  const pageAgents = filteredAgents.slice((page - 1) * pageSize, page * pageSize)

  const handleAgentClick = (agentId: string) => {
    navigate(`/events?agent=${agentId}`)
  }

  const confirmTitle = 'Remove Agent'
  const confirmBody =
    'This soft-deletes the agent record. Event history is preserved, but the agent will no longer appear in this list. If the agent is still installed and heartbeating, it will automatically reappear on its next heartbeat.'
  const confirmCta = 'Remove'

  const isMutating = deleteMutation.isPending

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow mb-1.5">Fleet</p>
          <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Agents</h1>
          <p className="mt-1 text-sm text-cs-ink-2">
            Manage and monitor DLP agents (includes agent history)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="btn btn-secondary"
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
          className={`card cursor-pointer hover:shadow-card-hover transition-shadow ${filter === 'all' ? 'shadow-focus' : ''}`}
          onClick={() => setFilter('all')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <Server className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <p className="text-sm text-cs-ink-2">Total</p>
              <p className="num text-2xl font-semibold text-cs-ink">{list.length}</p>
              <p className="text-xs text-cs-muted mt-1">All agents</p>
            </div>
          </div>
        </div>
        {(['active', 'disconnected'] as LifecycleTier[]).map((tier) => {
          const meta = TIER_BADGE[tier]
          return (
            <div
              key={tier}
              className={`card cursor-pointer hover:shadow-card-hover transition-shadow ${filter === tier ? 'shadow-focus' : ''}`}
              onClick={() => setFilter(tier)}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-cs-sm ${meta.iconClass}`}>
                  <Server className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm text-cs-ink-2">{meta.label}</p>
                  <p className="num text-2xl font-semibold text-cs-ink">{counts[tier]}</p>
                  <p className="text-xs text-cs-muted mt-1">{TIER_HINT[tier]}</p>
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
                <th>Version</th>
                <th>IP Address</th>
                <th>Last Seen</th>
                <th>Registered</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-12">
                    <Server className="h-12 w-12 text-cs-muted-2 mx-auto mb-3" />
                    <p className="text-cs-ink-2 font-medium">
                      {filter === 'all' ? 'No agents registered' : `No ${TIER_BADGE[filter].label.toLowerCase()} agents`}
                    </p>
                    <p className="text-sm text-cs-muted mt-1">
                      {filter === 'all'
                        ? 'Agents will appear here once they register with the server'
                        : 'Click "Total" to see all agents'}
                    </p>
                  </td>
                </tr>
              ) : (
                pageAgents.map((agent) => {
                  const tier = resolveTier(agent)
                  const badge = TIER_BADGE[tier]
                  return (
                    <tr
                      key={agent.agent_id}
                      className="cursor-pointer hover:bg-cs-hair-2 transition-colors"
                    >
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span
                          className={`badge ${badge.badgeClass}`}
                          title={TIER_HINT[tier]}
                        >
                          <Dot level={badge.dotLevel} />
                          {badge.label}
                        </span>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <code
                          className="num text-xs bg-cs-hair-2 text-cs-ink-2 px-2 py-1 rounded-cs-sm"
                          title={agent.agent_id}
                        >
                          {typeof agent.agent_code === 'number'
                            ? String(agent.agent_code).padStart(3, '0')
                            : agent.agent_id}
                        </code>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <div>
                          <div className="font-medium text-cs-ink">{agent.name}</div>
                          {agent.hostname && (
                            <div className="text-xs text-cs-muted">{agent.hostname}</div>
                          )}
                        </div>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        {/* Precise product name ("Windows 11 Pro" / "Ubuntu 22.04.3 LTS").
                            Fall back to the capitalized family for legacy agents that
                            only ever sent ``os``. */}
                        <div
                          className={`text-cs-ink ${agent.os_name ? '' : 'capitalize'}`}
                          title={agent.os_name || agent.os || ''}
                        >
                          {agent.os_name || agent.os || '—'}
                        </div>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        {/* OS version/build — NOT the agent version (that's in the
                            tooltip). e.g. "23H2 (Build 22631.4460)" / kernel release. */}
                        <code
                          className="num text-xs text-cs-ink-2"
                          title={agent.version ? `Agent v${agent.version}` : undefined}
                        >
                          {agent.os_version || '—'}
                        </code>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <code className="num text-xs text-cs-ink-2">{agent.ip_address}</code>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span
                          className="num text-sm text-cs-ink-2"
                          title={agent.last_seen}
                        >
                          {agent.last_seen
                            ? `${formatRelativeTime(agent.last_seen)}`
                            : 'Never'}
                        </span>
                      </td>
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span className="num text-sm text-cs-ink-2">
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
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-cs-sm text-xs font-medium text-cs-crit hover:bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] disabled:opacity-50"
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
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filteredAgents.length}
          itemLabel="agents"
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
        />
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && deleteMutation.mutate(confirm.agent.agent_id)}
        title={confirmTitle}
        confirmLabel={confirmCta}
        busy={isMutating}
      >
        <p className="text-cs-ink">
          <span className="font-semibold">{confirm?.agent.name}</span>
          {typeof confirm?.agent.agent_code === 'number' && (
            <span className="num ml-2 text-[12px] text-cs-muted">
              ({String(confirm.agent.agent_code).padStart(3, '0')})
            </span>
          )}
        </p>
        <p className="mt-1.5">{confirmBody}</p>
      </ConfirmDialog>
    </div>
  )
}
