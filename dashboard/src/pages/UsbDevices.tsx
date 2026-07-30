import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Usb, ShieldCheck, ShieldAlert, Plus, Trash2, Check, Ban } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { extractErrorDetail } from '@/utils/errorUtils'
import {
  listDevices, seenDevices, approveDevice, updateDevice, revokeDevice,
  type SanctionedDevice, type SeenDevice, type UsbMatchType,
} from '@/lib/usb-devices-api'

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—')
const vidpid = (v?: string | null, p?: string | null) => (v || p ? `${v || '????'}:${p || '????'}` : '—')

const MATCH_LABEL: Record<UsbMatchType, string> = {
  serial: 'Serial',
  manufacturer: 'Manufacturer',
  device_id: 'Device ID',
  model: 'Model',
}
// Per match-type UI hints for the approve form's single value field.
const MATCH_FIELD: Record<UsbMatchType, { label: string; placeholder: string; scope: string }> = {
  serial:       { label: 'Serial number',        placeholder: 'e.g. 0123456789ABCDEF', scope: 'one specific device' },
  manufacturer: { label: 'Manufacturer',         placeholder: 'e.g. SanDisk',          scope: 'every device from this vendor' },
  device_id:    { label: 'Device ID (VID:PID)',  placeholder: 'e.g. 0781:5567',        scope: 'every device of this model/type' },
  model:        { label: 'Model (product name)', placeholder: 'e.g. Cruzer Blade',     scope: 'every device with this product name' },
}

