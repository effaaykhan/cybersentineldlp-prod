'use client'

/**
 * What this policy will do — restated in plain language, live, while it is
 * being written.
 *
 * A DLP policy is not a setting. It is a rule that will silently stop a
 * colleague mid-task: an email that will not send, a file that will not copy, a
 * prompt that will not submit. The form that authors it was a column of inputs
 * that never once said what would happen to anyone, and the only way to find
 * out was to save it and wait for the complaint.
 *
 * So this panel sits beside the form and answers that question continuously.
 * Its last line is the one that matters and is deliberately the most emphatic
 * thing on the surface: whether this policy INTERRUPTS A PERSON or merely
 * records what they did. Everything else here is supporting detail.
 */

import { ReactNode } from 'react'
import { Ban, Bell, Eye, EyeOff, ShieldCheck, Users, Gauge } from 'lucide-react'
import { PolicyType } from '@/types/policy'
import { getPolicyTypeLabel } from '@/utils/policyUtils'

type Draft = {
  policyType: PolicyType | null
  name: string
  severity: string
  enabled: boolean
  agentName?: string | null
  config: any
  classification?: { conditions?: { rules?: any[] }; actions?: Record<string, any> }
}

/** The strongest thing this policy will do, across every shape of config. */
function effectiveAction(d: Draft): 'block' | 'quarantine' | 'mask' | 'alert' | 'log' | 'none' {
  const c = d.config || {}
  const rank: Record<string, number> = { block: 5, quarantine: 4, mask: 3, alert: 2, log: 1 }
  let best = 'none'
  const consider = (a?: string) => {
    const k = String(a || '').toLowerCase()
    if (rank[k] && (best === 'none' || rank[k] > rank[best])) best = k
  }

  consider(c.action)
  // Matrix policies carry an action per cell rather than one for the policy.
  for (const row of Object.values(c.matrix || {}) as any[]) {
    for (const cell of Object.values(row || {}) as any[]) {
      consider(typeof cell === 'object' ? cell?.action : cell)
    }
  }
  for (const o of (c.appOverrides || []) as any[]) consider(o?.action)
  // enforce/audit is a mode, not an action, but it decides whether the action bites.
  if (c.mode === 'enforce' && best === 'none') best = 'block'
  if (c.mode === 'audit') best = best === 'block' ? 'alert' : best
  for (const k of Object.keys(d.classification?.actions || {})) consider(k)
  return best as any
}

/** One sentence describing the rule, specific to the type where it can be. */
function describe(d: Draft): ReactNode {
  const c = d.config || {}
  const type = d.policyType

  if (type === 'web_activity_control') {
    // Grouped BY ACTION rather than by category. Read down a matrix column and
    // the question you are actually asking is "what does this stop?" — one
    // clause per filled cell answered it as a paragraph nobody finishes.
    const LABEL: Record<string, string> = {
      webmail: 'webmail',
      cloud_storage: 'cloud storage',
      collaboration: 'collaboration apps',
      genai: 'generative AI',
    }
    const byAction: Record<string, string[]> = {}
    for (const [cat, row] of Object.entries(c.matrix || {}) as any[]) {
      const acts: Record<string, string[]> = {}
      for (const [act, cell] of Object.entries(row || {}) as any[]) {
        const a = String(typeof cell === 'object' ? cell?.action : cell || '').toLowerCase()
        if (!a || a === 'allow') continue
        ;(acts[a] ||= []).push(act.replace('ai_response', 'AI replies').replace('_', ' '))
      }
      for (const [a, list] of Object.entries(acts)) {
        ;(byAction[a] ||= []).push(`${list.join(', ')} in ${LABEL[cat] || cat}`)
      }
    }

    const order = ['block', 'mask', 'alert', 'log']
    const filled = order.filter((a) => byAction[a]?.length)
    if (!filled.length) return 'Nothing is ruled yet. Every activity is allowed.'

    const VERB: Record<string, string> = {
      block: 'Blocks', mask: 'Redacts', alert: 'Alerts on', log: 'Records',
    }
    const TONE: Record<string, string> = {
      block: 'text-cs-act-block',
      mask: 'text-cs-act-mask',
      alert: 'text-cs-act-alert',
      log: 'text-cs-act-log',
    }
    return (
      <span className="block space-y-1.5">
        {filled.map((a) => (
          <span key={a} className="block">
            <span className={`font-semibold ${TONE[a]}`}>{VERB[a]}</span>{' '}
            <span className="text-cs-ink-2">{byAction[a].join('; ')}</span>
          </span>
        ))}
        <span className="block text-cs-muted text-[12px] pt-0.5">
          {c.minLevel ? `Only when content is ${c.minLevel} or above.` : 'For any content, sensitive or not.'}
        </span>
      </span>
    )
  }

  if (type === 'usb_device_control') {
    const ro = c.access_mode === 'read_only'
    return `Only sanctioned USB storage may be used${ro ? ', and it mounts read-only' : ''}.`
  }
  if (type === 'printer_control') {
    const SCOPE: Record<string, string> = {
      block_all: 'Blocks all printing',
      block_network: 'Blocks network printing',
      block_local: 'Blocks local printing',
      allowlist: 'Allows only sanctioned printers',
    }
    return `${SCOPE[c.scope] || 'Controls printing'}.`
  }
  if (type === 'print_content_prevention') {
    return `Stops printing when the document is ${(c.levels || []).join(' or ') || 'sensitive'}.`
  }
  if (type === 'clipboard_monitoring') {
    const n = (c.patterns?.predefined?.length || 0) + (c.patterns?.custom?.length || 0)
    return n
      ? `Watches the clipboard for ${n} pattern${n === 1 ? '' : 's'}.`
      : 'Watches the clipboard, but no patterns are selected yet.'
  }
  if (type === 'network_exfiltration_prevention') {
    const m = (c.monitoredMethods || []).length
    return m
      ? `Covers ${m} outbound channel${m === 1 ? '' : 's'}.`
      : 'Covers every outbound network channel.'
  }
  if (type === 'wireless_transfer_control') {
    const bits = [c.block_bluetooth_file_transfer && 'Bluetooth file transfer',
                  c.block_nearby_sharing && 'Nearby Sharing'].filter(Boolean)
    return bits.length ? `Blocks ${bits.join(' and ')}.` : 'Nothing is blocked yet.'
  }
  if (type === 'messaging_app_control') {
    const n = (c.apps || []).length
    return `Inspects attachments in ${n ? `${n} managed app${n === 1 ? '' : 's'}` : 'the built-in messaging apps'}.`
  }
  if (type === 'network_share_control') {
    return c.mode === 'block_all'
      ? 'Blocks every copy to a network share.'
      : 'Blocks copies of sensitive files to network shares.'
  }
  if (type === 'application_control') {
    const n = (c.applications || []).length
    return c.mode === 'allowlist'
      ? `Only ${n || 'the listed'} application${n === 1 ? '' : 's'} may perform the covered actions.`
      : `${n || 'The listed'} application${n === 1 ? '' : 's'} may not perform the covered actions.`
  }

  const rules = d.classification?.conditions?.rules?.length || 0
  if (rules) return `Acts when ${rules} condition${rules === 1 ? '' : 's'} match.`
  if (type) return `${getPolicyTypeLabel(type)}.`
  return 'Choose a policy type to begin.'
}

