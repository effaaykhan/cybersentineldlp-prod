'use client'

/**
 * The one overlay in the product.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * There were nineteen hand-rolled dialogs, and every one re-decided the scrim
 * (eight different blacks), the panel surface (white, token-white, and two
 * flavours of dark inside a light app), the radius (four), and — the part that
 * actually broke — how the thing scrolls.
 *
 * The common mistake was putting `max-h-[90vh] overflow-y-auto` on the PANEL.
 * That makes the whole dialog one scrolling box, so its title scrolls away and
 * its buttons scroll away with it. The policy creator tried to rescue that with
 * `sticky` header and footer but never capped the panel's height, so the panel
 * ran off the bottom of the screen: the footer floated over the form, form rows
 * were sliced in half behind it, and more content carried on BELOW it. That is
 * the "overlapping" — it was one missing height constraint.
 *
 * ── The structure ────────────────────────────────────────────────────────
 * A dialog is three bands, and only the middle one moves:
 *
 *     ┌───────────────────────┐
 *     │ header    (shrink-0)  │  what am I looking at
 *     ├───────────────────────┤
 *     │ body   (flex-1,       │  the work  ← the only scroller
 *     │         min-h-0,      │
 *     │         overflow-y)   │
 *     ├───────────────────────┤
 *     │ footer    (shrink-0)  │  what I am about to commit to
 *     └───────────────────────┘
 *
 * The panel is `max-h-full` inside a padded flex container pinned to the
 * viewport, so it can never exceed the screen; the body is the only element
 * allowed to overflow. Bands cannot overlap the body because they are siblings
 * in a column, not layers — `sticky` is not used anywhere.
 *
 * That is not just tidier. In a DLP console the footer holds the button that
 * decides whether a colleague's file gets blocked, and it should never be
 * somewhere you have to go looking for.
 *
 * ── Motion ───────────────────────────────────────────────────────────────
 * Opening a dialog is the only animated gesture in the application. The scrim
 * washes in, the panel rises a few pixels and settles — it comes from the page,
 * because it is a continuation of the row you clicked, not a new context. Out
 * is faster than in. Nothing else here moves: in an operational tool, ambient
 * motion is noise.
 */

import {
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/* The open dialogs, innermost last. Escape is handled at the document so it
   works even when focus is somewhere unexpected, and only the top of the stack
   responds — otherwise one keypress would close a dialog and the dialog behind
   it at the same time. */
const stack: Array<() => void> = []

/* Nested/stacked dialogs must not each fight over body scroll, so the lock is
   counted rather than set and unset. */
let scrollLocks = 0
function lockScroll() {
  if (scrollLocks++ === 0) {
    const bar = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    // Compensating for the scrollbar keeps the page behind from jolting
    // sideways as it disappears — the jolt is what makes a dialog feel cheap.
    if (bar > 0) document.body.style.paddingRight = `${bar}px`
  }
}
function unlockScroll() {
  if (--scrollLocks <= 0) {
    scrollLocks = 0
    document.body.style.overflow = ''
    document.body.style.paddingRight = ''
  }
}

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-6xl',
} as const

export type ModalSize = keyof typeof SIZES

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  open: boolean
  onClose: () => void
  size?: ModalSize
  /** Rendered in the fixed top band. Use `<ModalHeader/>` for the usual shape. */
  header?: ReactNode
  /** Rendered in the fixed bottom band. Omit when there is nothing to commit to. */
  footer?: ReactNode
  children: ReactNode
  /** Accessible name, when no `<ModalHeader title>` supplies one. */
  label?: string
  /** Set false for dialogs where a stray click must not discard work. */
  closeOnBackdrop?: boolean
  /** Selector for the control that should receive focus on open. */
  initialFocus?: string
  /** Extra classes for the body band (e.g. `p-0` for a flush table). */
  bodyClassName?: string
  className?: string
}

