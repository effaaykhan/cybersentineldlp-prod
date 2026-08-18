/**
 * Design harness — renders the real pages and dialogs on their own, so they can
 * be looked at.
 *
 * Not part of the app and not built into it: vite only picks up index.html for
 * the production build, so nothing here reaches a user. It exists because most
 * of this UI is behind a login and several dialogs are three steps deep, and
 * reviewing a design you cannot see is guesswork — which is exactly how the
 * policy creator shipped with an invisible heading and a footer sitting on top
 * of its own form.
 *
 *   npx vite --port 5199
 *   http://localhost:5199/harness.html?view=policy-modal&step=2
 *   http://localhost:5199/harness.html?view=page&route=/incidents
 *
 * Every network call is answered locally (see `MOCKS`); nothing here talks to a
 * real server or needs a real session.
 */
import ReactDOM from 'react-dom/client'
import PolicyCreatorModal from './components/policies/PolicyCreatorModal'
import Layout from './components/Layout'
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
import Incidents from './app/dashboard/incidents/page'
import LogExplorer from './app/dashboard/log-explorer/page'
import ThreatIntelligence from './pages/ThreatIntelligence'
import UserManagement from './pages/UserManagement'
import Settings from './pages/Settings'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import apiClient from './lib/api'
import { useAuthStore } from './lib/store/auth'
import './styles/tokens.css'
import './index.css'

/* ── Fixtures ───────────────────────────────────────────────────────────
   Representative rather than minimal: long agent names, long file paths and
   a mix of severities, because layouts break on the realistic case and not
   on "Test 1". */

const AGENTS = [
  { agent_id: 'win-crypton-8f21a4c0', name: 'CRYPTON', agent_code: 1, status: 'active', os_name: 'Windows 11 Pro', os_version: '10.0.22631', ip_address: '192.168.2.76', version: '2.1.6', logged_in_users: ['CORP\\a.mehta'], last_seen: new Date(Date.now() - 20_000).toISOString() },
  { agent_id: 'lin-buildbox-2b77e910', name: 'buildbox-01.corp.internal', agent_code: 2, status: 'active', os_name: 'Ubuntu 22.04.4 LTS', os_version: '6.8.0-124', ip_address: '192.168.2.91', version: '2.1.6', logged_in_users: ['svc-build', 'r.okonkwo'], last_seen: new Date(Date.now() - 45_000).toISOString() },
  { agent_id: 'win-reception-77c2', name: 'RECEPTION-01', agent_code: 3, status: 'disconnected', os_name: 'Windows 10 Enterprise', os_version: '10.0.19045', ip_address: '192.168.2.44', version: '2.1.4', logged_in_users: [], last_seen: new Date(Date.now() - 5 * 3600_000).toISOString() },
]

const EVENTS = [
  { id: 'e0', event_id: 'e0', timestamp: new Date(Date.now() - 60_000).toISOString(), event_type: 'genai', event_subtype: 'genai_post', severity: 'critical', action_taken: 'masked', action: 'masked', blocked: false, user: 'CORP\\a.mehta', user_email: 'a.mehta@corp.example', agent_id: 'win-crypton-8f21a4c0', hostname: 'CRYPTON', classification_level: 'Restricted', description: 'Content submitted to ChatGPT — sent with sensitive values replaced',
    activity: 'post', app_category: 'genai', app_id: 'chatgpt', app_name: 'ChatGPT',
    page_host: 'chatgpt.com', page_url: 'https://chatgpt.com/uc/6a843f95-22ec-83ea-8fa2-94569c95dd13',
    text_content: 'what do you think of the aadhaar number 1235 6789 1234 ? can this be true? also check card 4111 1111 1111 1111 for r.menon@corp.example',
    content: 'what do you think of the aadhaar number 1235 6789 1234 ? can this be true? also check card 4111 1111 1111 1111 for r.menon@corp.example',
    masked_text: 'what do you think of the aadhaar number [AADHAAR_1] ? can this be true? also check card [CREDIT_CARD_1] for [EMAIL_1]',
    mask_summary: [{ type: 'AADHAAR', count: 1 }, { type: 'CREDIT_CARD', count: 1 }, { type: 'EMAIL', count: 1 }],
    matched_rules: ['Indian Aadhaar Number', 'Credit Card Number', 'Email Address'],
    policy_reason: 'Post to Generative AI is set to Redact for Confidential content and above (GenAI and Web Activity)' },
  { id: 'e1', event_id: 'e1', timestamp: new Date(Date.now() - 120_000).toISOString(), event_type: 'usb_file_transfer', event_subtype: 'file_copied', severity: 'critical', action_taken: 'blocked', user: 'CORP\\a.mehta', agent_id: 'win-crypton-8f21a4c0', hostname: 'CRYPTON', file_name: 'Q3-forecast-CONFIDENTIAL.xlsx', file_path: 'C:\\Users\\a.mehta\\Documents\\Finance\\Q3-forecast-CONFIDENTIAL.xlsx', destination_path: 'E:\\', file_size: 2_411_520, classification_level: 'Confidential', description: 'Confidential spreadsheet copied to removable drive', file_hash: 'a3f1c9e0b7d24f5a8c1e6b0d9f3a2c7e' },
  { id: 'e2', event_id: 'e2', timestamp: new Date(Date.now() - 900_000).toISOString(), event_type: 'clipboard', severity: 'high', action_taken: 'alerted', user: 'CORP\\r.okonkwo', agent_id: 'lin-buildbox-2b77e910', hostname: 'buildbox-01', description: 'Card number pattern copied to clipboard', classification_level: 'Restricted' },
  { id: 'e3', event_id: 'e3', timestamp: new Date(Date.now() - 3_600_000).toISOString(), event_type: 'print', severity: 'medium', action_taken: 'logged', user: 'CORP\\j.silva', agent_id: 'win-reception-77c2', hostname: 'RECEPTION-01', file_name: 'onboarding-pack.pdf', description: 'Internal document printed', classification_level: 'Internal' },
]

