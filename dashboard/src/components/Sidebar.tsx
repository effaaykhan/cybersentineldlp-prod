import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import logo from '@/elements/logo.png'
import {
  LayoutDashboard,
  Server,
  AlertCircle,
  FileText,
  Shield,
  Settings,
  ChevronLeft,
  ChevronRight,
  List,
  AlertTriangle,
  Search,
  UserCog,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/hooks/usePermission'

// Nav is grouped by what the analyst is doing — overview, investigating,
// enforcing, administering — so ten destinations read as four short lists
// instead of one long scroll. An item shows if the user has ANY of its
// permissions (empty = always shown); a group with no visible items hides.
type NavItem = {
  name: string
  to: string
  icon: typeof LayoutDashboard
  requires: string[]
}
type NavGroup = { label: string; items: NavItem[] }

const groups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, requires: ['view_dashboard'] },
    ],
  },
  {
    label: 'Monitor',
    items: [
      { name: 'Agents',       to: '/agents',       icon: Server,        requires: ['view_events'] },
      { name: 'Events',       to: '/events',       icon: FileText,      requires: ['view_events'] },
      { name: 'Alerts',       to: '/alerts',       icon: AlertCircle,   requires: ['view_alerts'] },
      { name: 'Incidents',    to: '/incidents',    icon: AlertTriangle, requires: ['view_alerts'] },
      { name: 'Log Explorer', to: '/log-explorer', icon: Search,        requires: ['view_events'] },
    ],
  },
  {
    label: 'Enforce',
    items: [
      { name: 'Rules',    to: '/rules',    icon: List,   requires: ['create_policy', 'update_policy'] },
      { name: 'Policies', to: '/policies', icon: Shield, requires: ['create_policy', 'update_policy'] },
    ],
  },
  {
    label: 'Administer',
    items: [
      { name: 'User Management', to: '/admin/users', icon: UserCog,  requires: ['manage_users'] },
      { name: 'Settings',        to: '/settings',    icon: Settings, requires: ['manage_users', 'manage_roles'] },
    ],
  },
]

export default function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { hasAny } = usePermission()

  const visibleGroups = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => i.requires.length === 0 || hasAny(i.requires)),
    }))
    .filter((g) => g.items.length > 0)

  return (
    <aside
      className={cn(
        'bg-slate-900 text-slate-300 flex flex-col border-r border-slate-800 transition-all duration-300',
        isCollapsed ? 'w-16' : 'w-64',
      )}
    >
      {/* Brand */}
      <div className="h-16 flex items-center gap-2.5 px-4 border-b border-slate-800/80">
        <img
          src={logo}
          alt="CyberSentinel DLP"
          className="h-9 w-9 object-contain flex-shrink-0"
        />
        {!isCollapsed && (
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-semibold text-white truncate">CyberSentinel</div>
            <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
              DLP Console
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2.5 py-4 space-y-5 overflow-y-auto scrollbar-thin">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            {!isCollapsed && (
              <p className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.name}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center rounded-lg px-2.5 py-2 text-sm font-medium transition-colors duration-150',
                      isActive
                        ? 'bg-primary-500/10 text-white'
                        : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
                      isCollapsed && 'justify-center',
                    )
                  }
                  title={isCollapsed ? item.name : undefined}
                >
                  {({ isActive }) => (
                    <>
                      {/* Active accent bar */}
                      <span
                        className={cn(
                          'absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-primary-400 transition-opacity',
                          isActive ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <item.icon
                        className={cn(
                          'h-[18px] w-[18px] flex-shrink-0 transition-colors',
                          !isCollapsed && 'mr-3',
                          isActive ? 'text-primary-300' : 'text-slate-500 group-hover:text-slate-300',
                        )}
                      />
                      {!isCollapsed && item.name}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-slate-800/80 p-2.5">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full p-2 text-slate-400 hover:bg-white/5 hover:text-slate-200 rounded-lg transition-colors flex items-center justify-center gap-2 text-xs font-medium"
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
