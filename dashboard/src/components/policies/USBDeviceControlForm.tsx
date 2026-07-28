'use client'

import { ShieldCheck, ShieldAlert, Usb, Pencil, Lock } from 'lucide-react'
import { USBDeviceControlConfig } from '@/types/policy'

interface Props {
  config: USBDeviceControlConfig
  onChange: (config: USBDeviceControlConfig) => void
}

export default function USBDeviceControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'enforce'
  const accessMode = config.access_mode || 'read_write'
  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Usb className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Strict allowlist (default-deny): while this policy is active, only USB storage devices on
          the <strong>sanctioned list</strong> (USB Devices page, matched by serial number) are
          allowed — every other device is blocked. Manage the allowlist under{' '}
          <span className="num">Enforce → USB Devices</span>.
        </p>
      </div>

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
            <p className="text-xs text-cs-ink-2 mt-1">
              Block unsanctioned devices outright. Recommended for production.
            </p>
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
            <p className="text-xs text-cs-ink-2 mt-1">
              Allow all devices but log which unsanctioned ones <em>would</em> be blocked. Use to roll
              out safely before enforcing.
            </p>
          </button>
        </div>
      </div>

      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">USB storage access</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...config, access_mode: 'read_write' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              accessMode === 'read_write'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <Pencil className="h-4 w-4 text-cs-indigo" /> Read &amp; write
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Allowed devices work normally (read and write).
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChange({ ...config, access_mode: 'read_only' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              accessMode === 'read_only'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <Lock className="h-4 w-4 text-cs-med" /> Read-only
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              USB storage mounts but writes are blocked — users can read files, not copy data out.
              Applies to all removable storage on the endpoint.
            </p>
          </button>
        </div>
      </div>

      <p className="text-xs text-cs-muted">
        The endpoint agent enforces the decision on connect; content inspection of files copied to a
        sanctioned device continues to apply. Read-only takes effect when a device is (re)connected.
      </p>
    </div>
  )
}
