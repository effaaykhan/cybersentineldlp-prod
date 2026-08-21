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

// whatsapp.root.exe is the current WhatsApp for Windows (a WebView2 app whose
// window belongs to WhatsApp.Root.exe); whatsapp.exe covers older builds. Keep
// in step with _DEFAULT_MESSAGING_APPS on the server.
const DEFAULT_APPS =
  'teams.exe, ms-teams.exe, whatsapp.exe, whatsapp.root.exe, telegram.exe, slack.exe, discord.exe, signal.exe'

// The detector types the endpoint classifier can report for a typed message,
// strongest first. Mirrors NetworkExfilMonitor::KnownDataTypes() on the agent
// and _MESSAGING_DATA_TYPES on the server; all three lists have to agree.
const MESSAGE_DATA_TYPES: { id: string; name: string; example: string }[] = [
  { id: 'CREDIT_CARD',     name: 'Credit card',       example: '4111 1111 1111 1111 (Luhn-checked)' },
  { id: 'AADHAAR',         name: 'Aadhaar',           example: '1234 5678 9012' },
  { id: 'PAN',             name: 'PAN',               example: 'ABCDE1234F' },
  { id: 'SSN',             name: 'US SSN',            example: '123-45-6789' },
  { id: 'INDIAN_PASSPORT', name: 'Indian passport',   example: 'A1234567' },
  { id: 'AWS_KEY',         name: 'AWS access key',    example: 'AKIA…' },
  { id: 'PRIVATE_KEY',     name: 'Private key',       example: '-----BEGIN PRIVATE KEY-----' },
  { id: 'JWT_TOKEN',       name: 'JWT / bearer token', example: 'eyJhbGciOi…' },
  { id: 'IFSC',            name: 'IFSC code',         example: 'HDFC0001234' },
  { id: 'UPI_ID',          name: 'UPI ID',            example: 'name@okhdfcbank' },
  { id: 'INDIAN_PHONE',    name: 'Indian mobile',     example: '+91 98765 43210' },
]

// Matches the server's _DEFAULT_MESSAGE_DATA_TYPES. A phone number is the most
// ordinary thing anyone sends over a chat app, so it starts unticked; an
// operator who wants it can say so.
const DEFAULT_MESSAGE_DATA_TYPES = MESSAGE_DATA_TYPES
  .map((t) => t.id)
  .filter((id) => id !== 'INDIAN_PHONE')

export default function MessagingAppControlForm({ config, onChange }: Props) {
  const action = config.action || 'alert'
  const inspectMessages = !!config.inspect_messages
  const exceptions = config.exceptions || {}

  // Undefined means "never chosen" and takes the same default the server
  // applies; an explicit [] is a real choice and stays empty.
  const dataTypes = config.message_data_types ?? DEFAULT_MESSAGE_DATA_TYPES
  const allSelected = dataTypes.length === MESSAGE_DATA_TYPES.length

  const toggleDataType = (id: string) =>
    onChange({
      ...config,
      message_data_types: dataTypes.includes(id)
        ? dataTypes.filter((t) => t !== id)
        : [...dataTypes, id],
    })

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
                  Alert the agent never touches the keyboard: it samples the message box while the
                  app is in front and records what was sent, so a message typed and sent inside the
                  same half-second can be missed. Block reads the box at the moment of sending and
                  has no such gap.
                </span>
              </p>
            )}
          </div>
        </label>

        {/* Which detections count. Separate from the attachment path on purpose:
            the same finding means different things in a file and in a chat box. */}
        {inspectMessages && (
          <div className="mt-4 border-t border-cs-hair pt-4">
            <div className="flex items-center justify-between gap-3 mb-2">
              <label className="text-sm font-semibold text-cs-ink">
                Data types that make a message sensitive
              </label>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...config,
                    message_data_types: allSelected ? [] : MESSAGE_DATA_TYPES.map((t) => t.id),
                  })
                }
                className="text-xs font-medium text-cs-indigo hover:underline shrink-0"
              >
                {allSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <p className="text-xs text-cs-muted mb-3">
              Applies to typed messages only — attachments keep the blanket
              Confidential / Restricted rule. <strong>Indian mobile</strong> is off by default:
              a phone number is the most ordinary thing anyone sends over a chat app, and
              blocking on it stops most normal conversation.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {MESSAGE_DATA_TYPES.map((t) => {
                const isSelected = dataTypes.includes(t.id)
                return (
                  <div
                    key={t.id}
                    onClick={() => toggleDataType(t.id)}
                    className={`p-3 rounded-cs-sm border-2 cursor-pointer transition-all ${
                      isSelected
                        ? 'border-cs-indigo bg-cs-indigo-faint'
                        : 'border-cs-hair bg-cs-panel-2 hover:border-cs-hair-2'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        className="mt-1 h-4 w-4 shrink-0 accent-[var(--cs-indigo)]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-cs-ink">{t.name}</div>
                        <div className="text-xs mt-1 font-mono text-cs-muted truncate">{t.example}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {dataTypes.length === 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-cs-high">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                <span>
                  Nothing selected — typed-message inspection is off. Attachment control is
                  unaffected and still applies.
                </span>
              </p>
            )}
          </div>
        )}
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
