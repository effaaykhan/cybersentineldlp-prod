'use client'

import { MessageSquare, Eye, ShieldAlert, Ban } from 'lucide-react'
import { MessagingAppControlConfig } from '@/types/policy'

interface Props {
  config: MessagingAppControlConfig
  onChange: (config: MessagingAppControlConfig) => void
}

function toList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}
function fromList(list?: string[]): string {
  return (list || []).join(', ')
}

const DEFAULT_APPS =
  'teams.exe, ms-teams.exe, whatsapp.exe, telegram.exe, slack.exe, discord.exe, signal.exe'

export default function MessagingAppControlForm({ config, onChange }: Props) {
  const action = config.action || 'alert'
  const exceptions = config.exceptions || {}

  const setExc = (key: keyof NonNullable<MessagingAppControlConfig['exceptions']>, value: string) =>
    onChange({ ...config, exceptions: { ...exceptions, [key]: toList(value) } })

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <MessageSquare className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Inspects files attached in <strong>messaging / thick-client apps</strong> (Teams, WhatsApp,
          Telegram, Slack, Discord, Signal). The endpoint agent reads and classifies the file
          <em> before</em> the app encrypts it, so pinned TLS clients are covered without breaking them.
          Only <strong>Confidential / Restricted</strong> attachments trigger a match. Drag-and-drop
          into the window is not covered — only files chosen through the app’s file picker.
        </p>
      </div>

      {/* Action: alert vs block */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Action on a sensitive attachment</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...config, action: 'alert' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              action === 'alert'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <Eye className="h-4 w-4 text-cs-med" /> Alert (log only)
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Raise an event but let the attachment proceed. Use to validate the rule before enforcing.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onChange({ ...config, action: 'block' })}
            className={`text-left rounded-cs-card border p-4 transition ${
              action === 'block'
                ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint'
                : 'border-cs-hair bg-cs-panel hover:border-cs-hair-2'
            }`}
          >
            <div className="flex items-center gap-2 font-semibold text-cs-ink">
              <ShieldAlert className="h-4 w-4 text-cs-crit" /> Block (close the app)
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Terminate the messaging app to stop the upload. Disruptive — only enable after auditing.
            </p>
          </button>
        </div>
      </div>

      {/* Managed apps */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block flex items-center gap-2">
          <Ban className="h-4 w-4 text-cs-med" /> Managed apps
        </label>
        <input
          defaultValue={fromList(config.apps)}
          onChange={(e) => onChange({ ...config, apps: toList(e.target.value) })}
          placeholder={DEFAULT_APPS}
          className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
        />
        <p className="text-xs text-cs-muted mt-1">
          Executable names, comma or newline separated. Leave empty to use the built-in set
          ({DEFAULT_APPS}).
        </p>
      </div>

      {/* Exceptions */}
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 space-y-3">
        <p className="text-sm font-semibold text-cs-ink">Exceptions (never inspected)</p>
        <div className="grid gap-3 sm:grid-cols-2">
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
            <label className="text-xs font-medium text-cs-ink-2 mb-1 block">File types</label>
            <input
              defaultValue={fromList(exceptions.file_types)}
              onChange={(e) => setExc('file_types', e.target.value)}
              placeholder="png, jpg, gif"
              className="w-full rounded-cs-input border border-cs-hair bg-cs-bg px-3 py-2 text-sm text-cs-ink placeholder:text-cs-muted"
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-cs-muted">
        Endpoint agent only (Windows). Any single exception match skips inspection for that attachment.
      </p>
    </div>
  )
}
