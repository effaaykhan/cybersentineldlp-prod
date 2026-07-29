'use client'

import { Bluetooth, ShieldCheck, ShieldAlert, Headphones, Share2 } from 'lucide-react'
import { WirelessTransferControlConfig } from '@/types/policy'

interface Props {
  config: WirelessTransferControlConfig
  onChange: (config: WirelessTransferControlConfig) => void
}

export default function WirelessTransferControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'enforce'
  const blockBt = config.block_bluetooth_file_transfer !== false
  const blockNearby = config.block_nearby_sharing !== false

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Headphones className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Blocks <strong>file transfer</strong> over Bluetooth and Wi-Fi Direct / Nearby Sharing to stop data
          leaving wirelessly. <strong>Audio devices (headphones), keyboards and mice keep working</strong> — only
          the file-transfer profiles are disabled.
        </p>
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
            <p className="text-xs text-cs-ink-2 mt-1">
              Apply the disables on the endpoint. Recommended for production.
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
              Log what would be blocked without applying it. Use to roll out safely.
            </p>
          </button>
        </div>
      </div>

      {/* Channels to block */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Block these channels</label>
        <div className="space-y-3">
          <label className="flex items-start gap-3 rounded-cs-card border border-cs-hair bg-cs-panel p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={blockBt}
              onChange={(e) => onChange({ ...config, block_bluetooth_file_transfer: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-cs-indigo"
            />
            <span>
              <span className="flex items-center gap-2 font-semibold text-cs-ink">
                <Bluetooth className="h-4 w-4 text-cs-indigo" /> Bluetooth file transfer
              </span>
              <span className="block text-xs text-cs-ink-2 mt-1">
                Disables the Bluetooth Object Push / File Transfer profiles. Audio and input devices are unaffected.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 rounded-cs-card border border-cs-hair bg-cs-panel p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={blockNearby}
              onChange={(e) => onChange({ ...config, block_nearby_sharing: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-cs-indigo"
            />
            <span>
              <span className="flex items-center gap-2 font-semibold text-cs-ink">
                <Share2 className="h-4 w-4 text-cs-indigo" /> Wi-Fi Direct / Nearby Sharing
              </span>
              <span className="block text-xs text-cs-ink-2 mt-1">
                Disables Windows Nearby Sharing and Wi-Fi Direct peer-to-peer file drops.
              </span>
            </span>
          </label>
        </div>
      </div>

      <p className="text-xs text-cs-muted">
        The endpoint agent applies these at the OS level and re-checks each sync, so turning the policy off
        restores the channels. Takes effect on the next Bluetooth connection / after the agent applies it.
      </p>
    </div>
  )
}
