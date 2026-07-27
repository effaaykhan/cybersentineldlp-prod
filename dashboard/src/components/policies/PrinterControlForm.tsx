'use client'

import { Printer, ShieldCheck, ShieldAlert, Network, Cable, Ban, ListChecks } from 'lucide-react'
import { PrinterControlConfig } from '@/types/policy'

interface Props {
  config: PrinterControlConfig
  onChange: (config: PrinterControlConfig) => void
}

const SCOPES: Array<{ value: PrinterControlConfig['scope']; label: string; desc: string; icon: typeof Ban }> = [
  { value: 'allowlist', label: 'Allowlist (only sanctioned printers)', icon: ListChecks,
    desc: 'Allow only printers on the sanctioned list (Enforce → Printers); cancel jobs to any other printer. Most granular.' },
  { value: 'block_network', label: 'Block network printers', icon: Network,
    desc: 'Block printing to shared / IP network printers; allow local (directly-attached) printers.' },
  { value: 'block_all', label: 'Block all printing', icon: Ban,
    desc: 'Cancel every print job on the endpoint, local and network.' },
  { value: 'block_local', label: 'Block local printers', icon: Cable,
    desc: 'Block printing to local (USB/LPT) printers; allow network printers.' },
]

export default function PrinterControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'enforce'
  const scope = config.scope || 'block_network'
  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Printer className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Controls <strong>which printers an endpoint may use</strong>. In enforce mode the agent
          cancels print jobs that match the selected scope. This is the device layer — blocking
          <em> sensitive documents</em> from printing is handled separately by print monitoring and is
          unaffected.
        </p>
      </div>

      {/* Scope */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">What to block</label>
        <div className="space-y-2">
          {SCOPES.map((s) => {
            const Icon = s.icon
            const active = scope === s.value
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => onChange({ ...config, scope: s.value })}
                className={`w-full text-left rounded-cs-card border p-3 transition flex items-start gap-3 ${
                  active
                    ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                    : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
                }`}
              >
                <Icon className={`h-4 w-4 mt-0.5 ${active ? 'text-cs-indigo' : 'text-cs-ink-2'}`} />
                <div>
                  <div className="font-medium text-cs-ink">{s.label}</div>
                  <div className="text-xs text-cs-ink-2 mt-0.5">{s.desc}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Mode */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Enforcement mode</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'enforce' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'enforce'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <ShieldCheck className="h-4 w-4 text-cs-emerald" /> Enforce
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">Cancel matching print jobs. Recommended for production.</p>
          </button>

          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'audit' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'audit'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <ShieldAlert className="h-4 w-4 text-cs-med" /> Audit
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">Log which print jobs <em>would</em> be blocked, without cancelling. Use to roll out safely.</p>
          </button>
        </div>
      </div>
    </div>
  )
}