const POLICIES = [
  { id: 'p1', name: 'Block Confidential data to USB', type: 'usb_file_transfer', severity: 'critical', enabled: true, priority: 200, description: 'Stops Confidential and Restricted files reaching removable drives.', config: { action: 'block' }, created_at: '2026-06-02T09:14:00Z' },
  { id: 'p2', name: 'Generative AI prompt control', type: 'web_activity_control', severity: 'high', enabled: true, priority: 180, description: 'Blocks sensitive prompts and attachments to AI assistants; Copilot is excepted.', config: { mode: 'enforce', minLevel: 'Confidential', matrix: { genai: { post: 'block', attach: 'block' } } }, created_at: '2026-08-04T11:02:00Z' },
  { id: 'p3', name: 'Printer allowlist — Reception', type: 'printer_control', severity: 'medium', enabled: false, priority: 90, description: 'Only the sanctioned front-desk printer may be used.', config: { scope: 'allowlist' }, created_at: '2026-07-19T15:40:00Z' },
]

const INCIDENTS = [
  { id: 'i1', title: 'Repeated Confidential copies to removable media', description: 'a.mehta copied four Confidential spreadsheets to an unsanctioned USB drive within eleven minutes.', severity: 3, status: 'open', user: 'CORP\\a.mehta', event_count: 4, classification_level: 'Confidential', created_at: new Date(Date.now() - 3_000_000).toISOString(), related_events: EVENTS.map((e, i) => ({ ...e, is_trigger: i === 0 })) },
  { id: 'i2', title: 'Card data pasted into a web form', description: 'Clipboard monitoring matched a payment-card pattern on buildbox-01.', severity: 2, status: 'investigating', user: 'CORP\\r.okonkwo', event_count: 1, classification_level: 'Restricted', created_at: new Date(Date.now() - 9_000_000).toISOString(), related_events: [EVENTS[1]] },
  { id: 'i3', title: 'Internal document printed off-hours', description: 'A printing policy matched at 02:14 local time.', severity: 1, status: 'resolved', user: 'CORP\\j.silva', event_count: 1, created_at: new Date(Date.now() - 90_000_000).toISOString(), related_events: [EVENTS[2]] },
]

const page = (items: any[], key = 'items') => ({ [key]: items, items, total: items.length, count: items.length, page: 1, page_size: 25 })