export default function PolicySummary({ draft }: { draft: Draft }) {
  const action = effectiveAction(draft)
  const interrupts = action === 'block' || action === 'quarantine'
  const redacts = action === 'mask'
  const audit = draft.config?.mode === 'audit'

  const Row = ({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) => (
    <div className="flex items-start gap-2.5 py-2 border-t border-cs-hair-2 first:border-0">
      <span className="text-cs-muted-2 mt-[1px] shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-cs-muted-2">
          {label}
        </div>
        <div className="text-[12.5px] text-cs-ink-2 mt-0.5 leading-relaxed break-words">{value}</div>
      </div>
    </div>
  )

  return (
    <aside
      /* self-start so the panel is only as tall as what it says. Without it the
         grid stretches it to the full height of the form and the tinted block
         runs into the footer with its bottom corners cut off. */
      className="self-start rounded-cs-card border border-cs-hair bg-cs-panel-2 p-4 lg:sticky lg:top-4"
      aria-live="polite"
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
        What this policy does
      </div>

      <p className="text-[13.5px] text-cs-ink mt-2 leading-relaxed first-letter:uppercase">
        {describe(draft)}
      </p>

      <div className="mt-3">
        <Row
          icon={<Users className="h-3.5 w-3.5" />}
          label="Applies to"
          value={draft.agentName ? draft.agentName : 'Every agent'}
        />
        <Row
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Severity"
          value={<span className="capitalize">{draft.severity}</span>}
        />
        {!draft.enabled && (
          <Row
            icon={<Eye className="h-3.5 w-3.5" />}
            label="State"
            value="Saved but switched off — it enforces nothing until enabled."
          />
        )}
      </div>

      {/*
        The point of the whole panel. An operator should never discover that a
        policy interrupts people by hearing about it from the people.
      */}
      <div
        className={`mt-3 rounded-cs-sm border p-3 flex items-start gap-2.5 ${
          interrupts && !audit
            ? 'border-cs-crit/30 bg-cs-crit/[0.06]'
            : redacts && !audit
              ? 'border-cs-high/30 bg-cs-high/[0.06]'
              : action === 'none'
                ? 'border-cs-hair bg-cs-panel'
                : 'border-cs-med/30 bg-cs-med/[0.06]'
        }`}
      >
        <span
          className={`shrink-0 mt-[1px] ${
            interrupts && !audit
              ? 'text-cs-crit'
              : redacts && !audit
                ? 'text-cs-high'
                : action === 'none'
                  ? 'text-cs-muted-2'
                  : 'text-cs-med'
          }`}
        >
          {interrupts && !audit ? (
            <Ban className="h-4 w-4" />
          ) : redacts && !audit ? (
            <EyeOff className="h-4 w-4" />
          ) : action === 'none' ? (
            <ShieldCheck className="h-4 w-4" />
          ) : (
            <Bell className="h-4 w-4" />
          )}
        </span>
        <div className="text-[12.5px] leading-relaxed">
          {interrupts && !audit ? (
            <>
              <b className="text-cs-ink">People are stopped.</b>
              <span className="text-cs-ink-2">
                {' '}
                The action fails and they see a notice explaining why.
              </span>
            </>
          ) : redacts && !audit ? (
            <>
              <b className="text-cs-ink">Nobody is stopped — the data is.</b>
              <span className="text-cs-ink-2">
                {' '}
                Sensitive values are replaced with placeholders before the message goes, and the
                person is told what was replaced. If they cannot be located, or the message carries
                an attachment, it is blocked instead.
              </span>
            </>
          ) : audit ? (
            <>
              <b className="text-cs-ink">Nobody is stopped.</b>
              <span className="text-cs-ink-2">
                {' '}
                Audit mode records what would have been blocked.
              </span>
            </>
          ) : action === 'none' ? (
            <span className="text-cs-ink-2">
              Nothing is enforced yet. Finish the rules below to give this policy an effect.
            </span>
          ) : (
            <>
              <b className="text-cs-ink">Nobody is stopped.</b>
              <span className="text-cs-ink-2"> The activity continues and raises an alert.</span>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
