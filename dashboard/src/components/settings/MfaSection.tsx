import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Copy, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  getMfaStatus,
  setupMfa,
  confirmMfa,
  disableMfa,
  type MfaSetup,
} from '@/lib/api'

type Phase = 'loading' | 'disabled' | 'enrolling' | 'showCodes' | 'enabled'

export default function MfaSection() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [enrolledAt, setEnrolledAt] = useState<string | null>(null)
  const [setup, setSetup] = useState<MfaSetup | null>(null)
  const [code, setCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadStatus = async () => {
    try {
      const s = await getMfaStatus()
      setEnrolledAt(s.enrolled_at ?? null)
      setPhase(s.mfa_enabled ? 'enabled' : 'disabled')
    } catch {
      setPhase('disabled')
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  const handleBeginSetup = async () => {
    setBusy(true)
    try {
      const s = await setupMfa()
      setSetup(s)
      setCode('')
      setPhase('enrolling')
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to start MFA setup')
    } finally {
      setBusy(false)
    }
  }

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await confirmMfa(code.trim())
      setRecoveryCodes(res.recovery_codes || [])
      setSetup(null)
      setCode('')
      setPhase('showCodes')
      toast.success('Two-factor authentication enabled')
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Invalid code — please try again')
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await disableMfa(disableCode.trim())
      setDisableCode('')
      toast.success('Two-factor authentication disabled')
      await loadStatus()
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Invalid code — please try again')
    } finally {
      setBusy(false)
    }
  }

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  const enabled = phase === 'enabled'

  return (
    <div className="card">
      <div className="flex items-start gap-3 mb-4">
        <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
          {enabled ? (
            <ShieldCheck className="h-5 w-5 text-cs-ok" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-cs-indigo" />
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="section-title">Two-Factor Authentication</h3>
            {enabled ? (
              <span className="badge badge-success">Enabled</span>
            ) : phase !== 'loading' ? (
              <span className="badge badge-info">Disabled</span>
            ) : null}
          </div>
          <p className="text-sm text-cs-muted">
            Protect your admin account with a time-based one-time code from an authenticator app.
          </p>
        </div>
      </div>

      {phase === 'loading' && (
        <p className="text-sm text-cs-muted">Loading…</p>
      )}

      {/* Not enrolled — offer to begin setup */}
      {phase === 'disabled' && (
        <div className="space-y-3">
          <p className="text-sm text-cs-ink-2">
            Two-factor authentication is optional but strongly recommended for admin accounts.
          </p>
          <button
            onClick={handleBeginSetup}
            disabled={busy}
            className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Preparing…' : 'Enable two-factor authentication'}
          </button>
        </div>
      )}

      {/* Enrolling — scan QR + confirm a code */}
      {phase === 'enrolling' && setup && (
        <form onSubmit={handleConfirm} className="space-y-4">
          <ol className="text-sm text-cs-ink-2 list-decimal list-inside space-y-1">
            <li>Scan the QR code with Google Authenticator, Authy, 1Password, or similar.</li>
            <li>Enter the current 6-digit code below to confirm.</li>
          </ol>
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <div className="bg-white p-3 rounded-cs-sm border border-cs-hair shrink-0">
              <img src={setup.qr_svg} alt="MFA QR code" className="w-40 h-40" />
            </div>
            <div className="flex-1 min-w-0">
              <label className="block text-sm font-medium text-cs-ink-2 mb-1.5">
                Can&apos;t scan? Enter this key manually
              </label>
              <code className="block text-xs break-all bg-cs-hair-2 rounded-cs-sm px-2 py-2 text-cs-ink num">
                {setup.secret}
              </code>
              <label className="block text-sm font-medium text-cs-ink-2 mb-1.5 mt-4">
                Verification code
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                className="input tracking-[0.3em] text-center num max-w-[180px]"
                placeholder="000000"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? 'Verifying…' : 'Verify & enable'}
            </button>
            <button
              type="button"
              onClick={() => { setSetup(null); setPhase('disabled') }}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Recovery codes — shown once, right after enabling */}
      {phase === 'showCodes' && (
        <div className="space-y-3">
          <div className="p-3 rounded-cs-sm border border-[color-mix(in_srgb,var(--cs-warn)_30%,var(--cs-panel))] bg-[color-mix(in_srgb,var(--cs-warn)_10%,var(--cs-panel))]">
            <p className="text-sm font-medium text-cs-ink">Save your backup codes</p>
            <p className="text-sm text-cs-ink-2 mt-0.5">
              Each code works once if you lose access to your authenticator. Store them somewhere safe —
              they won&apos;t be shown again.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 max-w-md">
            {recoveryCodes.map((c) => (
              <code key={c} className="text-sm bg-cs-hair-2 rounded-cs-sm px-3 py-1.5 text-center text-cs-ink num">
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={copyCodes} className="btn-secondary inline-flex items-center gap-2">
              {copied ? <Check className="h-4 w-4 text-cs-ok" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy codes'}
            </button>
            <button onClick={() => setPhase('enabled')} className="btn-primary">
              I&apos;ve saved my codes
            </button>
          </div>
        </div>
      )}

      {/* Enabled — allow disabling with a code */}
      {phase === 'enabled' && (
        <form onSubmit={handleDisable} className="space-y-3">
          <p className="text-sm text-cs-ink-2">
            Two-factor authentication is active on your account
            {enrolledAt ? ` since ${new Date(enrolledAt).toLocaleDateString()}` : ''}.
            To turn it off, confirm with a current code or a backup code.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-1.5">
                Authentication code
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                required
                className="input tracking-[0.3em] text-center num max-w-[180px]"
                placeholder="000000"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="btn-danger disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? 'Disabling…' : 'Disable two-factor'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
