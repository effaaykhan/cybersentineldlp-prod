import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/lib/store/auth'
import { API_URL } from '@/lib/config'
import { AlertTriangle } from 'lucide-react'

/**
 * SSO Callback page — mounted at /auth/sso.
 *
 * The SIEM redirects here with the exchange token. On mount we POST it to the
 * backend /auth/sso/exchange endpoint, which verifies the signature, looks up
 * the user, and returns standard DLP access+refresh tokens. We then decode the
 * access token client-side (base64 parse — no library needed) to populate the
 * auth store and redirect to /dashboard.
 *
 * WHERE THE TOKEN IS READ FROM, AND WHY THE FRAGMENT IS PREFERRED
 * --------------------------------------------------------------
 * A URL fragment (#token=...) is never transmitted to a server. A query string
 * (?token=...) is, and so it is written verbatim into the dashboard's nginx
 * access log by the default log format — which is a live credential sitting in
 * a log file that gets rotated, shipped and retained long after the token's
 * two-minute life. It also lands in browser history and in the Referer header
 * of anything the page loads afterwards.
 *
 * So the fragment is read first and the query string is accepted as a
 * fallback, which keeps an issuer that already redirects with ?token= working
 * unchanged while giving it a strictly better option to move to.
 *
 * Either way the token is stripped from the address bar before the exchange is
 * attempted: it is single-use, so what is left behind is only useful to
 * someone reading over a shoulder or a synced history, never to the user.
 */

/** Decode a JWT payload WITHOUT verifying the signature (client-side only). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Malformed JWT')
    // Base64url → base64 → decode
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export default function SSOCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { setTokens } = useAuthStore()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Fragment first (never leaves the browser), query string as the fallback.
    const fragment = new URLSearchParams(
      window.location.hash.replace(/^#/, '')
    ).get('token')
    const exchangeToken = fragment || searchParams.get('token')
    if (!exchangeToken) {
      setError('Missing SSO token in URL')
      return
    }

    // Scrub it from the address bar before doing anything with it, so it is
    // not left in history or handed to a Referer on the next navigation.
    if (fragment || searchParams.get('token')) {
      window.history.replaceState(null, '', window.location.pathname)
    }

    let cancelled = false

    async function performExchange(token: string) {
      try {
        const res = await fetch(`${API_URL}/auth/sso/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })

        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(
            body.detail || `SSO exchange failed (HTTP ${res.status})`
          )
        }

        const data = await res.json()
        const { access_token, refresh_token } = data

        if (!access_token || !refresh_token) {
          throw new Error('SSO exchange returned incomplete tokens')
        }

        if (cancelled) return

        // Decode access token to extract user info (sub, email, role).
        const claims = decodeJwtPayload(access_token)

        // Populate auth store — same shape as the normal login flow.
        useAuthStore.setState({
          isAuthenticated: true,
          accessToken: access_token,
          refreshToken: refresh_token,
          user: {
            email: (claims.email as string) || '',
            role: (claims.role as string) || 'VIEWER',
            id: (claims.sub as string) || '',
          },
        })

        navigate('/dashboard', { replace: true })
      } catch (err: unknown) {
        if (cancelled) return
        setError(
          err instanceof Error ? err.message : 'SSO login failed'
        )
      }
    }

    performExchange(exchangeToken)

    return () => {
      cancelled = true
    }
  }, [searchParams, navigate, setTokens])

  /*
    The SSO handoff sits between the light login screen and the light console,
    and it used to be a pitch-black gradient panel — so signing in flashed the
    user through a screen that looked like a different product. Both states now
    reuse the login backdrop, and the only thing that changes between them is
    what the card says.
  */
  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-cs-hair-2 p-4">
      <div
        className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,.045)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.045)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_75%_60%_at_50%_45%,#000,transparent)]"
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_50%_45%_at_50%_38%,rgba(99,102,241,0.10),transparent_70%)]"
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-md rounded-cs-card border border-cs-hair bg-cs-panel p-8 text-center shadow-modal">
        {children}
      </div>
    </div>
  )

  if (error) {
    return (
      <Shell>
        <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-cs-crit/10 text-cs-crit">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h2 className="text-[17px] font-semibold text-cs-ink">Single sign-on did not complete</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-cs-muted">{error}</p>
        <a href="/login" className="btn btn-primary mt-6">
          Back to sign in
        </a>
      </Shell>
    )
  }

  return (
    <Shell>
      <div
        className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-[3px] border-cs-indigo border-t-transparent"
        aria-hidden="true"
      />
      <h2 className="text-[17px] font-semibold text-cs-ink">Signing you in</h2>
      <p className="mt-1.5 text-[13px] text-cs-muted">Verifying your credentials with the server.</p>
    </Shell>
  )
}
