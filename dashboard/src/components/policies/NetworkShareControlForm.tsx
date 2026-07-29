'use client'

import { FolderInput, Ban, ScanText } from 'lucide-react'
import { NetworkShareControlConfig } from '@/types/policy'

interface Props {
  config: NetworkShareControlConfig
  onChange: (config: NetworkShareControlConfig) => void
}

function toList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}
function fromList(list?: string[]): string {
  return (list || []).join(', ')
}

export default function NetworkShareControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'block_all'
  const exceptions = config.exceptions || {}

  const setExc = (key: keyof NonNullable<NetworkShareControlConfig['exceptions']>, value: string) =>
    onChange({ ...config, exceptions: { ...exceptions, [key]: toList(value) } })

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <FolderInput className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Controls copying files to <strong>network file shares</strong> (mapped network drives, e.g.
          <span className="num"> Z:</span> → <span className="num">\\server\share</span>). Anything matched by an
          exception below is always allowed.
        </p>
      </div>

      {/* Mode */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">What to block</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'block_all' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'block_all'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <Ban className="h-4 w-4 text-cs-med" /> Block all transfers
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Block every file copied to a network share, regardless of content. Exceptions still allowed.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChange({ ...config, mode: 'content_aware' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              mode === 'content_aware'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <ScanText className="h-4 w-4 text-cs-emerald" /> Only sensitive files
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Allow copies, but inspect content and block only Confidential / Restricted files.
            </p>
          </button>
        </div>
      </div>

      {/* Exceptions */}
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 space-y-3">
        <p className="text-sm font-semibold text-cs-ink">Exceptions (always allowed)</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Shares / servers</label>
            <input
              defaultValue={fromList(exceptions.shares)}
              onChange={(e) => setExc('shares', e.target.value)}
              placeholder="\\fileserver\public"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Users / groups</label>
            <input
              defaultValue={fromList(exceptions.users)}
              onChange={(e) => setExc('users', e.target.value)}
              placeholder="DOMAIN\\admin"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">Source paths / folders</label>
            <input
              defaultValue={fromList(exceptions.paths)}
              onChange={(e) => setExc('paths', e.target.value)}
              placeholder="C:\\Public\\"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">File types</label>
            <input
              defaultValue={fromList(exceptions.file_types)}
              onChange={(e) => setExc('file_types', e.target.value)}
              placeholder="txt, log"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-cs-muted">
        The endpoint agent watches mapped network drives and enforces on copy. Applies to mapped network drives;
        direct \\server\share paths used without a mapped drive letter are not covered. Any single exception
        match allows the transfer.
      </p>
    </div>
  )
}