export default function UsbDevices() {
  const qc = useQueryClient()
  const devicesQ = useQuery({ queryKey: ['usb-devices'], queryFn: listDevices })
  const seenQ = useQuery({ queryKey: ['usb-devices-seen'], queryFn: seenDevices })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['usb-devices'] })
    qc.invalidateQueries({ queryKey: ['usb-devices-seen'] })
  }

  if (devicesQ.isLoading) return <LoadingSpinner size="lg" />
  if (devicesQ.error) return <ErrorMessage message="Failed to load USB devices" retry={() => devicesQ.refetch()} />

  const enforced = devicesQ.data?.enforced

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">USB Devices</h1>
        {enforced
          ? <span className="badge badge-success inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Enforcing</span>
          : <span className="badge badge-warning inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Not enforced</span>}
      </div>

      <ApproveForm onDone={invalidate} />

      {/* Sanctioned devices */}
      <Section title="Sanctioned devices" count={devicesQ.data?.count || 0}>
        {(devicesQ.data?.devices.length || 0) === 0 ? (
          <Empty text="No devices approved yet. Approve one above, or from the seen list below." />
        ) : (
          <Table headers={['Match', 'Label', 'Device', 'VID:PID', 'Status', 'Approved', '']}>
            {devicesQ.data!.devices.map((d) => (
              <SanctionedRow key={d.id} d={d} onChange={invalidate} />
            ))}
          </Table>
        )}
      </Section>

      {/* Seen but unsanctioned */}
      <Section
        title="Seen on endpoints — not sanctioned"
        count={seenQ.data?.count || 0}
        subtitle="Devices observed in events that are not on the allowlist. Approve to permit them."
      >
        {seenQ.isLoading ? (
          <LoadingSpinner />
        ) : (seenQ.data?.devices.length || 0) === 0 ? (
          <Empty text="No unsanctioned devices have been seen." />
        ) : (
          <Table headers={['Serial', 'Device', 'VID:PID', 'Last seen', 'Agent', '']}>
            {seenQ.data!.devices.map((s) => (
              <SeenRow key={s.serial_number} s={s} onApproved={invalidate} />
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
      <Usb className="h-8 w-8 mx-auto mb-2 text-cs-muted-2" />
      {text}
    </div>
  )
}

function SanctionedRow({ d, onChange }: { d: SanctionedDevice; onChange: () => void }) {
  const toggle = useMutation({
    mutationFn: () => updateDevice(d.id, { is_enabled: !d.is_enabled }),
    onSuccess: () => { onChange(); toast.success(d.is_enabled ? 'Device suspended' : 'Device re-enabled') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  const revoke = useMutation({
    mutationFn: () => revokeDevice(d.id),
    onSuccess: () => { onChange(); toast.success('Approval revoked') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Revoke failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink whitespace-nowrap">
        <span className="badge badge-info mr-2">{MATCH_LABEL[d.match_type] || d.match_type}</span>
        <span className="num">{d.match_value || d.serial_number || '—'}</span>
      </td>
      <td className="px-3 py-2 text-cs-ink-2">{d.label || '—'}</td>
      <td className="px-3 py-2 text-cs-ink-2">{d.product_name || '—'}{d.manufacturer ? ` (${d.manufacturer})` : ''}</td>
      <td className="px-3 py-2 num text-cs-muted">{vidpid(d.vendor_id, d.product_id)}</td>
      <td className="px-3 py-2">
        {d.is_enabled
          ? <span className="badge badge-success">Enabled</span>
          : <span className="badge badge-warning">Suspended</span>}
      </td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(d.approved_at)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button className="text-xs text-cs-ink-2 hover:text-cs-ink mr-3 inline-flex items-center gap-1"
          disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {d.is_enabled ? <><Ban className="h-3.5 w-3.5" />Suspend</> : <><Check className="h-3.5 w-3.5" />Enable</>}
        </button>
        <button className="text-xs text-cs-rose hover:underline inline-flex items-center gap-1"
          disabled={revoke.isPending} onClick={() => revoke.mutate()}>
          <Trash2 className="h-3.5 w-3.5" />Revoke
        </button>
      </td>
    </tr>
  )
}

function SeenRow({ s, onApproved }: { s: SeenDevice; onApproved: () => void }) {
  const approve = useMutation({
    mutationFn: () => approveDevice({
      serial_number: s.serial_number,
      vendor_id: s.vendor_id || undefined,
      product_id: s.product_id || undefined,
      product_name: s.product_name || undefined,
      manufacturer: s.manufacturer || undefined,
    }),
    onSuccess: () => { onApproved(); toast.success(`Approved ${s.serial_number}`) },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Approve failed')),
  })
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 num text-cs-ink">{s.serial_number}</td>
      <td className="px-3 py-2 text-cs-ink-2">{s.product_name || '—'}{s.manufacturer ? ` (${s.manufacturer})` : ''}</td>
      <td className="px-3 py-2 num text-cs-muted">{vidpid(s.vendor_id, s.product_id)}</td>
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
  const [matchType, setMatchType] = useState<UsbMatchType>('serial')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const hint = MATCH_FIELD[matchType]

  // Also populate the natural display field so the sanctioned table renders the
  // device nicely; device_id "vid:pid" is split into VID/PID.
  const buildBody = () => {
    const v = value.trim()
    const body: Parameters<typeof approveDevice>[0] = {
      match_type: matchType,
      match_value: v,
      label: label.trim() || undefined,
    }
    if (matchType === 'serial') body.serial_number = v
    else if (matchType === 'manufacturer') body.manufacturer = v
    else if (matchType === 'model') body.product_name = v
    else if (matchType === 'device_id') {
      const [vid, pid] = v.split(':')
      body.vendor_id = (vid || '').trim() || undefined
      body.product_id = (pid || '').trim() || undefined
    }
    return body
  }

  const approve = useMutation({
    mutationFn: () => approveDevice(buildBody()),
    onSuccess: () => { setValue(''); setLabel(''); onDone(); toast.success('Exception approved') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Approve failed')),
  })
  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink mb-1">
        <Plus className="h-4 w-4 text-cs-indigo" /> Approve a USB exception
      </div>
      <p className="text-xs text-cs-muted mb-3">
        Allow by serial (one device), manufacturer (a whole vendor), device ID (a model/type) or model name.
        This matches <span className="font-medium text-cs-ink-2">{hint.scope}</span>.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[150px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Match by</label>
          <select className="input text-sm" value={matchType}
            onChange={(e) => setMatchType(e.target.value as UsbMatchType)}>
            <option value="serial">Serial number</option>
            <option value="manufacturer">Manufacturer</option>
            <option value="device_id">Device ID (VID:PID)</option>
            <option value="model">Model name</option>
          </select>
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">{hint.label}</label>
          <input className="input text-sm num" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={hint.placeholder} />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Label (optional)</label>
          <input className="input text-sm" value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Finance dept #3" />
        </div>
        <button className="btn btn-primary" disabled={approve.isPending || !value.trim()}
          onClick={() => approve.mutate()}>
          {approve.isPending ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}
