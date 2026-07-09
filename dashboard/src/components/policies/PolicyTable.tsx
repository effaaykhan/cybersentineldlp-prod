import { Policy } from '@/types/policy'
import PolicyRow from './PolicyRow'
import { Shield } from 'lucide-react'

interface PolicyTableProps {
  title: string
  policies: Policy[]
  emptyMessage?: string
  onViewDetails: (policy: Policy) => void
  onEdit: (policy: Policy) => void
  onDuplicate: (policy: Policy) => void
  onToggleStatus: (policy: Policy) => void
  onDelete: (policy: Policy) => void
}

export default function PolicyTable({
  title,
  policies,
  emptyMessage = 'No policies found',
  onViewDetails,
  onEdit,
  onDuplicate,
  onToggleStatus,
  onDelete,
}: PolicyTableProps) {
  return (
    <div className="card p-0">
      {/* Table Header */}
      <div className="px-6 py-4 border-b border-slate-200">
        <h3 className="section-title">{title}</h3>
        <p className="text-sm text-slate-600 mt-1">
          <span className="font-mono tabular-nums">{policies.length}</span> {policies.length === 1 ? 'policy' : 'policies'}
        </p>
      </div>

      {/* Table Body */}
      <div className="divide-y divide-slate-200">
        {policies.length === 0 ? (
          <div className="p-12 text-center">
            <Shield className="h-12 w-12 text-slate-400 mx-auto mb-3" />
            <p className="text-slate-600 font-medium">{emptyMessage}</p>
          </div>
        ) : (
          policies.map((policy) => (
            <PolicyRow
              key={policy.id}
              policy={policy}
              onViewDetails={onViewDetails}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onToggleStatus={onToggleStatus}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}

