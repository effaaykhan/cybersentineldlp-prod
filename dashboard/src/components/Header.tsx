import { User, LogOut, Settings as SettingsIcon, ChevronDown } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../lib/store/auth'

// Route → readable page name, so the top bar always says where you are.
const PAGE_TITLES: Array<[string, string]> = [
  ['/dashboard', 'Dashboard'],
  ['/agents', 'Agents'],
  ['/events', 'Events'],
  ['/alerts', 'Alerts'],
  ['/incidents', 'Incidents'],
  ['/log-explorer', 'Log Explorer'],
  ['/rules', 'Rules'],
  ['/policies', 'Policies'],
  ['/admin/users', 'User Management'],
  ['/settings', 'Settings'],
]

function usePageTitle() {
  const { pathname } = useLocation()
  const match = PAGE_TITLES.find(([p]) => pathname.startsWith(p))
  return match ? match[1] : 'Console'
}

export default function Header() {
  const [showUserMenu, setShowUserMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()
  const pageTitle = usePageTitle()

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
    <header className="h-16 bg-white/90 backdrop-blur border-b border-slate-200 flex items-center justify-between px-6">
      {/* Where you are */}
      <div className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-slate-400">CyberSentinel</span>
        <span className="text-slate-300" aria-hidden>/</span>
        <span className="font-semibold text-slate-900 truncate">{pageTitle}</span>
      </div>

      {/* User menu */}
      <div className="flex items-center gap-3">
        <div className="hidden sm:flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
          <span className="live-dot" />
          <span className="uppercase tracking-[0.08em]">Live</span>
        </div>
        <div className="h-5 w-px bg-slate-200 hidden sm:block" />
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 py-1.5 pl-1.5 pr-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center text-white text-sm font-semibold">
              {initial || <User className="h-4 w-4" />}
            </div>
            <span className="text-sm font-medium text-slate-700 max-w-[14rem] truncate">{email}</span>
            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {showUserMenu && (
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-card-hover border border-slate-200 py-1.5 animate-slideIn z-50">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-sm font-medium text-slate-900 truncate">{email}</p>
                <p className="text-xs text-slate-500 capitalize">{user?.role || 'Administrator'}</p>
              </div>

              <button
                onClick={() => {
                  setShowUserMenu(false)
                  navigate('/settings')
                }}
                className="w-full px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-3 transition-colors"
              >
                <SettingsIcon className="h-4 w-4 text-slate-400" />
                Settings
              </button>

              <button
                onClick={handleLogout}
                className="w-full px-4 py-2 text-sm text-danger-600 hover:bg-danger-50 flex items-center gap-3 transition-colors"
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
