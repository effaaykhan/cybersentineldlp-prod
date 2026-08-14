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

  // Two different enforcement questions. `enforced` = allowlist scope is on, so
  // ALLOW rows decide what works. `deny_enforced` = any printer_control policy
  // is active, which is all a DENY row needs to bite.
  const enforced = printersQ.data?.enforced
  const denyEnforced = printersQ.data?.deny_enforced
  const denyCount = printersQ.data?.deny_count || 0

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Printers</h1>
        {enforced
          ? <span className="badge badge-success inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Allowlist enforcing</span>
          : <span className="badge badge-warning inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Allowlist off</span>}
        {denyCount > 0 && (
          denyEnforced
            ? <span className="badge badge-danger inline-flex items-center gap-1"><Ban className="h-3.5 w-3.5" />{denyCount} blocked</span>
            : <span className="badge badge-warning inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />{denyCount} blocked (no active policy)</span>
        )}
      </div>

      <AddRuleForm onDone={invalidate} />

      <Section
        title="Printer rules"
        count={printersQ.data?.count || 0}
        subtitle="Allow = permitted when the allowlist is enforcing. Block = disapproved outright — refused in every scope, and it overrides an allow for the same printer."
      >
        {(printersQ.data?.printers.length || 0) === 0 ? (
          <Empty text="No printer rules yet. Add one by name above, or from the seen list below." />
        ) : (
          <Table headers={['Printer', 'Decision', 'Label', 'Type', 'Status', 'Added', '']}>
            {printersQ.data!.printers.map((p) => (
              <SanctionedRow key={p.id} p={p} onChange={invalidate} />
            ))}
          </Table>
        )}
      </Section>

      <Section
        title="Seen on endpoints — no rule yet"
        count={seenQ.data?.count || 0}
        subtitle="Printers observed in print events with no rule. Allow to permit, or Block to disapprove."
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
    onSuccess: () => { onChange(); toast.success('Rule removed') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Remove failed')),
  })
  // Flip between sanctioned and disapproved without deleting and re-adding.
  const denied = p.decision === 'deny'
  const flip = useMutation({
    mutationFn: () => updatePrinter(p.id, { decision: denied ? 'allow' : 'deny' }),
    onSuccess: () => { onChange(); toast.success(denied ? 'Printer allowed' : 'Printer blocked') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink break-words">{p.printer_name}</td>
      <td className="px-3 py-2">
        {denied
          ? <span className="badge badge-danger inline-flex items-center gap-1"><Ban className="h-3.5 w-3.5" />Blocked</span>
          : <span className="badge badge-success inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" />Allowed</span>}
      </td>
      <td className="px-3 py-2 text-cs-ink-2">{p.label || '—'}</td>
      <td className="px-3 py-2 text-cs-ink-2 capitalize">{p.printer_type || '—'}</td>
      <td className="px-3 py-2">
        {p.is_enabled
          ? <span className="badge badge-success">Active</span>
          : <span className="badge badge-warning">Suspended</span>}
      </td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(p.approved_at)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {/* Flip the decision, delete the rule outright, or park it. Delete sits
            next to Block because they answer the same question — "stop this
            printer" — in two different ways: Block keeps refusing it, Delete
            forgets it ever had a rule. */}
        <button className="text-xs text-cs-ink-2 hover:text-cs-ink mr-3 inline-flex items-center gap-1"
          disabled={flip.isPending} onClick={() => flip.mutate()}>
          {denied ? <><Check className="h-3.5 w-3.5" />Allow</> : <><Ban className="h-3.5 w-3.5" />Block</>}
        </button>
        <button className="text-xs text-cs-rose hover:underline mr-3 inline-flex items-center gap-1"
          disabled={revoke.isPending}
          title="Delete this rule entirely — the printer falls back to whatever the policy scope says"
          onClick={() => {
            if (confirm(`Delete the rule for "${p.printer_name}"?\n\nThe printer is no longer allowed or blocked by name — it falls back to whatever the policy scope decides.`)) {
              revoke.mutate()
            }
          }}>
          <Trash2 className="h-3.5 w-3.5" />Delete
        </button>
        <button className="text-xs text-cs-ink-2 hover:text-cs-ink inline-flex items-center gap-1"
          disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {p.is_enabled ? 'Suspend' : 'Resume'}
        </button>
      </td>
    </tr>
  )
}

function SeenRow({ s, onApproved }: { s: SeenPrinter; onApproved: () => void }) {
  // One-click enrolment in either direction — the seen list is where you
  // triage a printer you did not expect, so refusing it must be as easy as
  // permitting it.
  const rule = useMutation({
    mutationFn: (decision: 'allow' | 'deny') =>
      approvePrinter({ printer_name: s.printer_name, decision }),
    onSuccess: (_d, decision) => {
      onApproved()
      toast.success(`${decision === 'deny' ? 'Blocked' : 'Allowed'} ${s.printer_name}`)
    },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink break-words">{s.printer_name}</td>
      <td className="px-3 py-2 text-cs-ink-2 capitalize">{s.last_action || '—'}</td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(s.last_seen)}</td>
      <td className="px-3 py-2 text-cs-muted text-xs num">{s.agent_id || '—'}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button className="btn btn-secondary btn-sm inline-flex items-center gap-1 mr-2"
          disabled={rule.isPending} onClick={() => rule.mutate('allow')}>
          <Check className="h-3.5 w-3.5" />Allow
        </button>
        <button className="btn btn-secondary btn-sm inline-flex items-center gap-1 text-cs-rose"
          disabled={rule.isPending} onClick={() => rule.mutate('deny')}>
          <Ban className="h-3.5 w-3.5" />Block
        </button>
      </td>
    </tr>
  )
}

function AddRuleForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [decision, setDecision] = useState<'allow' | 'deny'>('allow')
  const save = useMutation({
    mutationFn: () => approvePrinter({
      printer_name: name.trim(), label: label.trim() || undefined, decision,
    }),
    onSuccess: () => {
      setName(''); setLabel('')
      onDone()
      toast.success(decision === 'deny' ? 'Printer blocked' : 'Printer allowed')
    },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Save failed')),
  })
  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink mb-3">
        <Plus className="h-4 w-4 text-cs-indigo" /> Add a printer rule
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
        <div className="min-w-[150px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Decision</label>
          <select className="input text-sm" value={decision}
            onChange={(e) => setDecision(e.target.value as 'allow' | 'deny')}>
            <option value="allow">Allow</option>
            <option value="deny">Block</option>
          </select>
        </div>
        <button className="btn btn-primary" disabled={save.isPending || !name.trim()}
          onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : decision === 'deny' ? 'Block' : 'Allow'}
        </button>
      </div>
      {decision === 'deny' && (
        <p className="text-xs text-cs-muted mt-2">
          A blocked printer is refused in every scope and overrides an allow rule for
          the same name — it does not require the allowlist to be enforcing.
        </p>
      )}
    </div>
  )
}
