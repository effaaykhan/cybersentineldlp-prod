import { useState } from 'react'
import { Settings as SettingsIcon, Server, Database, Bell, Globe, Lock } from 'lucide-react'
import toast from 'react-hot-toast'
import { initiateGoogleDriveConnection, initiateOneDriveConnection, changePassword } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth'
import { API_URL } from '@/lib/config'

const defaultOpenSearchUrl = import.meta.env.VITE_OPENSEARCH_URL ?? 'https://localhost:9200'

export default function Settings() {
  const { user } = useAuthStore()
  const [isConnectingDrive, setIsConnectingDrive] = useState(false)
  const [isConnectingOneDrive, setIsConnectingOneDrive] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }

    setChangingPassword(true)
    try {
      await changePassword(user?.email || '', currentPassword, newPassword, confirmPassword)
      toast.success('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err: any) {
      toast.error(err.response?.data?.detail || err.message || 'Failed to change password')
    } finally {
      setChangingPassword(false)
    }
  }

  const handleDriveConnect = async () => {
    try {
      setIsConnectingDrive(true)
      const { auth_url } = await initiateGoogleDriveConnection()
      window.open(auth_url, '_blank', 'noopener,noreferrer')
      toast.success('Opened Google consent screen')
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || 'Failed to start Google Drive auth')
    } finally {
      setIsConnectingDrive(false)
    }
  }

  const handleOneDriveConnect = async () => {
    try {
      setIsConnectingOneDrive(true)
      const { auth_url } = await initiateOneDriveConnection()
      window.open(auth_url, '_blank', 'noopener,noreferrer')
      toast.success('Opened OneDrive consent screen')
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || 'Failed to start OneDrive auth')
    } finally {
      setIsConnectingOneDrive(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <p className="eyebrow mb-1.5">Configuration</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure system settings and preferences
        </p>
      </div>

      {/* Settings Sections */}
      <div className="space-y-6">
        {/* Account Security */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Lock className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Account Security</h3>
              <p className="text-sm text-slate-500">Update the password for your admin account.</p>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Username
              </label>
              <input
                type="text"
                className="input bg-slate-50"
                value={user?.email || ''}
                readOnly
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Current Password
              </label>
              <input
                type="password"
                className="input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                New Password
              </label>
              <input
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Confirm New Password
              </label>
              <input
                type="password"
                className="input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                required
              />
              <p className="mt-1 text-xs text-slate-500">
                Must be at least 7 characters with uppercase, lowercase, digit, and special character.
              </p>
            </div>

            <button
              type="submit"
              disabled={changingPassword}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {changingPassword ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        </div>

        {/* System Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Server className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">System Settings</h3>
              <p className="text-sm text-slate-500">Manager endpoint and data refresh behavior.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Manager URL
              </label>
              <input
                type="text"
                className="input font-mono tabular-nums"
                defaultValue={API_URL}
                readOnly
              />
              <p className="mt-1 text-xs text-slate-500">
                The manager API endpoint
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Refresh Interval
              </label>
              <select className="input">
                <option>5 seconds</option>
                <option selected>10 seconds</option>
                <option>30 seconds</option>
                <option>60 seconds</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">
                How often to refresh data automatically
              </p>
            </div>
          </div>
        </div>

        {/* Database Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Database className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">OpenSearch Settings</h3>
              <p className="text-sm text-slate-500">Index storage and event retention configuration.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                OpenSearch Host
              </label>
              <input
                type="text"
                className="input font-mono tabular-nums"
                defaultValue={defaultOpenSearchUrl}
                readOnly
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Index Prefix
              </label>
              <input
                type="text"
                className="input font-mono tabular-nums"
                defaultValue="cybersentinel"
                readOnly
              />
              <p className="mt-1 text-xs text-slate-500">
                Prefix for all indices (e.g., cybersentinel-events-2025.01.12)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Retention Days
              </label>
              <input
                type="number"
                className="input font-mono tabular-nums"
                defaultValue="90"
                readOnly
              />
              <p className="mt-1 text-xs text-slate-500">
                Number of days to retain event data
              </p>
            </div>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Bell className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Notifications</h3>
              <p className="text-sm text-slate-500">Choose how alerts are delivered to you.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">Email Notifications</p>
                <p className="text-sm text-slate-600">
                  Send email alerts for critical events
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" defaultChecked />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
              </label>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-900">Desktop Notifications</p>
                <p className="text-sm text-slate-600">
                  Show browser notifications for new alerts
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
              </label>
            </div>
          </div>
        </div>

        {/* Cloud Connectors */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <Globe className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Cloud Connectors</h3>
              <p className="text-sm text-slate-500">Link cloud storage providers for monitoring.</p>
            </div>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            Use these temporary actions to open OAuth flows for testing. We&apos;ll relocate them once the full UI ships.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleDriveConnect}
              disabled={isConnectingDrive}
              className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isConnectingDrive ? 'Opening...' : 'Connect Google Drive'}
            </button>
            <button
              onClick={handleOneDriveConnect}
              disabled={isConnectingOneDrive}
              className="btn-secondary disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isConnectingOneDrive ? 'Opening...' : 'Connect OneDrive'}
            </button>
          </div>
        </div>

        {/* About */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-primary-50 rounded-lg">
              <SettingsIcon className="h-5 w-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">About</h3>
              <p className="text-sm text-slate-500">Platform version and component details.</p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">Version</span>
              <span className="font-mono tabular-nums font-medium text-slate-900">2.0.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Backend API</span>
              <span className="font-mono tabular-nums font-medium text-slate-900">FastAPI 0.109.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">OpenSearch</span>
              <span className="font-mono tabular-nums font-medium text-slate-900">2.11.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">License</span>
              <span className="font-mono tabular-nums font-medium text-slate-900">Apache 2.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
