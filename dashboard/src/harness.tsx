/**
 * Design harness — renders the policy creator on its own so it can be looked at.
 *
 * Not part of the app and not built into it (vite only picks up index.html for
 * the production build). It exists because the policy modal is three steps deep
 * behind a login, and reviewing a design you cannot see is guesswork.
 *
 *   npx vite --port 5199
 *   then screenshot http://localhost:5199/harness.html?step=1
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import PolicyCreatorModal from './components/policies/PolicyCreatorModal'
import './styles/tokens.css'
import './index.css'

// The modal fetches the agent list on open. There is no API here, so answer it
// with something representative rather than letting the request hang.
const realFetch = window.fetch
window.fetch = async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input?.url || '')
  if (url.includes('/agents')) {
    return new Response(
      JSON.stringify({
        agents: [
          { agent_id: 'win-crypton-8f21a4c0', name: 'CRYPTON', status: 'active' },
          { agent_id: 'win-reception-2b77e910', name: 'RECEPTION-01', status: 'active' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (url.includes('/app-catalog')) {
    return new Response(
      JSON.stringify({
        entries: [
          { app_id: 'chatgpt', app_name: 'ChatGPT', category: 'genai' },
          { app_id: 'claude', app_name: 'Claude', category: 'genai' },
          { app_id: 'copilot', app_name: 'Microsoft Copilot', category: 'genai' },
          { app_id: 'gmail', app_name: 'Gmail', category: 'webmail' },
          { app_id: 'dropbox', app_name: 'Dropbox', category: 'cloud_storage' },
          { app_id: 'slack', app_name: 'Slack', category: 'collaboration' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return realFetch(input, init)
}

const params = new URLSearchParams(location.search)
const step = Number(params.get('step') || 1)
const type = params.get('type') || 'web_activity_control'

// Step 2 and 3 are only reachable with a chosen type, so pretend we are editing
// a policy of that type — which is also the state an operator lands in most.
const editing =
  step > 1
    ? {
        id: 'demo',
        name: 'Web Activity Control (test)',
        description:
          'Blocks sensitive content going to generative-AI apps and cloud storage, alerts on webmail.',
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

function Harness() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--cs-bg)' }}>
      <PolicyCreatorModal
        isOpen
        onClose={() => {}}
        onSave={() => {}}
        editingPolicy={editing as any}
      />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />)
