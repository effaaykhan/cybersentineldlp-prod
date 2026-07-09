import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/lib/store/auth'
import LoginForm from '@/components/auth/LoginForm'

export default function Login() {
  const { isAuthenticated } = useAuthStore()

  // Redirect to dashboard if already authenticated
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Subtle blueprint grid — the console backdrop */}
      <div
        className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,.045)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.045)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_75%_60%_at_50%_45%,#000,transparent)]"
        aria-hidden="true"
      ></div>

      {/* Single restrained indigo wash behind the panel */}
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_50%_45%_at_50%_38%,rgba(99,102,241,0.10),transparent_70%)]"
        aria-hidden="true"
      ></div>

      {/* Content */}
      <div className="relative z-10">
        <LoginForm />
      </div>
    </div>
  )
}


