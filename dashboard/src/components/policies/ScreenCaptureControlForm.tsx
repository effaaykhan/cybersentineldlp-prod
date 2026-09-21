'use client'

import { Camera, ShieldCheck, ShieldAlert, Ban, Eye } from 'lucide-react'
import { ScreenCaptureControlConfig } from '@/types/policy'

interface Props {
  config: ScreenCaptureControlConfig
  onChange: (config: ScreenCaptureControlConfig) => void
}

type Level = 'Public' | 'Internal' | 'Confidential' | 'Restricted'
const LEVELS: Level[] = ['Public', 'Internal', 'Confidential', 'Restricted']

function toList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}
function fromList(list?: string[]): string {
  return (list || []).join(', ')
}

// Keep in step with _DEFAULT_CAPTURE_TOOLS on the server and CAPTURE_PROCESSES
// in the agent — all three lists have to agree or an operator sees one thing
// and the endpoint watches another.
const DEFAULT_TOOLS =
  'snippingtool.exe, screenclippinghost.exe, screensketch.exe, greenshot.exe, sharex.exe, ' +
  'lightshot.exe, snagit32.exe, snagit.exe, obs64.exe, obs32.exe, camtasiastudio.exe, ' +
  'bandicam.exe, screentogif.exe, flameshot.exe, picpick.exe, faststone.exe'

