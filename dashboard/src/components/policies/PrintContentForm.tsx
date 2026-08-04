'use client'

import { Printer, ShieldCheck, ShieldAlert } from 'lucide-react'
import { PrintContentConfig } from '@/types/policy'
import FileIdentityDenylist from './FileIdentityDenylist'

interface Props {
  config: PrintContentConfig
  onChange: (config: PrintContentConfig) => void
}

const LEVELS = ['Internal', 'Confidential', 'Restricted']

export default function PrintContentForm({ config, onChange }: Props) {
  const mode = config.mode || 'enforce'
  const levels = config.levels || ['Confidential', 'Restricted']

  const toggleLevel = (lvl: string) => {
    const next = levels.includes(lvl) ? levels.filter((l) => l !== lvl) : [...levels, lvl]
    onChange({ ...config, levels: next })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Printer className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Inspects the <strong>actual content</strong> of documents sent to any printer. When the
          document classifies at one of the selected levels, the print job is cancelled (enforce) or
          just logged (audit). Uses the same classification engine as USB file transfers.
        </p>
      </div>

      {/* Levels */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Act on these classification levels</label>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((lvl) => {
            const active = levels.includes(lvl)
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                className={`px-4 py-2 rounded-cs-sm border text-sm font-medium transition ${
                  active
                    ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint text-cs-indigo'
                    : 'border-cs-hair bg-cs-panel text-cs-ink-2 hover:border-cs-hair-2'
                }`}
              >
                {lvl}
              </button>
            )
          })}
        </div>
        {levels.length === 0 && (
          <p className="text-xs text-cs-crit mt-1">Select at least one level.</p>
        )}
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
            <p className="text-xs text-cs-ink-2 mt-1">Cancel print jobs carrying sensitive content. Recommended for production.</p>
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
            <p className="text-xs text-cs-ink-2 mt-1">Log which jobs <em>would</em> be blocked, without cancelling. Use to roll out safely.</p>
          </button>
        </div>
      </div>

      <FileIdentityDenylist config={config} onChange={onChange} />
    </div>
  )
}
