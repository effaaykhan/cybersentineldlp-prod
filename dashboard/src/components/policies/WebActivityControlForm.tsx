'use client'

import { useEffect, useState } from 'react'
import { Globe, ShieldCheck, ShieldAlert, Plus, X, Sparkles, AlertTriangle } from 'lucide-react'
import {
  WebActivityControlConfig,
  WebActivityCategory,
  WebActivity,
  WebActivityAction,
  WebActivityCell,
  WebActivityOverride,
} from '@/types/policy'
import apiClient from '@/lib/api'

interface Props {
  config: WebActivityControlConfig
  onChange: (config: WebActivityControlConfig) => void
}

const CATEGORIES: Array<{ value: WebActivityCategory; label: string; hint: string }> = [
  { value: 'webmail', label: 'Webmail', hint: 'Gmail, Outlook Web, Yahoo, Proton, Zoho' },
  { value: 'cloud_storage', label: 'Cloud storage', hint: 'Drive, OneDrive, Dropbox, Box, WeTransfer' },
  { value: 'collaboration', label: 'Collaboration', hint: 'Slack, Teams, Discord, WhatsApp Web, Notion' },
  { value: 'genai', label: 'Generative AI', hint: 'ChatGPT, Claude, Gemini, Copilot, Perplexity' },
]

// `short` is what the column header shows: the full label is the sentence an
// operator reads elsewhere, but as a header it made the table wider than the
// panel and clipped the last column off the right edge.
const ACTIVITIES: Array<{ value: WebActivity; label: string; short: string }> = [
  { value: 'upload', label: 'Upload', short: 'Upload' },
  { value: 'download', label: 'Download', short: 'Download' },
  { value: 'attach', label: 'Attach', short: 'Attach' },
  { value: 'send', label: 'Send', short: 'Send' },
  { value: 'post', label: 'Post / Generate', short: 'Post' },
  { value: 'ai_response', label: 'AI Response', short: 'AI reply' },
]

/*
  Send and Post are the same gesture.

  Both are "the user submitted what they composed" — the guard reads one field,
  `profile.activity`, and webmail profiles set it to send while every other
  profile sets it to post. No category offers both, so as two columns the matrix
  showed one that was empty for every row but Webmail, beside one that was empty
  for Webmail alone.

  The two names are kept in the data because they are worth having in an event
  and a SIEM record — "sent an email" and "submitted a prompt" are not the same
  sentence to read at 3am — but they are one decision to make, so they are one
  column here. The column writes whichever name that category actually uses.
*/
const SUBMIT_ACTIVITIES: WebActivity[] = ['send', 'post']

/** The columns actually drawn: the submit pair collapsed into one. */
const COLUMNS: Array<{ key: string; label: string; short: string; activities: WebActivity[] }> = [
  { key: 'upload', label: 'Upload', short: 'Upload', activities: ['upload'] },
  { key: 'download', label: 'Download', short: 'Download', activities: ['download'] },
  { key: 'attach', label: 'Attach', short: 'Attach', activities: ['attach'] },
  { key: 'submit', label: 'Send / Post', short: 'Send / Post', activities: SUBMIT_ACTIVITIES },
  { key: 'ai_response', label: 'AI Response', short: 'AI reply', activities: ['ai_response'] },
]

// Which activities are meaningful for which category. Mirrors
// server/app/core/web_activity.py CATEGORY_ACTIVITIES — a cell outside this map
// is ignored server-side, so offering it would be offering a control that
// silently does nothing.
const CATEGORY_ACTIVITIES: Record<WebActivityCategory, WebActivity[]> = {
  webmail: ['upload', 'download', 'attach', 'send'],
  cloud_storage: ['upload', 'download', 'post'],
  collaboration: ['upload', 'download', 'post'],
  genai: ['upload', 'download', 'attach', 'post', 'ai_response'],
}

const ACTIONS: Array<{ value: WebActivityAction; label: string; cls: string }> = [
  { value: 'allow', label: 'Allow', cls: 'text-cs-ink-2' },
  { value: 'log', label: 'Log', cls: 'text-cs-indigo' },
  { value: 'alert', label: 'Alert', cls: 'text-cs-med' },
  { value: 'mask', label: 'Redact', cls: 'text-cs-high' },
  { value: 'block', label: 'Block', cls: 'text-cs-crit' },
]

