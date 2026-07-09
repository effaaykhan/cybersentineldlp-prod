import { useState, useEffect } from 'react'
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

// Nav grouped by what the analyst is doing. An item shows if the user has
// ANY of its permissions (empty = always shown); a group with no visible
// items hides entirely.
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
  // Auto-collapse to icons on narrow viewports (< 1120px); the manual
  // toggle still works on wider screens.
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1120px)')
    const update = () => setIsNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  const collapsed = isCollapsed || isNarrow
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
        'bg-cs-panel text-cs-ink-2 flex flex-col border-r border-cs-hair transition-all duration-200',
        collapsed ? 'w-16' : 'w-[226px]',
      )}
    >
      {/* Brand — height matches the 56px top bar */}
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-cs-hair shrink-0">
        <img src={logo} alt="CyberSentinel DLP" className="h-8 w-8 object-contain shrink-0" />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="text-[14px] font-semibold text-cs-ink truncate">CyberSentinel</div>
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-cs-muted-2">
              DLP Console
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2.5 py-4 space-y-5 overflow-y-auto scrollbar-thin">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <p className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-cs-muted-2">
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
                      'group relative flex items-center rounded-cs-sm px-2.5 py-2 text-sm font-medium transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:shadow-focus',
                      isActive
                        ? 'bg-cs-indigo-faint text-cs-indigo'
                        : 'text-cs-ink-2 hover:bg-cs-hair-2 hover:text-cs-ink',
                      isCollapsed && 'justify-center',
                    )
                  }
                  title={collapsed ? item.name : undefined}
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={cn(
                          'absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-cs-indigo transition-opacity',
                          isActive ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <item.icon
                        className={cn(
                          'h-[18px] w-[18px] shrink-0 transition-colors',
                          !collapsed && 'mr-3',
                          isActive ? 'text-cs-indigo' : 'text-cs-muted group-hover:text-cs-ink-2',
                        )}
                      />
                      {!collapsed && item.name}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t border-cs-hair p-2.5 shrink-0">
        <button
          onClick={() => setIsCollapsed(!collapsed)}
          className="w-full p-2 text-cs-muted hover:bg-cs-hair-2 hover:text-cs-ink-2 rounded-cs-sm transition-colors flex items-center justify-center gap-2 text-xs font-medium focus-visible:outline-none focus-visible:shadow-focus"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
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