export default function Modal({
  open,
  onClose,
  size = 'lg',
  header,
  footer,
  children,
  label,
  closeOnBackdrop = true,
  initialFocus,
  bodyClassName = 'px-6 py-5',
  className = '',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  // Kept mounted for the length of the exit animation, so closing is a gesture
  // rather than a disappearance.
  const [present, setPresent] = useState(open)
  const [leaving, setLeaving] = useState(false)

  // Whether content is currently hidden above/below the fold. The bands show a
  // divider only when there is genuinely something behind them — it is a fact
  // about the content, not a decoration.
  const [atTop, setAtTop] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (open) {
      setPresent(true)
      setLeaving(false)
      return
    }
    if (!present) return
    setLeaving(true)
    const t = setTimeout(() => {
      setPresent(false)
      setLeaving(false)
    }, 130) // --cs-dur-out
    return () => clearTimeout(t)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Scroll lock, focus restoration and Escape, for as long as the dialog is on
     screen. */
  useEffect(() => {
    if (!present) return
    lockScroll()
    restoreRef.current = document.activeElement as HTMLElement

    const close = () => onCloseRef.current()
    stack.push(close)
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most dialog reacts, and only if something else has not
      // already handled the key (a native <select> popup, for instance).
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (stack[stack.length - 1] !== close) return
      e.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      const i = stack.indexOf(close)
      if (i >= 0) stack.splice(i, 1)
      unlockScroll()
      // Returning focus to whatever opened the dialog is what keeps keyboard
      // users from being dumped back at the top of the page.
      restoreRef.current?.focus?.()
    }
  }, [present])

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return
    const panel = panelRef.current
    const target =
      (initialFocus && panel.querySelector<HTMLElement>(initialFocus)) ||
      // Deliberately not `querySelector(FOCUSABLE)`: that returns DOM order,
      // which in a dialog is the close button. Focus belongs on the first
      // thing you are meant to fill in.
      panel.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),select:not([disabled])') ||
      panel
    // rAF so the entrance animation is not interrupted by a scroll-into-view.
    requestAnimationFrame(() => target.focus({ preventScroll: true } as any))
  }, [open, initialFocus])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [],
  )

  const measure = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    setAtTop(el.scrollTop <= 1)
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
  }, [])

  useEffect(() => {
    if (!present) return
    measure()
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [present, measure, children])

  if (!present || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6
                  bg-cs-scrim backdrop-blur-[2px]
                  ${leaving ? 'cs-scrim-out' : 'animate-cs-scrim-in'}`}
      onMouseDown={(e) => {
        // mousedown, not click: a click that STARTED inside the panel (a drag
        // that ended on the scrim, e.g. selecting text in a field) must not
        // throw the dialog away.
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label ? undefined : titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-full w-full flex-col overflow-hidden outline-none
                    rounded-cs-card border border-cs-hair bg-cs-panel shadow-modal
                    ${SIZES[size]} ${leaving ? 'cs-panel-out' : 'animate-cs-panel-in'} ${className}`}
      >
        {header && (
          <div
            id={titleId}
            className={`shrink-0 px-6 py-4 transition-shadow ${
              atTop ? '' : 'border-b border-cs-hair shadow-[0_1px_0_rgba(21,23,28,0.04)]'
            }`}
          >
            {header}
          </div>
        )}

        <div
          ref={bodyRef}
          onScroll={measure}
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin ${bodyClassName}`}
        >
          {children}
        </div>

        {footer && (
          <div
            className={`shrink-0 px-6 py-4 ${
              atEnd ? 'border-t border-cs-hair-2' : 'border-t border-cs-hair'
            }`}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The usual header: a small label saying what KIND of thing this is, the thing's
 * own name, and the way out.
 *
 * The eyebrow is not decoration — a dialog reached from six different places
 * needs to say which one you are in, and the title alone rarely does.
 */
export function ModalHeader({
  eyebrow,
  title,
  hint,
  onClose,
  children,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  hint?: ReactNode
  onClose?: () => void
  children?: ReactNode
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
              {eyebrow}
            </div>
          )}
          <h3 className="mt-0.5 truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">
            {title}
          </h3>
          {hint && <p className="mt-1 text-[12.5px] leading-relaxed text-cs-muted">{hint}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors
                       hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
      {children}
    </>
  )
}

/** Right-aligned commit row: secondary actions left, the decision on the right. */
export function ModalFooter({
  children,
  left,
}: {
  children: ReactNode
  left?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      {left}
      <div className="flex-1" />
      {children}
    </div>
  )
}

/**
 * "Are you sure?" — the second most common overlay in the product, and the one
 * most worth getting right.
 *
 * Every page had rolled its own, and they all made the same two mistakes: the
 * button said "Confirm" (which tells you nothing about what is about to happen)
 * and the destructive action looked exactly like the safe one. Here the button
 * says the verb — "Remove agent", "Revoke access" — so the last thing you read
 * before clicking is what clicking does, and `tone="danger"` is what makes it
 * red. Focus lands on Cancel: the safe option should be the one your hands are
 * already on.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  tone = 'danger',
  busy,
  children,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  children: ReactNode
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="sm"
      label={title}
      header={<ModalHeader title={title} onClose={busy ? undefined : onClose} />}
      footer={
        <ModalFooter>
          <button onClick={onClose} disabled={busy} className="btn btn-ghost" data-confirm-cancel>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </ModalFooter>
      }
      initialFocus="[data-confirm-cancel]"
    >
      <div className="text-[13px] leading-relaxed text-cs-ink-2">{children}</div>
    </Modal>
  )
}

/**
 * A drop-in replacement for `window.confirm`, shaped so call sites barely
 * change:
 *
 *     const { confirm, dialog } = useConfirm()
 *     …
 *     if (await confirm({ title: 'Delete this rule?', confirmLabel: 'Delete rule' })) remove()
 *     …
 *     {dialog}
 *
 * Ten destructive actions across the console were guarded by the browser's own
 * confirm(). That dialog belongs to Chrome, not to this product: it cannot say
 * what will actually happen, it renders the app's carefully-worded warning as a
 * grey wall of text with the URL above it, and its buttons are always "OK" and
 * "Cancel" — so the last word a person reads before deleting an audit trail is
 * "OK". It also blocks the whole renderer while it is open.
 */
export function useConfirm() {
  const [state, setState] = useState<
    | (Omit<Parameters<typeof ConfirmDialog>[0], 'open' | 'onClose' | 'onConfirm'> & {
        resolve: (v: boolean) => void
      })
    | null
  >(null)

  const confirm = useCallback(
    (opts: {
      title: string
      children: ReactNode
      confirmLabel: string
      tone?: 'danger' | 'primary'
    }) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  )

  const settle = (v: boolean) => {
    state?.resolve(v)
    setState(null)
  }

  const dialog = state ? (
    <ConfirmDialog
      open
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={state.title}
      confirmLabel={state.confirmLabel}
      tone={state.tone}
    >
      {state.children}
    </ConfirmDialog>
  ) : null

  return { confirm, dialog }
}
