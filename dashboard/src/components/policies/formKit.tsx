'use client'

/**
 * Policy form kit — the shared vocabulary every policy form is built from.
 *
 * WHY THIS EXISTS: the policy forms were written one at a time and drifted into
 * two different design languages. The modal shell and the older forms used raw
 * Tailwind greys for a DARK surface (bg-gray-900, text-white); the newer ones
 * used the product's own light design tokens. The result was a dark modal
 * floating inside a light application, with headings rendered in near-black on
 * near-black — the type selector's own title was invisible.
 *
 * Rather than repair thirteen forms by hand and leave the drift free to happen
 * again, the shapes they all need live here once: a section, a labelled field,
 * a control, a choice card, a chip. Every one is expressed in `cs-*` tokens, so
 * the forms cannot disagree with the application around them.
 *
 * The rule for anything added here: no raw hex, no Tailwind palette colours.
 * If a colour is needed it earns a token first (see styles/tokens.css).
 */

import { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'

/* ── Structure ─────────────────────────────────────────────────────────── */

/**
 * A labelled group of related settings.
 *
 * The eyebrow carries meaning rather than decoration: the sections of a policy
 * answer three different questions — what is this, where does it apply, what
 * does it do — and naming them is what stops a long form reading as one
 * undifferentiated column of inputs. Deliberately not numbered; a policy is not
 * a sequence and pretending otherwise invents an order that isn't there.
 */
export function Section({
  eyebrow,
  title,
  hint,
  children,
  className = '',
}: {
  eyebrow?: string
  title?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      {(eyebrow || title) && (
        <header className="mb-3">
          {eyebrow && (
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
              {eyebrow}
            </div>
          )}
          {title && <h4 className="text-[15px] font-semibold text-cs-ink mt-0.5">{title}</h4>}
          {hint && <p className="text-xs text-cs-muted mt-1 leading-relaxed">{hint}</p>}
        </header>
      )}
      {children}
    </section>
  )
}

/** A white card. The one surface shape in the product; 10px radius, hairline. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-cs-card border border-cs-hair bg-cs-panel ${className}`}>{children}</div>
  )
}

/* ── Fields ────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  required,
  error,
  htmlFor,
  children,
  className = '',
}: {
  label: string
  hint?: ReactNode
  required?: boolean
  error?: string
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="block text-[12.5px] font-medium text-cs-ink-2 mb-1.5"
      >
        {label}
        {required && <span className="text-cs-crit ml-0.5">*</span>}
      </label>
      {children}
      {/* An error replaces the hint rather than stacking under it: two lines of
          guidance where one is now wrong is how a form starts contradicting
          itself. */}
      {error ? (
        <p className="text-[11.5px] text-cs-crit mt-1.5 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-[1px] shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11.5px] text-cs-muted mt-1.5 leading-relaxed">{hint}</p>
      ) : null}
    </div>
  )
}

const controlBase =
  'w-full rounded-cs-sm border bg-cs-panel px-3 py-2 text-[13px] text-cs-ink ' +
  'placeholder:text-cs-muted-2 transition-colors ' +
  'focus:outline-none focus:border-cs-indigo focus:ring-[3px] focus:ring-cs-indigo-faint ' +
  'disabled:bg-cs-panel-2 disabled:text-cs-muted disabled:cursor-not-allowed'

export function TextInput({
  invalid,
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={`${controlBase} ${invalid ? 'border-cs-crit' : 'border-cs-hair'} ${className}`}
    />
  )
}

export function TextArea({
  invalid,
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      className={`${controlBase} resize-none leading-relaxed ${
        invalid ? 'border-cs-crit' : 'border-cs-hair'
      } ${className}`}
    />
  )
}

