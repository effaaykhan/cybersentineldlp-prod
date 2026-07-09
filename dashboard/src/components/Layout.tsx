import { Outlet, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/lib/store/auth'
import Sidebar from './Sidebar'
import Header from './Header'
import Footer from './Footer'

export default function Layout() {
  const { isAuthenticated } = useAuthStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return null
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="flex h-screen bg-cs-bg">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>

        {/* Footer */}
        <Footer />
      </div>
    </div>
  )
}
