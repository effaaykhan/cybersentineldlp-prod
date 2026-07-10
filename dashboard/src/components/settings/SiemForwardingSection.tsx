import { useEffect, useState } from 'react'
import { Share2, Trash2, Plus, Radio, CheckCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  getSiemConnectors,
  registerSyslogConnector,
  testSiemConnector,
  deleteSiemConnector,
  type SiemConnector,
} from '@/lib/api'

const PROTOCOLS = ['udp', 'tcp', 'tls']
const FORMATS = ['cef', 'leef']
const FACILITIES = ['local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7']
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical']

const DEFAULT_FORM = {
  name: '',
  host: '',
  port: 514,
  protocol: 'udp',
  log_format: 'cef',
  facility: 'local0',
  min_severity: 'low',
}

export default function SiemForwardingSection() {
  const [connectors, setConnectors] = useState<SiemConnector[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ ...DEFAULT_FORM })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)

  const load = async () => {
    try {
      setConnectors(await getSiemConnectors())
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to load SIEM connectors')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await registerSyslogConnector({ ...form, port: Number(form.port) })
      toast.success(`Connector "${form.name}" added`)
      setForm({ ...DEFAULT_FORM })
      await load()
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to add connector')
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async (name: string) => {
    setTesting(name)
    try {
      const res = await testSiemConnector(name)
      if (res?.success) toast.success(res.message || 'Test record sent')
      else toast.error(res?.error || 'Test failed')
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Test failed')
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (name: string) => {
    if (!window.confirm(`Remove SIEM connector "${name}"?`)) return
    try {
      await deleteSiemConnector(name)
      toast.success(`Removed "${name}"`)
      await load()
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to remove connector')
    }
  }

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="card">
      <div className="flex items-start gap-3 mb-4">
        <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
          <Share2 className="h-5 w-5 text-cs-indigo" />
        </div>
        <div className="flex-1">
          <h3 className="section-title">SIEM Log Forwarding</h3>
          <p className="text-sm text-cs-muted">
            Forward DLP events to on-prem or cloud SIEMs over syslog (RFC 5424) with CEF or LEEF
            payloads. Each connector only receives events at or above its severity threshold.
          </p>
        </div>
      </div>

      {/* Existing connectors */}
      {loading ? (
        <p className="text-sm text-cs-muted mb-4">Loading…</p>
      ) : connectors.length === 0 ? (
        <p className="text-sm text-cs-muted mb-4">No SIEM connectors configured yet.</p>
      ) : (
        <div className="overflow-x-auto mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-cs-muted border-b border-cs-hair-2">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Destination</th>
                <th className="py-2 pr-4 font-medium">Transport</th>
                <th className="py-2 pr-4 font-medium">Format</th>
                <th className="py-2 pr-4 font-medium">Min severity</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((c) => (
                <tr key={c.name} className="border-b border-cs-hair-2 last:border-0">
                  <td className="py-2 pr-4 font-medium text-cs-ink">{c.name}</td>
                  <td className="py-2 pr-4 num text-cs-ink-2">
                    {c.host ? `${c.host}:${c.port}` : c.siem_type}
                  </td>
                  <td className="py-2 pr-4 uppercase text-cs-ink-2">{c.protocol || c.siem_type}</td>
                  <td className="py-2 pr-4 uppercase text-cs-ink-2">{c.format || '—'}</td>
                  <td className="py-2 pr-4 capitalize text-cs-ink-2">{c.min_severity || '—'}</td>
                  <td className="py-2 pr-4">
                    {c.connected ? (
                      <span className="badge badge-success">Connected</span>
                    ) : (
                      <span className="badge badge-warning">Down</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleTest(c.name)}
                        disabled={testing === c.name}
                        className="p-1.5 rounded-cs-sm text-cs-muted-2 hover:text-cs-indigo hover:bg-cs-indigo-faint transition-colors disabled:opacity-50"
                        title="Send test record"
                      >
                        <Radio className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(c.name)}
                        className="p-1.5 rounded-cs-sm text-cs-muted-2 hover:text-cs-crit hover:bg-[color-mix(in_srgb,var(--cs-crit)_10%,var(--cs-panel))] transition-colors"
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add syslog connector */}
      <form onSubmit={handleAdd} className="space-y-3 pt-2 border-t border-cs-hair-2">
        <p className="text-sm font-medium text-cs-ink-2 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-cs-indigo" /> Add a syslog connector
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Name</label>
            <input className="input" value={form.name} required
              onChange={(e) => set('name', e.target.value)} placeholder="qradar-prod" />
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Host / IP</label>
            <input className="input num" value={form.host} required
              onChange={(e) => set('host', e.target.value)} placeholder="10.20.0.15" />
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Port</label>
            <input className="input num" type="number" value={form.port} required min={1} max={65535}
              onChange={(e) => set('port', Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Transport</label>
            <select className="input uppercase" value={form.protocol}
              onChange={(e) => set('protocol', e.target.value)}>
              {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Format</label>
            <select className="input uppercase" value={form.log_format}
              onChange={(e) => set('log_format', e.target.value)}>
              {FORMATS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Facility</label>
            <select className="input" value={form.facility}
              onChange={(e) => set('facility', e.target.value)}>
              {FACILITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-cs-muted mb-1">Min severity</label>
            <select className="input capitalize" value={form.min_severity}
              onChange={(e) => set('min_severity', e.target.value)}>
              {SEVERITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <button type="submit" disabled={busy}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
          <Plus className="h-4 w-4" />
          {busy ? 'Adding…' : 'Add connector'}
        </button>
      </form>
    </div>
  )
}