/*
  Which actions each activity can actually PERFORM. Mirrors
  app/core/web_activity.ACTIVITY_ACTIONS and the extension's policy.js.

  Redact is offered on Post alone, because Post is the only activity that is a
  single box of prose the endpoint can rewrite. A file cannot be redacted on its
  way out (Upload, Attach); a download never passes through the extension at all
  — the browser writes it straight to disk; webmail's Send splits its text
  across a subject and a body, which one redacted string cannot be put back
  into; and an AI reply can be withheld but rewriting the model's answer in the
  page is a different feature.

  Offering an action that cannot be carried out is worse than not offering it:
  the operator believes it is armed and the endpoint quietly does something
  else. The server clamps anything that slips through anyway — upward, so an
  un-redactable Redact becomes a Block.
*/
const ACTIVITY_ACTIONS: Record<WebActivity, WebActivityAction[]> = {
  upload: ['allow', 'log', 'alert', 'block'],
  download: ['allow', 'log', 'alert', 'block'],
  attach: ['allow', 'log', 'alert', 'block'],
  send: ['allow', 'log', 'alert', 'block'],
  post: ['allow', 'log', 'alert', 'mask', 'block'],
  ai_response: ['allow', 'log', 'alert', 'block'],
}

/** Activities whose content the endpoint never sees, so a threshold cannot apply. */
const ACTIVITIES_WITHOUT_CONTENT: WebActivity[] = ['download']

const actionsFor = (a: WebActivity) => ACTIONS.filter((x) => ACTIVITY_ACTIONS[a].includes(x.value))

const LEVELS = ['', 'Internal', 'Confidential', 'Restricted']

function cellAction(cell: WebActivityAction | WebActivityCell | undefined): WebActivityAction {
  if (!cell) return 'allow'
  return typeof cell === 'object' ? cell.action : cell
}

function cellMinLevel(cell: WebActivityAction | WebActivityCell | undefined): string {
  return cell && typeof cell === 'object' ? cell.minLevel || '' : ''
}

// Mirrors app/core/web_activity.ACTION_RANK and policy.js.
const ACTION_RANK: Record<WebActivityAction, number> = { allow: 0, log: 1, alert: 2, mask: 3, block: 4 }

/**
 * Stamp the policy's headline action onto the config.
 *
 * The policy list shows one action badge per policy, resolved from
 * `config.action` first and the backend `actions` dict second. This type's
 * backend actions are deliberately always `{log}` — the matrix is the decider,
 * and emitting `block` there made the generic evaluator block activities the
 * matrix only wanted logged. That fix left the badge reading "log" for a policy
 * that blocks GenAI outright, which is worse than useless in a list an operator
 * scans to see what is enforced. Deriving it here keeps the badge honest without
 * putting a second decider back into the pipeline.
 */
function withDerivedAction(next: WebActivityControlConfig): WebActivityControlConfig {
  const seen: WebActivityAction[] = ['allow']
  for (const row of Object.values(next.matrix || {})) {
    for (const cell of Object.values(row || {})) seen.push(cellAction(cell))
  }
  for (const o of next.appOverrides || []) seen.push(o.action)

  let strongest = seen.reduce((best, a) => (ACTION_RANK[a] > ACTION_RANK[best] ? a : best))
  // Audit never advertises block, because it never blocks.
  if ((next.mode || 'enforce') === 'audit' && strongest === 'block') strongest = 'alert'
  return { ...next, action: strongest === 'allow' ? 'log' : strongest }
}

