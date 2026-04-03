'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { ClipboardList, Search, Filter, Loader2, User, Clock, ChevronDown, ChevronUp, LogIn, LogOut, Plus, Edit, Trash, Shield, Settings, Key } from 'lucide-react'
import { getAuditLogs, getAuditActions } from '@/lib/api'
import { formatDateTimeIST } from '@/lib/utils'

const actionIcons: Record<string, any> = {
  'auth.login': LogIn,
  'auth.logout': LogOut,
  'policy.create': Plus,
  'policy.update': Edit,
  'policy.delete': Trash,
  'rule.create': Plus,
  'rule.delete': Trash,
  'user.create': User,
  'user.delete': Trash,
}

const actionColors: Record<string, string> = {
  'auth.login': 'text-green-400 bg-green-900/20',
  'auth.logout': 'text-gray-400 bg-gray-900/20',
  'policy.create': 'text-blue-400 bg-blue-900/20',
  'policy.update': 'text-yellow-400 bg-yellow-900/20',
  'policy.delete': 'text-red-400 bg-red-900/20',
  'rule.create': 'text-blue-400 bg-blue-900/20',
  'rule.delete': 'text-red-400 bg-red-900/20',
}

export default function AuditTrailPage() {
  const [actionFilter, setActionFilter] = useState('')
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const { data: actionsData } = useQuery({
    queryKey: ['audit-actions'],
    queryFn: getAuditActions,
    staleTime: 60000,
    retry: false,
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['audit-logs', actionFilter],
    queryFn: () => getAuditLogs({ action: actionFilter || undefined, limit: 200 }),
    staleTime: 0,
    retry: false,
  })

  const actions = Array.isArray(actionsData) ? actionsData : []
  const logs = data?.logs || []
  const total = data?.total || 0

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Trail</h1>
          <p className="text-gray-400 text-sm mt-1">Immutable record of all administrative actions</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <p className="text-gray-400 text-xs uppercase">Total Entries</p>
            <p className="text-2xl font-bold text-white">{total}</p>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <p className="text-gray-400 text-xs uppercase">Action Types</p>
            <p className="text-2xl font-bold text-purple-400">{actions.length}</p>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-4 border border-gray-700">
            <p className="text-gray-400 text-xs uppercase">Showing</p>
            <p className="text-2xl font-bold text-white">{logs.length}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setActionFilter('')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              !actionFilter ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
            }`}
          >
            All
          </button>
          {actions.map((action: string) => (
            <button
              key={action}
              onClick={() => setActionFilter(action)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                actionFilter === action ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {action}
            </button>
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-purple-500" /></div>
        ) : error ? (
          <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-6 text-center">
            <p className="text-red-400">Failed to load audit logs</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-12 text-center">
            <ClipboardList className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No audit entries found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {logs.map((log: any) => {
              const IconComp = actionIcons[log.action] || Settings
              const colorClass = actionColors[log.action] || 'text-gray-400 bg-gray-900/20'
              const isExpanded = expandedLog === log.id

              return (
                <div key={log.id} className="bg-gray-800/50 rounded-xl border border-gray-700 overflow-hidden">
                  <div
                    onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-700/30 transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${colorClass}`}>
                        <IconComp className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-white font-medium text-sm">{log.action}</p>
                        <p className="text-gray-500 text-xs">
                          User: {log.user_id ? log.user_id.slice(0, 8) + '...' : 'System'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500 text-xs">{formatDateTimeIST(log.created_at)}</span>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                  {isExpanded && log.details && (
                    <div className="px-4 pb-4 border-t border-gray-700">
                      <pre className="mt-3 text-xs text-gray-300 bg-gray-900/50 rounded-lg p-3 overflow-x-auto">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
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
