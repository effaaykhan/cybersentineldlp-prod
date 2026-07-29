'use client'

import { AppWindow, ShieldCheck, Ban } from 'lucide-react'
import { ApplicationControlConfig } from '@/types/policy'

interface Props {
  config: ApplicationControlConfig
  onChange: (config: ApplicationControlConfig) => void
}

const CHANNELS = [
  { id: 'usb', label: 'Copy to USB' },
  { id: 'network', label: 'Network upload' },
  { id: 'email', label: 'Email send' },
  { id: 'print', label: 'Print' },
  { id: 'cloud', label: 'Cloud upload' },
]

// Comma / newline separated text <-> string[]
function toList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}
function fromList(list?: string[]): string {
  return (list || []).join(', ')
}

export default function ApplicationControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'allowlist'
  const channels = config.channels || []
  const exceptions = config.exceptions || {}

  const setExc = (key: keyof NonNullable<ApplicationControlConfig['exceptions']>, value: string) =>
    onChange({ ...config, exceptions: { ...exceptions, [key]: toList(value) } })

  const toggleChannel = (id: string) => {
    const next = channels.includes(id) ? channels.filter((c) => c !== id) : [...channels, id]
    onChange({ ...config, channels: next })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <AppWindow className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Allow or block a file action based on the <strong>application performing it</strong>. Name the
          applications by their executable (e.g. <span className="num">chrome.exe</span>). Anything matched by
          an exception below is always allowed.
        </p>
      </div>

      {/* Mode */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Rule</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'allowlist' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'allowlist'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <ShieldCheck className="h-4 w-4 text-cs-emerald" /> Allow only these apps
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Only the listed applications may perform the action. Every other app is blocked.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'blocklist' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'blocklist'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <Ban className="h-4 w-4 text-cs-med" /> Block these apps
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              The listed applications are blocked from the action. Every other app is allowed.
            </p>
          </button>
        </div>
      </div>

      {/* Managed applications */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-1 block">
          {mode === 'allowlist' ? 'Allowed applications' : 'Blocked applications'}
        </label>
        <textarea
          rows={2}
          value={fromList(config.applications)}
          onChange={(e) => onChange({ ...config, applications: toList(e.target.value) })}
          placeholder="chrome.exe, MyLineOfBusinessApp.exe"
          className="w-full rounded-cs-input border border-cs-hair bg-cs-panel px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
        />
        <p className="text-xs text-cs-muted mt-1">Executable names, comma or line separated. Case-insensitive.</p>
      </div>

      {/* Channels */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Applies to</label>
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((c) => {
            const on = channels.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleChannel(c.id)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  on
                    ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint text-cs-ink'
                    : 'border-cs-hair bg-cs-panel text-cs-ink-2 hover:border-cs-hair-2'
                }`}
              >
                {c.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-cs-muted mt-1">Leave all unselected to apply to every action.</p>
      </div>

      {/* Exceptions */}
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 space-y-3">
        <p className="text-sm font-semibold text-cs-ink">Exceptions (always allowed)</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Applications</label>
            <input
              value={fromList(exceptions.applications)}
              onChange={(e) => setExc('applications', e.target.value)}
              placeholder="viewer.exe"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Users / groups</label>
            <input
              value={fromList(exceptions.users)}
              onChange={(e) => setExc('users', e.target.value)}
              placeholder="DOMAIN\\admin"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Paths / destinations</label>
            <input
              value={fromList(exceptions.paths)}
              onChange={(e) => setExc('paths', e.target.value)}
              placeholder="C:\\Public\\"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">File types</label>
            <input
              value={fromList(exceptions.file_types)}
              onChange={(e) => setExc('file_types', e.target.value)}
              placeholder="txt, log"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-cs-muted">
        The endpoint agent decides on the action using the app performing it, the current user, the file path
        and its type. Any single exception match allows the action.
      </p>
    </div>
  )
}