/** url fragment -> response body. First match wins, so order longest-first. */
const MOCKS: Array<[RegExp, (url: string) => any]> = [
  [/\/auth\/me/, () => ({ id: 'u1', username: 'a.rahman', email: 'a.rahman@corp.example', role: 'ADMIN', permissions: ['*'] })],
  [/\/dashboard\/overview/, () => ({
    total_events: 1284, total_agents: 3, active_agents: 2, total_policies: 3,
    blocked_today: 27, open_incidents: 7, critical_alerts: 4,
    events_today: 186, total_alerts: 52, total_incidents: 51,
  })],
  [/\/dashboard\/timeline/, () =>
    Array.from({ length: 24 }, (_, i) => ({
      time: `${String(i).padStart(2, '0')}:00`,
      timestamp: new Date(Date.now() - (23 - i) * 3600_000).toISOString(),
      count: 12 + ((i * 7) % 31),
      events: 12 + ((i * 7) % 31),
      blocked: 2 + ((i * 3) % 9),
    })),
  ],
  [/\/events\/stats\/by-type/, () => [
    { type: 'usb_file_transfer', event_type: 'usb_file_transfer', name: 'USB transfer', count: 402, value: 402 },
    { type: 'clipboard', event_type: 'clipboard', name: 'Clipboard', count: 318, value: 318 },
    { type: 'print', event_type: 'print', name: 'Print', count: 260, value: 260 },
    { type: 'web_activity', event_type: 'web_activity', name: 'Web activity', count: 194, value: 194 },
    { type: 'network', event_type: 'network', name: 'Network', count: 110, value: 110 },
  ]],
  [/\/events\/stats\/by-severity/, () => [
    { severity: 'critical', name: 'critical', count: 42, value: 42 },
    { severity: 'high', name: 'high', count: 168, value: 168 },
    { severity: 'medium', name: 'medium', count: 604, value: 604 },
    { severity: 'low', name: 'low', count: 470, value: 470 },
  ]],
  [/\/events\/stats/, () => ({ total: 1284, blocked: 311, by_severity: { critical: 42, high: 168, medium: 604, low: 470 } })],
  [/\/agents\/stats/, () => ({ total: 3, active: 2, disconnected: 1, online: 2, offline: 1 })],
  [/\/agents/, () => page(AGENTS, 'agents')],
  [/\/events/, () => page(EVENTS, 'events')],
  [/\/incidents\/auto\/list/, (u) => {
    const status = new URL(u, 'http://x').searchParams.get('status')
    const items = status ? INCIDENTS.filter((i) => i.status === status) : INCIDENTS
    return { incidents: items, total: items.length, count: items.length, stats: { open: 7, investigating: 3, resolved: 41, total: 51 } }
  }],
  [/\/incidents\/auto\/[\w-]+/, (u) => INCIDENTS.find((i) => u.endsWith(i.id)) || INCIDENTS[0]],
  [/\/incidents\/statistics|\/incidents\/stats/, () => ({ open: 7, investigating: 3, resolved: 41, total: 51 })],
  [/\/incidents\/[\w-]+$/, (u) => INCIDENTS.find((i) => u.endsWith(i.id)) || INCIDENTS[0]],
  [/\/incidents/, () => page(INCIDENTS, 'incidents')],
  [/\/policies\/stats/, () => ({ total: 3, enabled: 2, disabled: 1, active: 2 })],
  [/\/policies/, () => page(POLICIES, 'policies')],
  [/\/alerts/, () => page(EVENTS.map((e) => ({ ...e, alert_id: e.id, title: e.description, status: 'new', rule_name: 'Aadhaar number' })), 'alerts')],
  [/\/app-catalog/, () => ({ entries: [
    { app_id: 'chatgpt', app_name: 'ChatGPT', category: 'genai' },
    { app_id: 'claude', app_name: 'Claude', category: 'genai' },
    { app_id: 'copilot', app_name: 'Microsoft Copilot', category: 'genai' },
    { app_id: 'gmail', app_name: 'Gmail', category: 'webmail' },
    { app_id: 'dropbox', app_name: 'Dropbox', category: 'cloud_storage' },
    { app_id: 'slack', app_name: 'Slack', category: 'collaboration' },
  ] })],
  [/\/usb-devices/, () => page([
    { serial: 'AA011223344556', manufacturer: 'SanDisk', model: 'Cruzer Blade', alias: 'Finance dept #3', approved: true, match_type: 'serial', first_seen: '2026-05-01T10:00:00Z' },
    { serial: 'BB998877665544', manufacturer: 'Kingston', model: 'DataTraveler', alias: null, approved: false, match_type: 'serial', first_seen: '2026-08-11T08:22:00Z' },
  ], 'devices')],
  [/\/printers/, () => page([{ id: 'pr1', name: 'HP LaserJet M404 (Reception)', port: 'IP_192.168.2.60', is_network: true, sanctioned: true }], 'printers')],
  [/\/rules\/stats|\/rules\/statistics/, () => ({ total: 24, enabled: 21, by_type: { regex: 14, keyword: 6, dictionary: 3, ml: 1 } })],
  [/\/rules/, () => ([{ id: 'r1', name: 'Aadhaar number', pattern: '\\b\\d{4}\\s?\\d{4}\\s?\\d{4}\\b', classification: 'Restricted', enabled: true, priority: 100, description: 'Twelve-digit Indian identity number.', rule_type: 'regex', created_at: '2026-05-04T00:00:00Z' }])],
  [/\/ml-classifier|\/ml\//, () => ({ model_version: '1.4.0', trained_at: '2026-07-30T04:00:00Z', accuracy: 0.94, classes: ['Public', 'Internal', 'Confidential', 'Restricted'], enabled: true })],
  [/\/data-matching|\/edm|\/fingerprint|\/sources/, () => ([{ id: 'dm1', name: 'Payroll roster', source_type: 'edm', kind: 'edm', classification: 'Restricted', record_count: 1840, records: 1840, enabled: true, created_at: '2026-06-01T00:00:00Z' }])],
  [/\/threat-intel|\/ioc|\/taxii/, () => page([{ id: 'ti1', indicator: 'evil.example.com', type: 'domain', source: 'internal', confidence: 80, added_at: '2026-08-10T00:00:00Z' }], 'indicators')],
  [/\/(users|admin\/users)/, () => ([
    { id: 'u1', username: 'a.rahman', full_name: 'Ayesha Rahman', email: 'a.rahman@corp.example', role: 'ADMIN', is_active: true, mfa_enabled: true, created_at: '2026-01-08T00:00:00Z' },
    { id: 'u2', username: 'v.nair', full_name: 'Vikram Nair', email: 'v.nair@corp.example', role: 'ANALYST', is_active: true, mfa_enabled: false, created_at: '2026-03-22T00:00:00Z' },
  ])],
  [/\/logs|\/log-explorer/, () => page(EVENTS, 'logs')],
  [/\/settings|\/config/, () => ({ siem_enabled: true, syslog_host: '192.168.2.60', retention_days: 90 })],
]

apiClient.defaults.adapter = async (config: any) => {
  const qs = new URLSearchParams(config.params || {}).toString()
  const url = String(config.url || '') + (qs ? `?${qs}` : '')
  const hit = MOCKS.find(([re]) => re.test(url))
  const data = hit ? hit[1](url) : {}
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

// A few callers still use bare fetch().
const realFetch = window.fetch
window.fetch = async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url || '')
  const hit = MOCKS.find(([re]) => re.test(url))
  if (hit) {
    return new Response(JSON.stringify(hit[1](url)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return realFetch(input, init)
}

useAuthStore.setState({
  accessToken: 'harness',
  refreshToken: 'harness',
  user: { id: 'u1', username: 'a.rahman', email: 'a.rahman@corp.example', role: 'ADMIN', permissions: ['*'] },
  isAuthenticated: true,
} as any)

/* ── Views ──────────────────────────────────────────────────────────────── */

const params = new URLSearchParams(location.search)
const view = params.get('view') || 'policy-modal'
const route = params.get('route') || '/dashboard'

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

function PolicyModalView() {
  const step = Number(params.get('step') || 1)
  const type = params.get('type') || 'web_activity_control'
  const editing =
    step > 1
      ? {
          id: 'demo',
          name: 'Generative AI prompt control',
          description: 'Blocks sensitive content going to generative-AI apps and cloud storage, alerts on webmail.',
          type,
          severity: 'high',
          enabled: true,
          priority: 100,
          config:
            type === 'web_activity_control'
              ? {
                  mode: 'enforce',
                  minLevel: 'Confidential',
                  matrix: {
                    genai: { post: 'block', attach: 'block', download: 'log' },
                    webmail: { send: 'alert', attach: 'alert' },
                    cloud_storage: { upload: 'block', download: 'log' },
                  },
                  appOverrides: [{ app_id: 'copilot', action: 'allow' }],
                  blockUninspectable: true,
                }
              : {},
          conditions: { match: 'all', rules: [] },
          actions: {},
        }
      : null
  return (
    <div style={{ minHeight: '100vh', background: 'var(--cs-bg)' }}>
      <PolicyCreatorModal isOpen onClose={() => {}} onSave={() => {}} editingPolicy={editing as any} />
    </div>
  )
}

function PageView() {
  const R: Record<string, any> = {
    '/dashboard': Dashboard,
    '/agents': Agents,
    '/events': Events,
    '/alerts': Alerts,
    '/rules': Rules,
    '/data-matching': DataMatching,
    '/ml-classifier': MLClassifier,
    '/usb-devices': UsbDevices,
    '/printers': Printers,
    '/policies': Policies,
    '/incidents': Incidents,
    '/log-explorer': LogExplorer,
    '/threat-intel': ThreatIntelligence,
    '/admin/users': UserManagement,
    '/settings': Settings,
  }
  return (
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          {Object.entries(R).map(([path, C]) => (
            <Route key={path} path={path.slice(1)} element={<C />} />
          ))}
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>{view === 'page' ? <PageView /> : <PolicyModalView />}</QueryClientProvider>,
)
