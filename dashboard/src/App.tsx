import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useAuthStore } from './lib/store/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import SSOCallback from './pages/SSOCallback'
import Dashboard from './pages/Dashboard'
import Agents from './pages/Agents'
import Events from './pages/Events'
import Alerts from './pages/Alerts'
import Rules from './pages/Rules'
import DataMatching from './pages/DataMatching'
import MLClassifier from './pages/MLClassifier'
import UsbDevices from './pages/UsbDevices'
import Printers from './pages/Printers'
import Policies from './app/dashboard/policies/page'
import Settings from './pages/Settings'
import Incidents from './app/dashboard/incidents/page'
import LogExplorer from './app/dashboard/log-explorer/page'
import UserManagement from './pages/UserManagement'
import ThreatIntelligence from './pages/ThreatIntelligence'

function App() {
  const { isAuthenticated } = useAuthStore()

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/sso" element={<SSOCallback />} />
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="agents" element={<Agents />} />
          <Route path="events" element={<Events />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="rules" element={<Rules />} />
          <Route path="data-matching" element={<DataMatching />} />
          <Route path="ml-classifier" element={<MLClassifier />} />
          <Route path="usb-devices" element={<UsbDevices />} />
          <Route path="printers" element={<Printers />} />
          <Route path="policies" element={<Policies />} />
          <Route path="incidents" element={<Incidents />} />
          <Route path="log-explorer" element={<LogExplorer />} />
          <Route path="threat-intel" element={<ThreatIntelligence />} />
          <Route path="admin/users" element={<UserManagement />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        <Route
          path="*"
          element={
            <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
          }
        />
      </Routes>
      {/*
        The last surviving piece of the old dark theme. Every successful action
        in this light console popped a near-black slab with pale blue text, in
        five hardcoded hexes that appear nowhere else in the palette. A toast is
        the most frequently seen surface in the product; it should look like the
        product.
      */}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: 'var(--cs-panel)',
            color: 'var(--cs-ink)',
            border: '1px solid var(--cs-hair)',
            borderRadius: 'var(--cs-r-card)',
            boxShadow: 'var(--cs-shadow-pop)',
            fontSize: '13px',
            padding: '10px 14px',
            maxWidth: '420px',
          },
          success: {
            duration: 3000,
            iconTheme: { primary: 'var(--cs-ok)', secondary: 'var(--cs-panel)' },
          },
          error: {
            duration: 5000,
            iconTheme: { primary: 'var(--cs-crit)', secondary: 'var(--cs-panel)' },
          },
          loading: {
            iconTheme: { primary: 'var(--cs-indigo)', secondary: 'var(--cs-panel)' },
          },
        }}
      />
    </>
  )
}

export default App
