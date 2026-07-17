import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Server, Database, Bell, Lock, Archive } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  changePassword,
  getRetentionConfig, updateRetentionConfig, type RetentionConfig,
} from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth'
import { API_URL } from '@/lib/config'
import MfaSection from '@/components/settings/MfaSection'
import IpAllowlistSection from '@/components/settings/IpAllowlistSection'
import SiemForwardingSection from '@/components/settings/SiemForwardingSection'

const defaultOpenSearchUrl = import.meta.env.VITE_OPENSEARCH_URL ?? 'https://localhost:9200'

export default function Settings() {
  const { user } = useAuthStore()
  const isSuperAdmin = String(user?.role || '').toUpperCase() === 'ADMIN'
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  const [retention, setRetention] = useState<RetentionConfig | null>(null)
  const [retForm, setRetForm] = useState({ event_retention_days: 180, opensearch_retention_days: 90 })
  const [savingRetention, setSavingRetention] = useState(false)

  useEffect(() => {
    if (!isSuperAdmin) return
    getRetentionConfig()
      .then((r) => {
        setRetention(r)
        setRetForm({ event_retention_days: r.event_retention_days, opensearch_retention_days: r.opensearch_retention_days })
      })
      .catch(() => { /* non-fatal; card shows defaults */ })
  }, [isSuperAdmin])

  const handleSaveRetention = async (e: React.FormEvent) => {
    e.preventDefault()
    const min = retention?.minimum_days ?? 90
    if (retForm.event_retention_days < min || retForm.opensearch_retention_days < min) {
      toast.error(`Retention must be at least ${min} days`)
      return
    }
    setSavingRetention(true)
    try {
      const r = await updateRetentionConfig(retForm)
      setRetention(r)
      setRetForm({ event_retention_days: r.event_retention_days, opensearch_retention_days: r.opensearch_retention_days })
      toast.success('Log retention updated')
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to update retention')
    } finally {
      setSavingRetention(false)
    }
  }

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

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <p className="eyebrow mb-1.5">Configuration</p>
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Settings</h1>
        <p className="mt-1 text-sm text-cs-ink-2">
          Configure system settings and preferences
        </p>
      </div>

      {/* Settings Sections */}
      <div className="space-y-6">
        {/* Account Security */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <Lock className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <h3 className="section-title">Account Security</h3>
              <p className="text-sm text-cs-muted">Update the password for your admin account.</p>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
                Username
              </label>
              <input
                type="text"
                className="input bg-cs-hair-2 num"
                value={user?.email || ''}
                readOnly
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
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
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
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
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
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
              <p className="mt-1 text-xs text-cs-muted">
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

        {/* Two-Factor Authentication (self-service, all admin accounts) */}
        <MfaSection />

        {/* Authorized IP Addresses (Super Admin only) */}
        {isSuperAdmin && <IpAllowlistSection />}

        {/* SIEM Log Forwarding (Super Admin only) */}
        {isSuperAdmin && <SiemForwardingSection />}

        {/* System Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <Server className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <h3 className="section-title">System Settings</h3>
              <p className="text-sm text-cs-muted">Manager endpoint and data refresh behavior.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
                Manager URL
              </label>
              <input
                type="text"
                className="input num"
                defaultValue={API_URL}
                readOnly
              />
              <p className="mt-1 text-xs text-cs-muted">
                The manager API endpoint
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
                Refresh Interval
              </label>
              <select className="input">
                <option>5 seconds</option>
                <option selected>10 seconds</option>
                <option>30 seconds</option>
                <option>60 seconds</option>
              </select>
              <p className="mt-1 text-xs text-cs-muted">
                How often to refresh data automatically
              </p>
            </div>
          </div>
        </div>

        {/* Database Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <Database className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <h3 className="section-title">OpenSearch Settings</h3>
              <p className="text-sm text-cs-muted">Index storage and event retention configuration.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
                OpenSearch Host
              </label>
              <input
                type="text"
                className="input num"
                defaultValue={defaultOpenSearchUrl}
                readOnly
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-cs-ink-2 mb-2">
                Index Prefix
              </label>
              <input
                type="text"
                className="input num"
                defaultValue="cybersentineldlp"
                readOnly
              />
              <p className="mt-1 text-xs text-cs-muted">
                Prefix for all indices (e.g., cybersentineldlp-events-2025.01.12)
              </p>
            </div>

            {/* Log retention — DB-backed, admin-editable, 90-day compliance floor */}
            <form onSubmit={handleSaveRetention} className="space-y-4 pt-4 border-t border-cs-hair-2">
              <div className="flex items-center gap-2">
                <Archive className="h-4 w-4 text-cs-indigo" />
                <span className="text-sm font-medium text-cs-ink">Log Retention</span>
                {retention && (
                  <span className="badge bg-cs-hair-2 text-cs-ink-2 text-xs">source: {retention.source}</span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-cs-ink-2 mb-2">Event log retention (days)</label>
                  <input type="number" min={retention?.minimum_days ?? 90} className="input num"
                    value={retForm.event_retention_days} disabled={!isSuperAdmin}
                    onChange={(e) => setRetForm({ ...retForm, event_retention_days: Number(e.target.value) })} />
                  <p className="mt-1 text-xs text-cs-muted">End-user DLP events (MongoDB).</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-cs-ink-2 mb-2">Index log retention (days)</label>
                  <input type="number" min={retention?.minimum_days ?? 90} className="input num"
                    value={retForm.opensearch_retention_days} disabled={!isSuperAdmin}
                    onChange={(e) => setRetForm({ ...retForm, opensearch_retention_days: Number(e.target.value) })} />
                  <p className="mt-1 text-xs text-cs-muted">Searchable log index (OpenSearch).</p>
                </div>
              </div>
              <p className="text-xs text-cs-muted">
                Minimum {retention?.minimum_days ?? 90} days — enforced server-side. Applied daily by the cleanup task; logs newer than the window are always retained.
              </p>
              {isSuperAdmin && (
                <button type="submit" disabled={savingRetention}
                  className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
                  <Archive className="h-4 w-4" />{savingRetention ? 'Saving…' : 'Save retention'}
                </button>
              )}
            </form>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <Bell className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <h3 className="section-title">Notifications</h3>
              <p className="text-sm text-cs-muted">Choose how alerts are delivered to you.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-cs-ink">Email Notifications</p>
                <p className="text-sm text-cs-ink-2">
                  Send email alerts for critical events
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" defaultChecked />
                <div className="w-11 h-6 bg-cs-hair-2 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-cs-indigo-faint rounded-cs-pill peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-cs-hair after:border after:rounded-cs-pill after:h-5 after:w-5 after:transition-all peer-checked:bg-cs-indigo"></div>
              </label>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-cs-ink">Desktop Notifications</p>
                <p className="text-sm text-cs-ink-2">
                  Show browser notifications for new alerts
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" />
                <div className="w-11 h-6 bg-cs-hair-2 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-cs-indigo-faint rounded-cs-pill peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-cs-hair after:border after:rounded-cs-pill after:h-5 after:w-5 after:transition-all peer-checked:bg-cs-indigo"></div>
              </label>
            </div>
          </div>
        </div>

        {/* About */}
        <div className="card">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-cs-indigo-faint rounded-cs-sm">
              <SettingsIcon className="h-5 w-5 text-cs-indigo" />
            </div>
            <div>
              <h3 className="section-title">About</h3>
              <p className="text-sm text-cs-muted">Platform version and component details.</p>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-cs-ink-2">Version</span>
              <span className="num font-medium text-cs-ink">2.0.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cs-ink-2">Backend API</span>
              <span className="num font-medium text-cs-ink">FastAPI 0.109.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cs-ink-2">OpenSearch</span>
              <span className="num font-medium text-cs-ink">2.11.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cs-ink-2">License</span>
              <span className="font-medium text-cs-ink">Proprietary</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
