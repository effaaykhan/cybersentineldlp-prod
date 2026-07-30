import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Usb, ShieldCheck, ShieldAlert, Plus, Trash2, Check, Ban, X, MapPin, Pencil } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { extractErrorDetail } from '@/utils/errorUtils'
import {
  listDevices, seenDevices, approveDevice, updateDevice, revokeDevice, getDeviceActivity,
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

// green = connected, red = disconnected, grey dash = unknown / rule-type (no serial).
function ConnDot({ connected }: { connected?: boolean | null }) {
  if (connected == null) return <span className="text-cs-muted-2" title="Not applicable / never seen">—</span>
  return (
    <span className="inline-flex items-center gap-1.5" title={connected ? 'Connected now' : 'Not connected'}>
      <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-cs-ok animate-pulse' : 'bg-cs-crit'}`} />
      <span className={`text-xs ${connected ? 'text-cs-ok' : 'text-cs-muted'}`}>{connected ? 'Connected' : 'Offline'}</span>
    </span>
  )
}

export default function UsbDevices() {
  const qc = useQueryClient()
  // Poll so the connected marker stays live as devices are plugged/unplugged.
  const devicesQ = useQuery({ queryKey: ['usb-devices'], queryFn: listDevices, refetchInterval: 15000 })
  const seenQ = useQuery({ queryKey: ['usb-devices-seen'], queryFn: seenDevices, refetchInterval: 15000 })
  const [activitySerial, setActivitySerial] = useState<{ serial: string; name: string } | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['usb-devices'] })
    qc.invalidateQueries({ queryKey: ['usb-devices-seen'] })
  }

  if (devicesQ.isLoading) return <LoadingSpinner size="lg" />
  if (devicesQ.error) return <ErrorMessage message="Failed to load USB devices" retry={() => devicesQ.refetch()} />

  const enforced = devicesQ.data?.enforced
  const allDevices = devicesQ.data?.devices || []
  const allowed = allDevices.filter((d) => d.decision === 'allow')
  const denied = allDevices.filter((d) => d.decision === 'deny')

  const openActivity = (serial?: string | null, name?: string) => {
    if (serial) setActivitySerial({ serial, name: name || serial })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">USB Devices</h1>
        {enforced
          ? <span className="badge badge-success inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Enforcing</span>
          : <span className="badge badge-warning inline-flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" />Not enforced</span>}
      </div>

      <ApproveForm onDone={invalidate} />

      {/* Sanctioned (allow) */}
      <Section title="Sanctioned devices" count={allowed.length}
        subtitle="Allowed when device control is enforced. Click a device to see where it was inserted.">
        {allowed.length === 0 ? (
          <Empty text="No devices approved yet. Approve one above, or from the seen list below." />
        ) : (
          <Table headers={['Match', 'Alias', 'Device', 'VID:PID', 'Status', 'State', 'Approved', '']}>
            {allowed.map((d) => (
              <RegistryRow key={d.id} d={d} onChange={invalidate} onOpenActivity={openActivity} />
            ))}
          </Table>
        )}
      </Section>

      {/* Disallowed (deny) — logged below */}
      <Section title="Disallowed devices" count={denied.length}
        subtitle="Explicitly blocked. A deny overrides any allow (e.g. a whole vendor is allowed but one device is denied).">
        {denied.length === 0 ? (
          <Empty text="No devices have been disallowed. Use “Disallow” on a seen device to block it." />
        ) : (
          <Table headers={['Match', 'Alias', 'Device', 'VID:PID', 'Status', 'State', 'Disallowed', '']}>
            {denied.map((d) => (
              <RegistryRow key={d.id} d={d} onChange={invalidate} onOpenActivity={openActivity} deny />
            ))}
          </Table>
        )}
      </Section>

      {/* Seen but unregistered */}
      <Section
        title="Seen on endpoints — not sanctioned"
        count={seenQ.data?.count || 0}
        subtitle="Devices observed in events that are not on the list. Approve to permit, or Disallow to block."
      >
        {seenQ.isLoading ? (
          <LoadingSpinner />
        ) : (seenQ.data?.devices.length || 0) === 0 ? (
          <Empty text="No unregistered devices have been seen." />
        ) : (
          <Table headers={['Serial', 'Device', 'VID:PID', 'State', 'Last seen', 'Host', '']}>
            {seenQ.data!.devices.map((s) => (
              <SeenRow key={s.serial_number} s={s} onChanged={invalidate} onOpenActivity={openActivity} />
            ))}
          </Table>
        )}
      </Section>

      {activitySerial && (
        <ActivityModal serial={activitySerial.serial} name={activitySerial.name}
          onClose={() => setActivitySerial(null)} />
      )}
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

// Inline click-to-edit alias so a device can be named/renamed any time.
function AliasCell({ d, onChange }: { d: SanctionedDevice; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(d.alias || '')
  const save = useMutation({
    mutationFn: () => updateDevice(d.id, { alias: val.trim() }),
    onSuccess: () => { setEditing(false); onChange(); toast.success('Alias updated') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input autoFocus className="input text-xs py-1 w-32" value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save.mutate(); if (e.key === 'Escape') setEditing(false) }}
          placeholder="Friendly name" />
        <button className="text-cs-emerald" disabled={save.isPending} onClick={() => save.mutate()}><Check className="h-3.5 w-3.5" /></button>
        <button className="text-cs-muted" onClick={() => { setEditing(false); setVal(d.alias || '') }}><X className="h-3.5 w-3.5" /></button>
      </span>
    )
  }
  return (
    <button className="inline-flex items-center gap-1 text-cs-ink-2 hover:text-cs-ink group"
      onClick={() => setEditing(true)} title="Set an alias">
      <span>{d.alias || <span className="text-cs-muted-2 italic">add alias</span>}</span>
      <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
    </button>
  )
}

function RegistryRow({ d, onChange, onOpenActivity, deny }: {
  d: SanctionedDevice; onChange: () => void; onOpenActivity: (s?: string | null, n?: string) => void; deny?: boolean
}) {
  const toggle = useMutation({
    mutationFn: () => updateDevice(d.id, { is_enabled: !d.is_enabled }),
    onSuccess: () => { onChange(); toast.success(d.is_enabled ? 'Suspended' : 'Re-enabled') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Update failed')),
  })
  const revoke = useMutation({
    mutationFn: () => revokeDevice(d.id),
    onSuccess: () => { onChange(); toast.success(deny ? 'Disallow removed' : 'Approval revoked') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Remove failed')),
  })
  const name = d.alias || d.product_name || d.match_value || d.serial_number || 'device'
  const clickable = !!d.serial_number
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 text-cs-ink whitespace-nowrap">
        <span className={`badge ${deny ? 'badge-danger' : 'badge-info'} mr-2`}>{MATCH_LABEL[d.match_type] || d.match_type}</span>
        <span className="num">{d.match_value || d.serial_number || '—'}</span>
      </td>
      <td className="px-3 py-2"><AliasCell d={d} onChange={onChange} /></td>
      <td className="px-3 py-2 text-cs-ink-2">{d.product_name || '—'}{d.manufacturer ? ` (${d.manufacturer})` : ''}</td>
      <td className="px-3 py-2 num text-cs-muted">{vidpid(d.vendor_id, d.product_id)}</td>
      <td className="px-3 py-2">
        {d.is_enabled
          ? <span className={`badge ${deny ? 'badge-danger' : 'badge-success'}`}>{deny ? 'Blocking' : 'Enabled'}</span>
          : <span className="badge badge-warning">Suspended</span>}
      </td>
      <td className="px-3 py-2"><ConnDot connected={d.connected} /></td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(d.approved_at)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {clickable && (
          <button className="text-xs text-cs-indigo hover:underline mr-3 inline-flex items-center gap-1"
            onClick={() => onOpenActivity(d.serial_number, name)} title="Where was it inserted">
            <MapPin className="h-3.5 w-3.5" />Where
          </button>
        )}
        <button className="text-xs text-cs-ink-2 hover:text-cs-ink mr-3 inline-flex items-center gap-1"
          disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {d.is_enabled ? <><Ban className="h-3.5 w-3.5" />Suspend</> : <><Check className="h-3.5 w-3.5" />Enable</>}
        </button>
        <button className="text-xs text-cs-rose hover:underline inline-flex items-center gap-1"
          disabled={revoke.isPending} onClick={() => revoke.mutate()}>
          <Trash2 className="h-3.5 w-3.5" />{deny ? 'Remove' : 'Revoke'}
        </button>
      </td>
    </tr>
  )
}

function SeenRow({ s, onChanged, onOpenActivity }: {
  s: SeenDevice; onChanged: () => void; onOpenActivity: (serial?: string | null, n?: string) => void
}) {
  const base = {
    serial_number: s.serial_number,
    vendor_id: s.vendor_id || undefined,
    product_id: s.product_id || undefined,
    product_name: s.product_name || undefined,
    manufacturer: s.manufacturer || undefined,
  }
  const approve = useMutation({
    mutationFn: () => approveDevice({ ...base, decision: 'allow' }),
    onSuccess: () => { onChanged(); toast.success(`Approved ${s.serial_number}`) },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Approve failed')),
  })
  const disallow = useMutation({
    mutationFn: () => approveDevice({ ...base, match_type: 'serial', decision: 'deny' }),
    onSuccess: () => { onChanged(); toast.success(`Disallowed ${s.serial_number}`) },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Disallow failed')),
  })
  const label = s.product_name || s.serial_number
  return (
    <tr className="border-b border-cs-hair last:border-0">
      <td className="px-3 py-2 num text-cs-ink">{s.serial_number}</td>
      <td className="px-3 py-2 text-cs-ink-2">{s.product_name || '—'}{s.manufacturer ? ` (${s.manufacturer})` : ''}</td>
      <td className="px-3 py-2 num text-cs-muted">{vidpid(s.vendor_id, s.product_id)}</td>
      <td className="px-3 py-2"><ConnDot connected={s.connected} /></td>
      <td className="px-3 py-2 text-cs-muted text-xs">{fmt(s.last_seen)}</td>
      <td className="px-3 py-2 text-cs-muted text-xs">
        <button className="inline-flex items-center gap-1 hover:text-cs-ink"
          onClick={() => onOpenActivity(s.serial_number, label)} title="Where was it inserted">
          <MapPin className="h-3.5 w-3.5" />{s.host || '—'}
        </button>
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <button className="btn btn-secondary btn-sm inline-flex items-center gap-1 mr-2"
          disabled={approve.isPending} onClick={() => approve.mutate()}>
          <Check className="h-3.5 w-3.5" />{approve.isPending ? '…' : 'Approve'}
        </button>
        <button className="btn btn-sm inline-flex items-center gap-1 border border-cs-rose/40 text-cs-rose hover:bg-cs-rose/10"
          disabled={disallow.isPending} onClick={() => disallow.mutate()}>
          <Ban className="h-3.5 w-3.5" />{disallow.isPending ? '…' : 'Disallow'}
        </button>
      </td>
    </tr>
  )
}

function ActivityModal({ serial, name, onClose }: { serial: string; name: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['usb-activity', serial], queryFn: () => getDeviceActivity(serial) })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-cs-card border border-cs-hair bg-cs-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-cs-hair px-4 py-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-cs-indigo" />
            <span className="font-semibold text-cs-ink">Where it was inserted</span>
            <span className="text-xs text-cs-muted num">· {name}</span>
          </div>
          <button className="text-cs-muted hover:text-cs-ink" onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {q.isLoading ? <LoadingSpinner /> : q.error ? (
            <ErrorMessage message="Failed to load activity" retry={() => q.refetch()} />
          ) : (q.data?.count || 0) === 0 ? (
            <p className="text-sm text-cs-muted text-center py-6">No insertion history recorded for this device.</p>
          ) : (
            <Table headers={['Event', 'Host', 'Drive', 'Volume', 'When']}>
              {q.data!.events.map((e, i) => (
                <tr key={i} className="border-b border-cs-hair last:border-0">
                  <td className="px-3 py-2">
                    <span className={`badge ${e.event === 'connect' ? 'badge-success' : 'badge-warning'}`}>
                      {e.event === 'connect' ? 'Inserted' : 'Removed'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-cs-ink-2">{e.host || '—'}</td>
                  <td className="px-3 py-2 num text-cs-ink-2">{e.drive_letter || '—'}</td>
                  <td className="px-3 py-2 text-cs-ink-2">{e.volume_label || '—'}</td>
                  <td className="px-3 py-2 text-cs-muted text-xs">{fmt(e.timestamp)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </div>
  )
}

function ApproveForm({ onDone }: { onDone: () => void }) {
  const [matchType, setMatchType] = useState<UsbMatchType>('serial')
  const [value, setValue] = useState('')
  const [alias, setAlias] = useState('')
  const hint = MATCH_FIELD[matchType]

  // Also populate the natural display field so the tables render the device
  // nicely; device_id "vid:pid" is split into VID/PID.
  const buildBody = () => {
    const v = value.trim()
    const body: Parameters<typeof approveDevice>[0] = {
      match_type: matchType,
      decision: 'allow',
      match_value: v,
      alias: alias.trim() || undefined,
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
    onSuccess: () => { setValue(''); setAlias(''); onDone(); toast.success('Exception approved') },
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
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">{hint.label}</label>
          <input className="input text-sm num" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={hint.placeholder} />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs text-cs-ink-2 mb-1 block">Alias (optional)</label>
          <input className="input text-sm" value={alias} onChange={(e) => setAlias(e.target.value)}
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
