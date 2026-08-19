import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Server, RefreshCw, Trash2, PauseCircle, PlayCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { Dot } from '@/components/ui/Dot'
import Pagination from '@/components/ui/Pagination'
import {
  getAllAgents,
  deleteAgent,
  suspendAgent,
  resumeAgent,
  type Agent,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import Modal, { ConfirmDialog, ModalHeader, ModalFooter } from '@/components/ui/Modal'

type LifecycleTier = 'active' | 'paused' | 'disconnected'
type FilterType = 'all' | LifecycleTier

// Resolve an agent to exactly one tier, so the four stat cards add up to the
// total. "Paused" wins over connectivity because it is the fact that changes
// what the product is doing: a paused agent applies no policies and reports
// nothing whether or not it is heartbeating. Its connectivity is still one
// glance away in the Last Seen column.
const resolveTier = (agent: Agent): LifecycleTier => {
  if (agent.is_suspended) return 'paused'
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
  paused: {
    label: 'Paused',
    badgeClass: 'badge-info',
    iconClass: 'bg-cs-indigo-faint text-cs-indigo',
    dotLevel: 'info',
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
  paused: 'Temporarily switched off',
  disconnected: 'No recent heartbeat',
}

// How long a pause may last. Presets rather than a free-text duration: the
// point of this control is to be reached for quickly and, more importantly,
// to expire on its own. "Until I resume it" is offered because some windows
// genuinely have no known end (a laptop sent for repair), but it is listed
// last and labelled so nobody picks it by accident.
const DURATIONS: { label: string; minutes: number | null; note?: string }[] = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '8 hours', minutes: 480, note: 'a shift' },
  { label: '24 hours', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
  { label: 'Until I resume it', minutes: null, note: 'no auto-resume' },
]

/** "2d 4h" / "3h 12m" / "45m" / "30s" — coarse on purpose; this is a status line. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** The sub-line under a Paused badge: when protection comes back. */
function resumeHint(agent: Agent): string {
  const remaining = agent.suspension_seconds_remaining
  if (remaining === null || remaining === undefined) return 'No auto-resume'
  return `Resumes in ${formatDuration(remaining)}`
}

interface ConfirmState {
  agent: Agent
}

interface PauseState {
  agent: Agent
  minutes: number | null
  reason: string
}

export default function Agents() {
  const [filter, setFilter] = useState<FilterType>('all')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [pause, setPause] = useState<PauseState | null>(null)
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

  const invalidateAgents = () => {
    queryClient.invalidateQueries({ queryKey: ['allAgents'] })
    queryClient.invalidateQueries({ queryKey: ['agents'] })
  }

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => deleteAgent(agentId),
    onSuccess: (_, agentId) => {
      toast.success(`Agent ${agentId.slice(0, 8)}… removed`)
      invalidateAgents()
      setConfirm(null)
    },
    onError: () => {
      toast.error('Failed to remove agent')
    },
  })

  const suspendMutation = useMutation({
    mutationFn: ({ agentId, minutes, reason }: { agentId: string; minutes: number | null; reason: string }) =>
      suspendAgent(agentId, minutes, reason),
    onSuccess: (_data, vars) => {
      const window = vars.minutes === null
        ? 'until you resume it'
        : `for ${formatDuration(vars.minutes * 60)}`
      toast.success(`Agent paused ${window}`)
      invalidateAgents()
      setPause(null)
    },
    onError: () => {
      toast.error('Failed to pause agent')
    },
  })

  const resumeMutation = useMutation({
    mutationFn: (agentId: string) => resumeAgent(agentId),
    onSuccess: () => {
      toast.success('Agent resumed — policies apply again')
      invalidateAgents()
    },
    onError: () => {
      toast.error('Failed to resume agent')
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
    paused: 0,
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

  const isMutating =
    deleteMutation.isPending || suspendMutation.isPending || resumeMutation.isPending

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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
        {(['active', 'paused', 'disconnected'] as LifecycleTier[]).map((tier) => {
          const meta = TIER_BADGE[tier]
          const Icon = tier === 'paused' ? PauseCircle : Server
          return (
            <div
              key={tier}
              className={`card cursor-pointer hover:shadow-card-hover transition-shadow ${filter === tier ? 'shadow-focus' : ''}`}
              onClick={() => setFilter(tier)}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-cs-sm ${meta.iconClass}`}>
                  <Icon className="h-5 w-5" />
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
                  const paused = tier === 'paused'
                  return (
                    <tr
                      key={agent.agent_id}
                      className="cursor-pointer hover:bg-cs-hair-2 transition-colors"
                    >
                      <td onClick={() => handleAgentClick(agent.agent_id)}>
                        <span
                          className={`badge ${badge.badgeClass}`}
                          title={
                            paused
                              ? [
                                  'No policies are applied and events are discarded',
                                  agent.suspend_reason ? `Reason: ${agent.suspend_reason}` : null,
                                  agent.suspended_by ? `Paused by ${agent.suspended_by}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : TIER_HINT[tier]
                          }
                        >
                          {paused ? (
                            <PauseCircle className="h-3 w-3" />
                          ) : (
                            <Dot level={badge.dotLevel} />
                          )}
                          {badge.label}
                        </span>
                        {paused && (
                          <div className="mt-1 text-[11px] text-cs-muted">{resumeHint(agent)}</div>
                        )}
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
                          {paused ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                resumeMutation.mutate(agent.agent_id)
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-cs-sm text-xs font-medium text-cs-ok hover:bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] disabled:opacity-50"
                              disabled={isMutating}
                              title="Resume now — the agent starts enforcing policy again on its next sync"
                            >
                              <PlayCircle className="h-3.5 w-3.5" />
                              Resume
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setPause({ agent, minutes: 60, reason: '' })
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-cs-sm text-xs font-medium text-cs-ink-2 hover:bg-cs-hair-2 disabled:opacity-50"
                              disabled={isMutating}
                              title="Temporarily stop policing this endpoint and discard its events"
                            >
                              <PauseCircle className="h-3.5 w-3.5" />
                              Pause
                            </button>
                          )}
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

      {/* Pause an endpoint for a bounded window */}
      <Modal
        open={!!pause}
        onClose={() => setPause(null)}
        size="md"
        label="Pause agent"
        header={
          <ModalHeader
            eyebrow="Fleet"
            title="Pause Agent"
            hint="Stops policy enforcement and discards this endpoint's events for the window you choose. It resumes on its own — no follow-up needed."
            onClose={() => setPause(null)}
          />
        }
        footer={
          <ModalFooter>
            <button type="button" className="btn btn-secondary" onClick={() => setPause(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={suspendMutation.isPending}
              onClick={() =>
                pause &&
                suspendMutation.mutate({
                  agentId: pause.agent.agent_id,
                  minutes: pause.minutes,
                  reason: pause.reason,
                })
              }
            >
              {suspendMutation.isPending ? 'Pausing…' : 'Pause agent'}
            </button>
          </ModalFooter>
        }
      >
        {pause && (
          <div className="space-y-5">
            <p className="text-cs-ink">
              <span className="font-semibold">{pause.agent.name}</span>
              {typeof pause.agent.agent_code === 'number' && (
                <span className="num ml-2 text-[12px] text-cs-muted">
                  ({String(pause.agent.agent_code).padStart(3, '0')})
                </span>
              )}
              {pause.agent.hostname && (
                <span className="ml-2 text-[12.5px] text-cs-muted">{pause.agent.hostname}</span>
              )}
            </p>

            <div>
              <label className="mb-2 block text-[12.5px] font-medium text-cs-ink-2">
                Pause for
              </label>
              <div className="grid grid-cols-2 gap-2">
                {DURATIONS.map((d) => {
                  const selected = pause.minutes === d.minutes
                  return (
                    <button
                      key={d.label}
                      type="button"
                      onClick={() => setPause({ ...pause, minutes: d.minutes })}
                      className={`rounded-cs-sm border px-3 py-2 text-left text-[13px] transition-colors ${
                        selected
                          ? 'border-cs-indigo bg-cs-indigo-faint text-cs-indigo font-medium'
                          : 'border-cs-hair text-cs-ink-2 hover:bg-cs-hair-2'
                      }`}
                    >
                      {d.label}
                      {d.note && (
                        <span className="block text-[11px] font-normal text-cs-muted">{d.note}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label htmlFor="pause-reason" className="mb-1.5 block text-[12.5px] font-medium text-cs-ink-2">
                Reason <span className="font-normal text-cs-muted">(optional)</span>
              </label>
              <input
                id="pause-reason"
                className="input"
                maxLength={500}
                placeholder="Re-imaging the laptop…"
                value={pause.reason}
                onChange={(e) => setPause({ ...pause, reason: e.target.value })}
              />
              <p className="mt-1.5 text-[11.5px] text-cs-muted">
                Shown on this page while the agent is paused and written to the audit log.
              </p>
            </div>

            {/* This is a security control being switched off. Say so plainly —
                especially for the indefinite option, which nothing will undo. */}
            <div className="rounded-cs-sm border border-cs-hair bg-cs-panel-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-cs-ink-2">
              While paused, this endpoint is <span className="font-medium text-cs-ink">not protected</span>:
              no file, clipboard, USB, print or web policy is applied, and any events it
              reports are discarded rather than stored.
              {pause.minutes === null && (
                <span className="mt-1 block text-cs-high">
                  This pause has no end date — it stays off until someone resumes it.
                </span>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && deleteMutation.mutate(confirm.agent.agent_id)}
        title={confirmTitle}
        confirmLabel={confirmCta}
        busy={deleteMutation.isPending}
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
