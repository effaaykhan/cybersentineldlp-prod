'use client'

import { MessageSquare, Eye, ShieldAlert, Ban, AlertTriangle } from 'lucide-react'
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
  const inspectMessages = !!config.inspect_messages
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
          Only <strong>Confidential / Restricted</strong> attachments trigger a match.
        </p>
      </div>

      {/* Typed messages — the surface that actually carries most chat leaks. */}
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--cs-indigo)]"
            checked={inspectMessages}
            onChange={(e) => onChange({ ...config, inspect_messages: e.target.checked })}
          />
          <div className="text-sm text-cs-ink-2">
            <span className="font-semibold text-cs-ink">Also inspect typed messages</span>
            <p className="mt-1">
              Covers text typed or pasted straight into the chat box — not just attached files.
              The agent briefly holds the <kbd className="rounded border border-cs-hair bg-cs-panel-2 px-1 text-[11px]">Enter</kbd> key,
              classifies what is in the box, and releases it if the message is clean. The pause is
              a few milliseconds.
            </p>
            {inspectMessages && action !== 'block' && (
              <p className="mt-2 flex items-start gap-1.5 text-cs-high">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                <span>
                  Set the action to <strong>Block</strong> below for this to stop anything. On
                  Alert the agent never touches the keyboard, so messages are recorded but still sent.
                </span>
              </p>
            )}
          </div>
        </label>
      </div>

      {/* Remaining gaps, stated plainly. An operator who believes a control covers
          more than it does will not go looking for the hole. */}
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel-2 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-cs-med shrink-0 mt-0.5" />
        <div className="text-sm text-cs-ink-2">
          <p className="font-semibold text-cs-ink mb-1">Not covered</p>
          <ul className="ml-4 list-disc space-y-0.5">
            <li>Sending by <strong>clicking the send button</strong> instead of pressing Enter.</li>
            <li><strong>Drag-and-drop</strong> of a file onto the window — it bypasses the file picker.</li>
            <li>Pasted <strong>images</strong>, which never touch the file system.</li>
          </ul>
          <p className="mt-1.5">
            For the browser clients — WhatsApp Web, Teams on the web — the <strong>Web Activity</strong> policy
            covers the send itself and can block or redact it.
          </p>
        </div>
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
              A sensitive <em>attachment</em> closes the app — the file is already inside a pinned
              TLS session, so ending the process is the only lever left. A sensitive <em>typed
              message</em> is simply not sent, and the app keeps running. Only Block enforces;
              enable after auditing.
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
