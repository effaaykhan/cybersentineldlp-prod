import { useState } from 'react'
import { X, Download } from 'lucide-react'
import { Policy } from '@/types/policy'
import { transformFrontendPolicyToApi, getPolicyTypeLabel, getSeverityColorLight } from '@/utils/policyUtils'
import toast from 'react-hot-toast'
import Modal, { ModalFooter } from '@/components/ui/Modal'

interface ExportPoliciesModalProps {
  isOpen: boolean
  policies: Policy[]
  onClose: () => void
}

// Reduce a frontend policy to the portable, import-ready shape. Running it
// through the same transform the create/update path uses guarantees the file
// re-imports cleanly. agent_ids are dropped on purpose — they reference agents
// in this deployment and would not resolve anywhere else (the importer always
// re-scopes to "all agents").
function toExportShape(p: Policy) {
  const api = transformFrontendPolicyToApi(p)
  delete api.agent_ids
  return api
}

export default function ExportPoliciesModal({ isOpen, policies, onClose }: ExportPoliciesModalProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(policies.map(p => p.id)))

  if (!isOpen) return null

  const allSelected = policies.length > 0 && selected.size === policies.length
  const noneSelected = selected.size === 0

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(policies.map(p => p.id)))
  }
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleExport = () => {
    const chosen = policies.filter(p => selected.has(p.id))
    if (chosen.length === 0) {
      toast.error('Select at least one policy to export')
      return
    }

    const doc = {
      format: 'cybersentinel-dlp-policies',
      version: 1,
      exported_at: new Date().toISOString(),
      count: chosen.length,
      policies: chosen.map(toExportShape),
    }

    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = url
    a.download = `cybersentinel-policies-${ts}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)

    toast.success(`Exported ${chosen.length} ${chosen.length === 1 ? 'policy' : 'policies'}`)
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      bodyClassName="px-6 py-5"
      header={
        <div className="flex items-center gap-3">
          <div className="rounded-cs-sm bg-cs-indigo-faint p-2">
            <Download className="h-5 w-5 text-cs-indigo" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">Export policies</h3>
            <p className="mt-0.5 text-[12.5px] text-cs-muted">Choose the policies to save to a JSON file.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      }
      footer={
        <ModalFooter
          left={
            <span className="text-[12.5px] text-cs-muted">
              {selected.size} of {policies.length} selected
            </span>
          }
        >
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={handleExport} disabled={selected.size === 0} className="btn btn-primary">
            <Download className="h-4 w-4" />
            Export{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
        </ModalFooter>
      }
    >
          {policies.length === 0 ? (
            <p className="text-sm text-cs-muted-2 text-center py-8">There are no policies to export.</p>
          ) : (
            <div className="border border-cs-hair rounded-cs-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-cs-panel-2 text-cs-muted-2">
                  <tr>
                    <th className="w-12 px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-cs-hair text-cs-indigo focus:ring-blue-500 cursor-pointer"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = !allSelected && !noneSelected }}
                        onChange={toggleAll}
                        aria-label="Select all policies"
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-semibold">Name</th>
                    <th className="px-3 py-3 text-left font-semibold">Type</th>
                    <th className="px-3 py-3 text-left font-semibold">Severity</th>
                    <th className="px-3 py-3 text-left font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {policies.map(p => {
                    const checked = selected.has(p.id)
                    const sev = getSeverityColorLight(p.severity || 'medium')
                    return (
                      <tr
                        key={p.id}
                        onClick={() => toggleOne(p.id)}
                        className={`cursor-pointer ${checked ? 'bg-cs-indigo-faint/60' : 'hover:bg-cs-panel-2'}`}
                      >
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-cs-hair text-cs-indigo focus:ring-blue-500 cursor-pointer"
                            checked={checked}
                            onChange={() => toggleOne(p.id)}
                            aria-label={`Select ${p.name}`}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium text-cs-ink truncate max-w-xs">{p.name}</div>
                          {p.description && <div className="text-xs text-cs-muted truncate max-w-xs">{p.description}</div>}
                        </td>
                        <td className="px-3 py-3 text-cs-muted-2">
                          {p.type ? getPolicyTypeLabel(p.type) : 'Classification-aware'}
                        </td>
                        <td className="px-3 py-3">
                          <span className={`badge ${sev.badge}`}>{p.severity || 'medium'}</span>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`text-xs font-medium ${p.enabled ? 'text-green-600' : 'text-cs-muted'}`}>
                            {p.enabled ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
    </Modal>
  )
}