export default function WebActivityControlForm({ config, onChange: rawOnChange }: Props) {
  const onChange = (next: WebActivityControlConfig) => rawOnChange(withDerivedAction(next))

  const mode = config.mode || 'enforce'
  const matrix = config.matrix || {}

  // Is any activity ruled whose content the endpoint can never see? Only then
  // is the threshold caveat worth showing — an unused warning is noise.
  const ruledWithoutContent = ACTIVITIES_WITHOUT_CONTENT.some((act) =>
    Object.values(matrix).some((row: any) => {
      const cell = row?.[act]
      const a = typeof cell === 'object' ? cell?.action : cell
      return a && a !== 'allow'
    }),
  )
  const overrides = config.appOverrides || []
  const blockUninspectable = config.blockUninspectable !== false

  // The catalog drives the per-app exception picker. Fetched rather than
  // hardcoded for the same reason the catalog is a table at all: an operator who
  // adds a GenAI vendor this morning must be able to write an exception for it
  // this afternoon, without a dashboard release.
  const [apps, setApps] = useState<Array<{ app_id: string; app_name: string; category: string }>>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)

  useEffect(() => {
    apiClient
      .get('/app-catalog/', { params: { include_disabled: false } })
      .then(({ data }) => {
        const seen = new Set<string>()
        const unique: Array<{ app_id: string; app_name: string; category: string }> = []
        for (const e of data.entries || []) {
          if (seen.has(e.app_id)) continue
          seen.add(e.app_id)
          unique.push({ app_id: e.app_id, app_name: e.app_name, category: e.category })
        }
        unique.sort((a, b) => a.app_name.localeCompare(b.app_name))
        setApps(unique)
      })
      .catch(() => setCatalogError('Could not load the app catalog — exceptions must be typed by hand.'))
  }, [])

  const setCell = (category: WebActivityCategory, activity: WebActivity, action: WebActivityAction) => {
    const row = { ...(matrix[category] || {}) }
    const existingMin = cellMinLevel(row[activity])
    if (action === 'allow') {
      delete row[activity]
    } else if (existingMin) {
      row[activity] = { action, minLevel: existingMin }
    } else {
      row[activity] = action
    }
    const next = { ...matrix, [category]: row }
    if (Object.keys(row).length === 0) delete next[category]
    onChange({ ...config, matrix: next })
  }

  const setRow = (category: WebActivityCategory, action: WebActivityAction) => {
    const row: Record<string, WebActivityAction> = {}
    if (action !== 'allow') {
      for (const a of CATEGORY_ACTIVITIES[category]) row[a] = action
    }
    const next = { ...matrix, [category]: row }
    if (Object.keys(row).length === 0) delete next[category]
    onChange({ ...config, matrix: next })
  }

  const addOverride = () => {
    onChange({
      ...config,
      appOverrides: [...overrides, { app_id: '', action: 'allow' } as WebActivityOverride],
    })
  }

  const updateOverride = (index: number, patch: Partial<WebActivityOverride>) => {
    const next = overrides.map((o, i) => (i === index ? { ...o, ...patch } : o))
    onChange({ ...config, appOverrides: next })
  }

  const removeOverride = (index: number) => {
    onChange({ ...config, appOverrides: overrides.filter((_, i) => i !== index) })
  }

  const ruledCells = Object.values(matrix).reduce(
    (sum, row) => sum + Object.values(row || {}).filter((c) => cellAction(c) !== 'allow').length,
    0,
  )

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Globe className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Controls what users may <strong>do</strong> in web applications, not just which sites they can
          reach. Enforced by the CyberSentinel browser extension, which inspects content before it
          leaves — including text inside attached images and PDFs — and asks this server for a verdict.
          <br />
          <span className="text-cs-ink-3">
            An activity left on <strong>Allow</strong> is not intercepted at all: the extension installs
            no hooks for it and the user notices nothing.
          </span>
        </p>
      </div>

      {/* Matrix */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">
          Activity matrix
          <span className="ml-2 text-xs font-normal text-cs-ink-2">
            {ruledCells === 0 ? 'nothing is ruled yet' : `${ruledCells} activities ruled`}
          </span>
        </label>

        <div className="overflow-x-auto rounded-cs-card border border-cs-hair
                        [mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]
                        [@media(hover:hover)]:[mask-image:none]">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="bg-cs-panel-2 border-b border-cs-hair">
                <th className="text-left px-3 py-2 font-semibold text-cs-ink w-[168px]">Category</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="px-2 py-2 font-semibold text-cs-ink text-center whitespace-nowrap">
                    {c.short}
                  </th>
                ))}
                <th className="px-2 py-2 font-semibold text-cs-ink text-center">All</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((cat) => {
                const row = matrix[cat.value] || {}
                return (
                  <tr key={cat.value} className="border-b border-cs-hair last:border-0">
                    <td className="px-3 py-2.5 align-middle">
                      <div className="font-medium text-cs-ink flex items-center gap-1.5 whitespace-nowrap">
                        {cat.value === 'genai' && <Sparkles className="h-3.5 w-3.5 text-cs-indigo shrink-0" />}
                        {cat.label}
                      </div>
                      <div className="text-[11px] text-cs-muted-2 mt-0.5 truncate max-w-[150px]" title={cat.hint}>
                        {cat.hint}
                      </div>
                    </td>

                    {COLUMNS.map((col) => {
                      // A column can stand for more than one activity name
                      // (Send / Post); only one of them is ever meaningful for
                      // a given category, and that is the one this cell edits.
                      const act = col.activities.find((a) =>
                        CATEGORY_ACTIVITIES[cat.value].includes(a),
                      )
                      if (!act) {
                        return (
                          <td key={col.key} className="px-2 py-2 text-center text-cs-muted-2">
                            <span title={`${col.label} does not apply to ${cat.label}`}>—</span>
                          </td>
                        )
                      }
                      const current = cellAction(row[act])
                      return (
                        <td key={col.key} className="px-2 py-2 text-center">
                          <select
                            value={current}
                            aria-label={`${cat.label}: ${ACTIVITIES.find((a) => a.value === act)?.label || act}`}
                            onChange={(e) => setCell(cat.value, act, e.target.value as WebActivityAction)}
                            className={`appearance-none cursor-pointer rounded-cs-sm border border-cs-hair bg-cs-panel
                              bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 5'%3E%3Cpath fill='%239aa0aa' d='M0 0h8L4 5z'/%3E%3C/svg%3E")]
                              bg-[length:7px] bg-[right_6px_center] bg-no-repeat py-1 pl-2 pr-5 text-[11.5px] font-semibold
                              transition-colors hover:border-cs-muted-2 focus:outline-none focus:ring-[3px] focus:ring-cs-indigo-faint ${
                              ACTIONS.find((a) => a.value === current)?.cls || ''
                            }`}
                          >
                            {actionsFor(act).map((a) => (
                              <option key={a.value} value={a.value}>
                                {a.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      )
                    })}

                    <td className="px-2 py-2 text-center">
                      <select
                        value=""
                        aria-label={`Set every activity for ${cat.label}`}
                        onChange={(e) => {
                          if (e.target.value) setRow(cat.value, e.target.value as WebActivityAction)
                        }}
                        className="appearance-none cursor-pointer rounded-cs-sm border border-cs-hair bg-cs-panel py-1 px-2
                                   text-[11.5px] text-cs-muted transition-colors hover:border-cs-muted-2 hover:text-cs-ink-2
                                   focus:outline-none focus:ring-[3px] focus:ring-cs-indigo-faint"
                      >
                        <option value="">Set…</option>
                        {/* Only actions every activity in this row can perform —
                            otherwise "set the whole row to Redact" would quietly
                            mean something different in each column. */}
                        {ACTIONS.filter((a) =>
                          CATEGORY_ACTIVITIES[cat.value].every((act) =>
                            ACTIVITY_ACTIONS[act].includes(a.value),
                          ),
                        ).map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed text-cs-muted">
          <p>
            <strong className="text-cs-ink-2">Post</strong> and{' '}
            <strong className="text-cs-ink-2">Attach</strong> are what stop data reaching an AI
            vendor. On <span className="font-semibold text-cs-act-block">Block</span> the prompt is
            held in the browser, inspected, and only released if it is clean — it never leaves the
            machine.
          </p>
          <p>
            <span className="font-semibold text-cs-act-mask">Redact</span> is offered on Post alone,
            because Post is the only activity that is a single box of prose the endpoint can rewrite.
            Sensitive values are replaced with placeholders — <code className="rounded bg-cs-panel-2 px-1">[AADHAAR_1]</code> —
            and the person is told what was replaced. If a value cannot be located, or the message
            carries an attachment, it is blocked instead.
          </p>
          <p>
            <strong className="text-cs-ink-2">AI Response</strong> is the reply coming back. On{' '}
            <span className="font-semibold text-cs-act-block">Block</span> it is masked while it
            streams and shown only once it has been checked, so a reply that carries sensitive data
            is never read. It cannot un-send the prompt — that is what Post and Attach are for — and
            it costs a short pause before each answer appears.
          </p>
        </div>
      </div>

      {/* Threshold */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Act on content classified</label>
        <select
          value={config.minLevel || ''}
          onChange={(e) => onChange({ ...config, minLevel: e.target.value || undefined })}
          className="bg-cs-panel border border-cs-hair rounded-cs-sm px-3 py-2 text-sm text-cs-ink w-full sm:w-auto"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l ? `${l} and above` : 'Any content (no threshold)'}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-cs-muted mt-1 leading-relaxed">
          With no threshold, a ruled activity is acted on regardless of what it contains — which is how
          &ldquo;no Generative AI at all&rdquo; is written. With one, ordinary work passes and only
          sensitive content is stopped.
        </p>
        {config.minLevel && ruledWithoutContent && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-cs-med">
            <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span>
              This threshold does not apply to <strong>Download</strong>. The browser writes a
              download straight to disk, so the extension never sees the bytes and has nothing to
              classify — a ruled download is matched on the app alone. The endpoint agent inspects
              the file afterwards, on the filesystem.
            </span>
          </p>
        )}
      </div>

      {/* Per-app exceptions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-cs-ink">Per-app exceptions</label>
          <button
            type="button"
            onClick={addOverride}
            className="flex items-center gap-1 text-xs text-cs-indigo hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add exception
          </button>
        </div>

        {catalogError && <p className="text-xs text-cs-med mb-2">{catalogError}</p>}

        {overrides.length === 0 ? (
          <p className="text-xs text-cs-ink-3">
            None. Exceptions beat the matrix row, so this is where &ldquo;Generative AI is blocked,
            except the Copilot we pay for&rdquo; goes.
          </p>
        ) : (
          <div className="space-y-2">
            {overrides.map((o, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-cs-sm border border-cs-hair bg-cs-panel p-2"
              >
                <select
                  value={o.app_id || ''}
                  onChange={(e) => updateOverride(i, { app_id: e.target.value })}
                  className="bg-cs-panel-2 border border-cs-hair rounded-cs-sm px-2 py-1 text-xs text-cs-ink"
                >
                  <option value="">Any app in…</option>
                  {apps.map((a) => (
                    <option key={a.app_id} value={a.app_id}>
                      {a.app_name}
                    </option>
                  ))}
                </select>

                <select
                  value={o.category || ''}
                  onChange={(e) =>
                    updateOverride(i, { category: (e.target.value || undefined) as WebActivityCategory })
                  }
                  className="bg-cs-panel-2 border border-cs-hair rounded-cs-sm px-2 py-1 text-xs text-cs-ink"
                >
                  <option value="">any category</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>

                <select
                  value={o.activity || ''}
                  onChange={(e) =>
                    updateOverride(i, { activity: (e.target.value || undefined) as WebActivity })
                  }
                  className="bg-cs-panel-2 border border-cs-hair rounded-cs-sm px-2 py-1 text-xs text-cs-ink"
                >
                  <option value="">any activity</option>
                  {ACTIVITIES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>

                <span className="text-xs text-cs-ink-2">→</span>

                <select
                  value={o.action}
                  onChange={(e) => updateOverride(i, { action: e.target.value as WebActivityAction })}
                  className={`bg-cs-panel-2 border border-cs-hair rounded-cs-sm px-2 py-1 text-xs font-medium ${
                    ACTIONS.find((a) => a.value === o.action)?.cls || ''
                  }`}
                >
                  {ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => removeOverride(i)}
                  className="ml-auto text-cs-ink-3 hover:text-cs-crit"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Uninspectable */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={blockUninspectable}
          onChange={(e) => onChange({ ...config, blockUninspectable: e.target.checked })}
          className="mt-0.5"
        />
        <span className="text-sm text-cs-ink">
          Treat content that cannot be inspected as meeting the threshold
          <span className="block text-[11px] text-cs-ink-3">
            Password-protected archives and unreadable documents classify as Public, so without this the
            simplest way past a threshold rule is to zip the file with a password.
          </span>
        </span>
      </label>

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
              Stop the activities set to Block. The user sees an on-page notice explaining why.
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
              Record what <em>would</em> have been blocked without stopping anyone. Use this first — a
              matrix that is too aggressive is much better discovered from a report.
            </p>
          </button>
        </div>
      </div>
    </div>
  )
}
