import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Server, RefreshCw } from 'lucide-react'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { getAllAgents, type Agent } from '@/lib/api'
import { formatRelativeTime, formatDate } from '@/lib/utils'

type FilterType = 'all' | 'active' | 'disconnected'

export default function Agents() {
  const [filter, setFilter] = useState<FilterType>('all')
  const navigate = useNavigate()

  // Fetch all agents (including disconnected ones) with more frequent refresh
  const {
    data: agents,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['allAgents'],
    queryFn: getAllAgents,
    refetchInterval: 5000, // Refresh every 5s for real-time updates
    staleTime: 0, // Always consider data stale to prevent caching
    cacheTime: 0, // Don't cache data to ensure fresh results
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

  // Calculate active and disconnected counts
  const activeCount = agents?.filter((a: Agent) => a.is_active)?.length || 0
  const disconnectedCount = agents?.filter((a: Agent) => !a.is_active)?.length || 0
  const totalCount = agents?.length || 0

  // Filter agents based on selected filter
  const filteredAgents = agents?.filter((agent: Agent) => {
    if (filter === 'active') return agent.is_active
    if (filter === 'disconnected') return !agent.is_active
    return true // 'all'
  }) || []

  // Handle agent click - navigate to events page filtered by agent
  const handleAgentClick = (agentId: string) => {
    navigate(`/events?agent=${agentId}`)
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="mt-1 text-sm text-gray-600">
            Manage and monitor DLP agents (includes agent history)
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="btn-secondary"
          disabled={isLoading}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className={`card cursor-pointer hover:shadow-lg transition-shadow ${filter === 'all' ? 'ring-2 ring-blue-500' : ''}`}
          onClick={() => setFilter('all')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Server className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Agents</p>
              <p className="text-2xl font-bold text-gray-900">
                {totalCount}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                All registered agents
              </p>
            </div>
          </div>
        </div>
        <div
          className={`card cursor-pointer hover:shadow-lg transition-shadow ${filter === 'active' ? 'ring-2 ring-green-500' : ''}`}
          onClick={() => setFilter('active')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <Server className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Active Agents</p>
              <p className="text-2xl font-bold text-green-600">
                {activeCount}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Heartbeat within last 5 seconds
              </p>
            </div>
          </div>
        </div>
        <div
          className={`card cursor-pointer hover:shadow-lg transition-shadow ${filter === 'disconnected' ? 'ring-2 ring-red-500' : ''}`}
          onClick={() => setFilter('disconnected')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-100 rounded-lg">
              <Server className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-600">Disconnected Agents</p>
              <p className="text-2xl font-bold text-red-600">
                {disconnectedCount}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                No recent heartbeat (&gt;5 seconds)
              </p>
            </div>
          </div>
        </div>
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
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12">
                    <Server className="h-12 w-12 text-gray-400 mx-auto mb-3" />
                    <p className="text-gray-600 font-medium">
                      {filter === 'all' ? 'No agents registered' : `No ${filter} agents`}
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      {filter === 'all'
                        ? 'Agents will appear here once they register with the server'
                        : `Click "Total Agents" to see all agents`
                      }
                    </p>
                  </td>
                </tr>
              ) : (
                filteredAgents.map((agent) => (
                  <tr
                    key={agent.agent_id}
                    onClick={() => handleAgentClick(agent.agent_id)}
                    className="cursor-pointer hover:bg-gray-50 transition-colors"
                    title="Click to view logs and alerts for this agent"
                  >
                    <td>
                      {agent.is_active ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          <span className="w-2 h-2 bg-green-600 rounded-full mr-1.5"></span>
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
                          <span className="w-2 h-2 bg-red-600 rounded-full mr-1.5"></span>
                          Disconnected
                        </span>
                      )}
                    </td>
                    <td>
                      {/* Show the short numeric agent_code zero-padded to
                          three digits (001, 012, 123). The UUID/agent_id
                          stays available on hover for power users and is
                          still the value sent on click-through. */}
                      <code
                        className="text-xs bg-gray-100 px-2 py-1 rounded font-mono tabular-nums"
                        title={agent.agent_id}
                      >
                        {typeof agent.agent_code === 'number'
                          ? String(agent.agent_code).padStart(3, '0')
                          : agent.agent_id}
                      </code>
                    </td>
                    <td>
                      <div>
                        <div className="font-medium text-gray-900">
                          {agent.name}
                        </div>
                        {agent.hostname && (
                          <div className="text-xs text-gray-500">
                            {agent.hostname}
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span>{agent.os}</span>
                        {agent.os_version && (
                          <span className="text-xs text-gray-500">
                            {agent.os_version}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <code className="text-xs">{agent.ip_address}</code>
                    </td>
                    <td>
                      <span className="text-sm text-gray-600">
                        {formatRelativeTime(agent.created_at)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
