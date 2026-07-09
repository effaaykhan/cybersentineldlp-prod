import { User, LogOut, Settings as SettingsIcon, ChevronDown, RefreshCw } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../lib/store/auth'

// Route → { group, title } so the breadcrumb reads "Group / Page" and stays
// in lock-step with the sidebar grouping.
const PAGE_META: Array<[string, { group: string; title: string }]> = [
  ['/dashboard', { group: 'Overview', title: 'Dashboard' }],
  ['/agents', { group: 'Monitor', title: 'Agents' }],
  ['/events', { group: 'Monitor', title: 'Events' }],
  ['/alerts', { group: 'Monitor', title: 'Alerts' }],
  ['/incidents', { group: 'Monitor', title: 'Incidents' }],
  ['/log-explorer', { group: 'Monitor', title: 'Log Explorer' }],
  ['/rules', { group: 'Enforce', title: 'Rules' }],
  ['/policies', { group: 'Enforce', title: 'Policies' }],
  ['/admin/users', { group: 'Administer', title: 'User Management' }],
  ['/settings', { group: 'Administer', title: 'Settings' }],
]

function usePageMeta() {
  const { pathname } = useLocation()
  const match = PAGE_META.find(([p]) => pathname.startsWith(p))
  return match ? match[1] : { group: 'Console', title: 'Home' }
}

// Live IST clock (matches the app's IST convention on timelines).
function useClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now)
}

export default function Header() {
  const [showUserMenu, setShowUserMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user, logout } = useAuthStore()
  const meta = usePageMeta()
  const clock = useClock()

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const email = user?.email || 'admin'
  const initial = email.charAt(0).toUpperCase()

  return (
    <header className="h-14 bg-cs-panel border-b border-cs-hair flex items-center justify-between px-5 shrink-0">
      {/* Breadcrumb: Group / Page */}
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-cs-muted">{meta.group}</span>
        <span className="text-cs-hair" aria-hidden>/</span>
        <span className="font-semibold text-cs-ink truncate">{meta.title}</span>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Live pill: pulsing dot + mono clock */}
        <div className="hidden sm:inline-flex items-center gap-2 rounded-cs-pill border border-cs-hair px-2.5 py-1">
          <span className="cs-live-dot" aria-hidden />
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-cs-ok">Live</span>
          <span className="font-mono text-xs tabular-nums text-cs-ink-2">{clock}</span>
        </div>

        {/* Global refresh — refetch every active query */}
        <button
          onClick={() => queryClient.invalidateQueries()}
          className="p-2 text-cs-muted hover:text-cs-ink-2 hover:bg-cs-hair-2 rounded-cs-sm transition-colors focus-visible:outline-none focus-visible:shadow-focus"
          title="Refresh all data"
          aria-label="Refresh all data"
        >
          <RefreshCw className="h-4 w-4" />
        </button>

        <div className="h-5 w-px bg-cs-hair hidden sm:block" />

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 py-1.5 pl-1.5 pr-2 text-cs-ink-2 hover:bg-cs-hair-2 rounded-cs-sm transition-colors focus-visible:outline-none focus-visible:shadow-focus"
          >
            <div className="w-7 h-7 bg-cs-indigo rounded-cs-sm flex items-center justify-center text-white text-xs font-semibold">
              {initial || <User className="h-4 w-4" />}
            </div>
            <span className="text-sm font-medium max-w-[13rem] truncate">{email}</span>
            <ChevronDown className={`h-4 w-4 text-cs-muted transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {showUserMenu && (
            <div className="absolute right-0 mt-2 w-56 bg-cs-panel rounded-cs-card border border-cs-hair shadow-card-hover py-1.5 animate-slideIn z-50">
              <div className="px-4 py-3 border-b border-cs-hair-2">
                <p className="text-sm font-medium text-cs-ink truncate">{email}</p>
                <p className="text-xs text-cs-muted capitalize">{user?.role || 'Administrator'}</p>
              </div>
              <button
                onClick={() => { setShowUserMenu(false); navigate('/settings') }}
                className="w-full px-4 py-2 text-sm text-cs-ink-2 hover:bg-cs-hair-2 flex items-center gap-3 transition-colors"
              >
                <SettingsIcon className="h-4 w-4 text-cs-muted" />
                Settings
              </button>
              <button
                onClick={handleLogout}
                className="w-full px-4 py-2 text-sm text-cs-crit hover:bg-cs-hair-2 flex items-center gap-3 transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
