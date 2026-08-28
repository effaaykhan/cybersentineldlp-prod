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

  // Re-resolve identity from the server once per console load. The store is
  // persisted, so without this a session keeps whatever permission list it
  // was created with for as long as the tokens live: a role change made in
  // User Management never reaches the open tab, and a session created
  // without a permission list never acquires one. refreshMe swallows
  // transient failures and leaves the session intact.
  useEffect(() => {
    if (isAuthenticated) {
      void useAuthStore.getState().refreshMe()
    }
  }, [isAuthenticated])

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
