import { useState } from 'react'
import { extractErrorDetail } from '@/utils/errorUtils'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/lib/store/auth'
import { changePassword } from '@/lib/api'
import { Shield, Mail, Lock, AlertCircle, CheckCircle, KeyRound, Eye, EyeOff } from 'lucide-react'

export default function LoginForm() {
  const navigate = useNavigate()
  const { login } = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [mode, setMode] = useState<'login' | 'changePassword'>('login')
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const resetForm = () => {
    setPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setError('')
    setSuccess('')
    setShowPassword(false)
    setShowNewPassword(false)
    setShowConfirmPassword(false)
  }

  const switchMode = (newMode: 'login' | 'changePassword') => {
    resetForm()
    setMode(newMode)
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(email, password)
      navigate('/dashboard')
    } catch (err: any) {
      const errorMessage = extractErrorDetail(err, 'Invalid credentials')
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }

    setLoading(true)
    try {
      await changePassword(email, password, newPassword, confirmPassword)
      setSuccess('Password changed successfully! You can now sign in with your new password.')
      resetForm()
      setTimeout(() => setMode('login'), 2000)
    } catch (err: any) {
      const errorMessage = extractErrorDetail(err, 'Failed to change password')
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const isChangePassword = mode === 'changePassword'

  const eyeButtonClass = "absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer text-cs-muted-2 hover:text-cs-ink-2 transition-colors"
  const fieldClass = "input pl-10 py-2.5 disabled:bg-cs-hair-2"

  return (
    <div className="w-full max-w-md">
      <div className="bg-cs-panel rounded-cs-card shadow-card-hover p-8 border border-cs-hair">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-cs-indigo rounded-cs-card mb-4 shadow-sm">
            {isChangePassword ? (
              <KeyRound className="w-7 h-7 text-white" />
            ) : (
              <Shield className="w-7 h-7 text-white" />
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-cs-ink">CyberSentinel DLP</h1>
          <p className="text-cs-muted mt-1.5 text-sm">
            {isChangePassword ? 'Change your password' : 'Enterprise Data Loss Prevention'}
          </p>
        </div>

        {/* Success Alert */}
        {success && (
          <div className="mb-6 p-4 bg-[color-mix(in_srgb,var(--cs-ok)_12%,var(--cs-panel))] border border-[color-mix(in_srgb,var(--cs-ok)_30%,var(--cs-panel))] rounded-cs-sm flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-cs-ok flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-medium text-cs-ok">Success</h3>
              <p className="text-sm text-cs-ink-2 mt-1">{success}</p>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 bg-[color-mix(in_srgb,var(--cs-crit)_12%,var(--cs-panel))] border border-[color-mix(in_srgb,var(--cs-crit)_30%,var(--cs-panel))] rounded-cs-sm flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-cs-crit flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-medium text-cs-crit">
                {isChangePassword ? 'Password change failed' : 'Authentication failed'}
              </h3>
              <p className="text-sm text-cs-ink-2 mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={isChangePassword ? handleChangePassword : handleLogin} className="space-y-5">
          {/* Username Field */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-cs-ink-2 mb-1.5">
              Username
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-4 w-4 text-cs-muted-2" />
              </div>
              <input
                id="email"
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={fieldClass}
                placeholder="admin"
                disabled={loading}
              />
            </div>
          </div>

          {/* Current Password Field */}
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-cs-ink-2 mb-1.5">
              {isChangePassword ? 'Current password' : 'Password'}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-4 w-4 text-cs-muted-2" />
              </div>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={`${fieldClass} pr-10`}
                placeholder={isChangePassword ? 'Enter current password' : 'Enter your password'}
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={eyeButtonClass}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* New Password Fields (only in change password mode) */}
          {isChangePassword && (
            <>
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-cs-ink-2 mb-1.5">
                  New password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <KeyRound className="h-4 w-4 text-cs-muted-2" />
                  </div>
                  <input
                    id="newPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    className={`${fieldClass} pr-10`}
                    placeholder="Enter new password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className={eyeButtonClass}
                    tabIndex={-1}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-cs-ink-2 mb-1.5">
                  Confirm new password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <KeyRound className="h-4 w-4 text-cs-muted-2" />
                  </div>
                  <input
                    id="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className={`${fieldClass} pr-10`}
                    placeholder="Confirm new password"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className={eyeButtonClass}
                    tabIndex={-1}
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <p className="text-xs text-cs-muted">
                Password must be at least 7 characters with uppercase, lowercase, digit, and special character.
              </p>
            </>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {isChangePassword ? 'Changing password…' : 'Signing in…'}
              </span>
            ) : (
              isChangePassword ? 'Change password' : 'Sign in'
            )}
          </button>
        </form>

        {/* Toggle Link */}
        <div className="mt-6 text-center">
          {isChangePassword ? (
            <button
              onClick={() => switchMode('login')}
              className="text-sm font-medium text-cs-indigo hover:text-cs-indigo-d transition-colors"
            >
              Back to sign in
            </button>
          ) : (
            <button
              onClick={() => switchMode('changePassword')}
              className="text-sm font-medium text-cs-indigo hover:text-cs-indigo-d transition-colors"
            >
              Change password
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="mt-5 pt-5 border-t border-cs-hair-2 text-center text-xs text-cs-muted">
          <p>Secure access to your organization's DLP platform</p>
        </div>
      </div>

      {/* Version Info */}
      <div className="mt-4 text-center text-xs text-cs-muted-2">
        <p>Version <span className="num">1.0.0</span> · Enterprise Edition</p>
      </div>
    </div>
  )
}