export function Select({
  className = '',
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${controlBase} border-cs-hair pr-8 ${className}`}>
      {children}
    </select>
  )
}

/* ── Choices ───────────────────────────────────────────────────────────── */

/**
 * A large selectable card, for the two-or-three-way decisions that carry real
 * consequence — enforce vs audit, allowlist vs blocklist.
 *
 * These are given weight on purpose. A radio button and a card are the same
 * control, but a policy's mode decides whether it stops someone's work or
 * merely notes it, and that deserves more of the eye than a 13px label.
 */
export function Choice({
  selected,
  onSelect,
  icon,
  title,
  children,
  disabled,
}: {
  selected: boolean
  onSelect: () => void
  icon?: ReactNode
  title: string
  children?: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`text-left rounded-cs-card border p-3.5 transition-all w-full
        focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint
        disabled:opacity-50 disabled:cursor-not-allowed
        ${
          selected
            ? 'border-cs-indigo bg-cs-indigo-faint shadow-[0_1px_2px_rgba(21,23,28,.04)]'
            : 'border-cs-hair bg-cs-panel hover:border-cs-muted-2 hover:bg-cs-panel-2'
        }`}
    >
      <div className="flex items-center gap-2 font-semibold text-[13.5px] text-cs-ink">
        {icon}
        {title}
      </div>
      {children && <p className="text-[11.5px] text-cs-muted mt-1 leading-relaxed">{children}</p>}
    </button>
  )
}

export function ChoiceGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return (
    <div className={`grid gap-2.5 ${cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {children}
    </div>
  )
}

/** A toggleable pill, for multi-select sets (classification levels, channels). */
export function Chip({
  active,
  onClick,
  children,
  tone = 'indigo',
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  tone?: 'indigo' | 'crit'
}) {
  const on =
    tone === 'crit'
      ? 'border-cs-crit bg-cs-crit/10 text-cs-crit'
      : 'border-cs-indigo bg-cs-indigo-faint text-cs-indigo'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-cs-pill border text-[12.5px] font-medium transition-colors
        focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint
        ${active ? on : 'border-cs-hair bg-cs-panel text-cs-ink-2 hover:border-cs-muted-2'}`}
    >
      {children}
    </button>
  )
}

/** A checkbox and its label, as one clickable row. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  id,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  hint?: ReactNode
  id?: string
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-2.5 cursor-pointer group select-none"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[2px] h-[15px] w-[15px] rounded-[4px] border-cs-hair text-cs-indigo
                   focus:ring-[3px] focus:ring-cs-indigo-faint cursor-pointer"
      />
      <span>
        <span className="block text-[13px] text-cs-ink group-hover:text-cs-indigo transition-colors">
          {label}
        </span>
        {hint && <span className="block text-[11.5px] text-cs-muted mt-0.5 leading-relaxed">{hint}</span>}
      </span>
    </label>
  )
}

/* ── Messages ──────────────────────────────────────────────────────────── */

/** Explains what a policy type does, at the top of its form. */
export function Callout({
  icon,
  children,
  tone = 'info',
}: {
  icon?: ReactNode
  children: ReactNode
  tone?: 'info' | 'warn'
}) {
  const warn = tone === 'warn'
  return (
    <div
      className={`rounded-cs-card border p-3.5 flex items-start gap-2.5 ${
        warn ? 'border-cs-med/30 bg-cs-med/[0.06]' : 'border-cs-hair bg-cs-panel-2'
      }`}
    >
      <span className={`shrink-0 mt-[1px] ${warn ? 'text-cs-med' : 'text-cs-indigo'}`}>
        {icon || (warn ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />)}
      </span>
      <div className="text-[12.5px] text-cs-ink-2 leading-relaxed">{children}</div>
    </div>
  )
}

/* ── Action semantics ──────────────────────────────────────────────────── */

export type PolicyAction = 'allow' | 'log' | 'alert' | 'mask' | 'block' | 'quarantine' | 'audit' | 'enforce'

const ACTION_TONE: Record<string, string> = {
  allow: 'text-cs-act-allow',
  log: 'text-cs-act-log',
  alert: 'text-cs-act-alert',
  mask: 'text-cs-act-mask',
  block: 'text-cs-act-block',
  quarantine: 'text-cs-act-block',
  audit: 'text-cs-act-alert',
  enforce: 'text-cs-act-block',
}

/** The one place an action's colour is decided, so it reads the same everywhere. */
export function actionTone(action?: string) {
  return ACTION_TONE[String(action || '').toLowerCase()] || 'text-cs-muted'
}

export function ActionBadge({ action }: { action?: string }) {
  const a = String(action || 'log').toLowerCase()
  return (
    <span
      className={`inline-flex items-center rounded-cs-pill border border-current/25 px-2 py-0.5
                  text-[11px] font-semibold uppercase tracking-[0.04em] ${actionTone(a)}`}
    >
      {a}
    </span>
  )
}