export default function ScreenCaptureControlForm({ config, onChange }: Props) {
  const mode = config.mode || 'enforce'
  const action = config.action || 'alert'
  const levels = config.levels || ['Confidential', 'Restricted']
  const exceptions = config.exceptions || {}

  // Undefined means "never chosen" and takes the server's default; an explicit
  // false is a real choice and stays off.
  const flag = (k: keyof ScreenCaptureControlConfig, dflt: boolean) =>
    config[k] === undefined ? dflt : !!config[k]

  const blockKeyboard = flag('block_keyboard', true)
  const blockTools = flag('block_capture_tools', true)
  const terminateTools = flag('terminate_tools', true)
  const clearClipboard = flag('clear_clipboard', true)
  const notifyUser = flag('notify_user', true)

  // Everything that actually withholds something is inert unless the policy is
  // both enforcing and set to block. Showing those toggles as live in audit or
  // alert mode would promise enforcement the endpoint will not perform.
  const suppresses = mode === 'enforce' && action === 'block'

  const toggleLevel = (lvl: Level) => {
    const next = levels.includes(lvl) ? levels.filter((l) => l !== lvl) : [...levels, lvl]
    onChange({ ...config, levels: next })
  }

  const Toggle = ({
    label, hint, checked, disabled, onToggle,
  }: { label: string; hint: string; checked: boolean; disabled?: boolean; onToggle: () => void }) => (
    <label
      className={`flex items-start gap-3 rounded-cs-card border border-cs-hair bg-cs-panel p-3 ${
        disabled ? 'opacity-50' : 'cursor-pointer hover:border-cs-hair-2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={onToggle}
        className="mt-0.5 accent-[var(--cs-indigo)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-cs-ink">{label}</span>
        <span className="block text-xs text-cs-ink-2 mt-0.5">{hint}</span>
      </span>
    </label>
  )

  return (
    <div className="space-y-4">
      <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-4 flex items-start gap-3">
        <Camera className="h-5 w-5 text-cs-indigo shrink-0 mt-0.5" />
        <p className="text-sm text-cs-ink-2">
          Controls screen capture while classified content is on screen. The endpoint classifies the
          foreground window (title plus on-screen OCR) and, at the levels you select, can withhold{' '}
          <strong>PrintScreen</strong>, <strong>Alt+PrintScreen</strong> and{' '}
          <strong>Win+Shift+S</strong>, and watch for screen-capture applications.
          <br />
          <span className="text-xs">
            Until this policy is active the endpoint does not enforce screen capture at all, and the
            on-screen OCR pass does not run.
          </span>
        </p>
      </div>

      {/* Levels */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">
          Treat the screen as sensitive at these levels
        </label>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map((lvl) => {
            const active = levels.includes(lvl)
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                className={`px-4 py-2 rounded-cs-sm border text-sm font-medium transition ${
                  active
                    ? 'border-[color-mix(in_srgb,var(--cs-indigo)_45%,var(--cs-panel))] bg-cs-indigo-faint text-cs-indigo'
                    : 'border-cs-hair bg-cs-panel text-cs-ink-2 hover:border-cs-hair-2'
                }`}
              >
                {lvl}
              </button>
            )
          })}
        </div>
        {levels.length === 0 && (
          <p className="text-xs text-cs-crit mt-1">
            No levels selected — nothing will be enforced. Select at least one.
          </p>
        )}
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
            <p className="text-xs text-cs-ink-2 mt-1">Act on the settings below.</p>
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
              Record what <em>would</em> be blocked. Nothing on screen changes.
            </p>
          </button>
        </div>
      </div>

      {/* Action */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">When the screen is sensitive</label>
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
              <Eye className="h-4 w-4 text-cs-med" /> Alert
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">
              Raise an event; the user still gets their screenshot.
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
              <Ban className="h-4 w-4 text-cs-crit" /> Block
            </div>
            <p className="text-xs text-cs-ink-2 mt-1">Withhold the capture so no screenshot is taken.</p>
          </button>
        </div>
        {mode === 'audit' && action === 'block' && (
          <p className="text-xs text-cs-med mt-2">
            Audit mode overrides this — nothing will actually be blocked until you switch to Enforce.
          </p>
        )}
      </div>

      {/* Controls */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-2 block">Controls</label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle
            label="Intercept capture keys"
            hint="PrintScreen, Alt+PrintScreen and Win+Shift+S."
            checked={blockKeyboard}
            disabled={!suppresses}
            onToggle={() => onChange({ ...config, block_keyboard: !blockKeyboard })}
          />
          <Toggle
            label="Watch capture applications"
            hint="Detect the tools listed below while they run."
            checked={blockTools}
            onToggle={() => onChange({ ...config, block_capture_tools: !blockTools })}
          />
          <Toggle
            label="Terminate capture applications"
            hint="Close the tool, rather than only recording it."
            checked={terminateTools}
            disabled={!suppresses || !blockTools}
            onToggle={() => onChange({ ...config, terminate_tools: !terminateTools })}
          />
          <Toggle
            label="Clear the clipboard"
            hint="Wipe the clipboard after a blocked capture."
            checked={clearClipboard}
            disabled={!suppresses}
            onToggle={() => onChange({ ...config, clear_clipboard: !clearClipboard })}
          />
          <Toggle
            label="Tell the user"
            hint="Show a notice on the endpoint when a capture is stopped."
            checked={notifyUser}
            onToggle={() => onChange({ ...config, notify_user: !notifyUser })}
          />
        </div>
        {!suppresses && (
          <p className="text-xs text-cs-ink-2 mt-2">
            The greyed-out controls withhold something, so they apply only when the policy is set to
            Enforce + Block.
          </p>
        )}
      </div>

      {/* Tools */}
      <div>
        <label className="text-sm font-semibold text-cs-ink mb-1 block">Capture applications</label>
        <p className="text-xs text-cs-ink-2 mb-2">
          Executable names, comma or newline separated. Leave empty for the built-in list.
        </p>
        <textarea
          rows={3}
          value={fromList(config.tools)}
          placeholder={DEFAULT_TOOLS}
          onChange={(e) => onChange({ ...config, tools: toList(e.target.value) })}
          className="w-full rounded-cs-sm border border-cs-hair bg-cs-panel p-2.5 text-sm text-cs-ink placeholder:text-cs-muted-2"
        />
      </div>

      {/* Exceptions */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-sm font-semibold text-cs-ink mb-1 block">Exempt users</label>
          <input
            type="text"
            value={fromList(exceptions.users)}
            placeholder="e.g. helpdesk, trainer"
            onChange={(e) =>
              onChange({ ...config, exceptions: { ...exceptions, users: toList(e.target.value) } })
            }
            className="w-full rounded-cs-sm border border-cs-hair bg-cs-panel p-2.5 text-sm text-cs-ink placeholder:text-cs-muted-2"
          />
        </div>
        <div>
          <label className="text-sm font-semibold text-cs-ink mb-1 block">Exempt applications</label>
          <p className="sr-only">Foreground apps never treated as sensitive</p>
          <input
            type="text"
            value={fromList(exceptions.processes)}
            placeholder="e.g. code.exe, devenv.exe"
            onChange={(e) =>
              onChange({
                ...config,
                exceptions: { ...exceptions, processes: toList(e.target.value) },
              })
            }
            className="w-full rounded-cs-sm border border-cs-hair bg-cs-panel p-2.5 text-sm text-cs-ink placeholder:text-cs-muted-2"
          />
        </div>
      </div>
    </div>
  )
}
