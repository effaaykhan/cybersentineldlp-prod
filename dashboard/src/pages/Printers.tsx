import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Printer, ShieldCheck, ShieldAlert, Plus, Trash2, Check, Ban } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { extractErrorDetail } from '@/utils/errorUtils'
import {
  listPrinters, seenPrinters, approvePrinter, updatePrinter, revokePrinter,
  type SanctionedPrinter, type SeenPrinter,
} from '@/lib/printers-api'

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—')

export default function Printers() {
  const qc = useQueryClient()
  const printersQ = useQuery({ queryKey: ['printers'], queryFn: listPrinters })
  const seenQ = useQuery({ queryKey: ['printers-seen'], queryFn: seenPrinters })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['printers'] })
    qc.invalidateQueries({ queryKey: ['printers-seen'] })
  }

  if (printersQ.isLoading) return <LoadingSpinner size="lg" />
  if (printersQ.error) return <ErrorMessage message="Failed to load printers" retry={() => printersQ.refetch()} />

  const enforced = printersQ.data?.enforced

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Printers</h1>
        {enforced
          ? <span className="badge badge-success inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Enforcing</span>
          : <span className="badge badge-warning inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Not enforced</span>}
      </div>

      <ApproveForm onDone={invalidate} />

      <Section title="Sanctioned printers" count={printersQ.data?.count || 0}>
        {(printersQ.data?.printers.length || 0) === 0 ? (
          <Empty text="No printers approved yet. Approve one by name above, or from the seen list below." />
        ) : (
          <Table headers={['Printer', 'Label', 'Type', 'Status', 'Approved', '']}>
            {printersQ.data!.printers.map((p) => (
              <SanctionedRow key={p.id} p={p} onChange={invalidate} />
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Seen on endpoints — not sanctioned"
        count={seenQ.data?.count || 0}
        subtitle="Printers observed in print events that are not on the allowlist. Approve to permit them."
      >
        {seenQ.isLoading ? (
          <LoadingSpinner />
        ) : (seenQ.data?.printers.length || 0) === 0 ? (
          <Empty text="No unsanctioned printers have been seen." />
        ) : (
          <Table headers={['Printer', 'Last action', 'Last seen', 'Agent', '']}>
            {seenQ.data!.printers.map((s) => (
              <SeenRow key={s.printer_name} s={s} onApproved={invalidate} />
            ))}
          </Table>
        )}
      </Section>
    </div>
  )
}

function Section({ title, count, subtitle, children }: {
  title: string; count: number; subtitle?: string; children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-cs-muted">{title}</h2>
        <span className="badge badge-info">{count}</span>
      </div>
      {subtitle && <p className="text-xs text-cs-muted mb-2">{subtitle}</p>}
      {children}
    </div>
  )
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-cs-card border border-cs-hair bg-cs-panel">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-cs-hair text-left">
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-cs-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-6 text-center text-sm text-cs-muted">
      <Printer className="h-8 w-8 mx-auto mb-2 text-cs-muted-2" />
      {text}
    </div>
  )
}

function SanctionedRow({ p, onChange }: { p: SanctionedPrinter; onChange: () => void }) {
  const toggle = useMutation({
    mutationFn: () => updatePrinter(p.id, { is_enabled: !p.is_enabled }),
    onSuccess: () => { onChange(); toast.success(p.is_enabled ? 'Printer suspended' : 'Printer re-enabled') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  const revoke = useMutation({
    mutationFn: () => revokePrinter(p.id),
    onSuccess: () => { onChange(); toast.success('Approval revoked') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Revoke failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink break-words">{p.printer_name}</td>
      <td className="px-3 py-2 text-cs-ink-2">{p.label || '—'}</td>
      <td className="px-3 py-2 text-cs-ink-2 capitalize">{p.printer_type || '—'}</td>
      <td className="px-3 py-2">
        {p.is_enabled
          ? <span className="badge badge-success">Enabled</span>
          : <span className="badge badge-warning">Suspended</span>}
      </td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(p.approved_at)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button className="text-xs text-cs-ink-2 hover:text-cs-ink mr-3 inline-flex items-center gap-1"
          disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {p.is_enabled ? <><Ban className="h-3.5 w-3.5" />Suspend</> : <><Check className="h-3.5 w-3.5" />Enable</>}
        </button>
        <button className="text-xs text-cs-rose hover:underline inline-flex items-center gap-1"
          disabled={revoke.isPending} onClick={() => revoke.mutate()}>
          <Trash2 className="h-3.5 w-3.5" />Revoke
        </button>
      </td>
    </tr>
  )
}

function SeenRow({ s, onApproved }: { s: SeenPrinter; onApproved: () => void }) {
  const approve = useMutation({
    mutationFn: () => approvePrinter({ printer_name: s.printer_name }),
    onSuccess: () => { onApproved(); toast.success(`Approved ${s.printer_name}`) },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Approve failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink break-words">{s.printer_name}</td>
      <td className="px-3 py-2 text-cs-ink-2 capitalize">{s.last_action || '—'}</td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(s.last_seen)}</td>
      <td className="px-3 py-2 text-cs-muted text-xs num">{s.agent_id || '—'}</td>
      <td className="px-3 py-2 text-right">
        <button className="btn btn-secondary btn-sm inline-flex items-center gap-1"
          disabled={approve.isPending} onClick={() => approve.mutate()}>
          <Check className="h-3.5 w-3.5" />{approve.isPending ? 'Approving…' : 'Approve'}
        </button>
      </td>
    </tr>
  )
}

function ApproveForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const approve = useMutation({
    mutationFn: () => approvePrinter({ printer_name: name.trim(), label: label.trim() || undefined }),
    onSuccess: () => { setName(''); setLabel(''); onDone(); toast.success('Printer approved') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Approve failed')),
  })
  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink mb-3">
        <Plus className="h-4 w-4 text-cs-indigo" /> Approve a printer by name
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Printer name</label>
          <input className="input text-sm" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. HP LaserJet 400  or  \\server\Reception" />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Label (optional)</label>
          <input className="input text-sm" value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Finance floor 2" />
        </div>
        <button className="btn btn-primary" disabled={approve.isPending || !name.trim()}
          onClick={() => approve.mutate()}>
          {approve.isPending ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}
