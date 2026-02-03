import { NavLink } from 'react-router-dom'
import logo from '@/elements/logo.png'
import {
  LayoutDashboard,
  Server,
  AlertCircle,
  FileText,
  Shield,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navigation = [
  { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { name: 'Agents', to: '/agents', icon: Server },
  { name: 'Events', to: '/events', icon: FileText },
  { name: 'Alerts', to: '/alerts', icon: AlertCircle },
  { name: 'Policies', to: '/policies', icon: Shield },
  { name: 'Settings', to: '/settings', icon: Settings },
]

export default function Sidebar() {
  return (
    <aside className="w-64 bg-[#1a1d1f] text-white flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center pl-3 border-b border-gray-800">
        <img
	  src={logo}
	  alt="CyberSentinel-DLP Logo"
	  className="h-12 w-12 object-contain"
	/>
        <span className="ml-1 text-xl font-semibold">CyberSentinel-DLP</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-6 space-y-1 overflow-y-auto">
        {navigation.map((item) => (
          <NavLink
            key={item.name}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200',
                isActive
                  ? 'bg-primary-600 text-white'
                  : 'text-gray-300 hover:bg-[#2a2d2f] hover:text-white'
              )
            }
          >
            <item.icon className="h-5 w-5 mr-3" />
            {item.name}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-800 text-xs text-gray-400">
        <div>Version 2.0.0</div>
        <div className="mt-1">© 2025 CyberSentinel DLP</div>
      </div>
    </aside>
  )
}
