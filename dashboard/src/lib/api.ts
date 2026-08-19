import axios from 'axios'
import { useAuthStore } from './store/auth'
import { API_URL } from './config'

const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 second timeout
  maxRedirects: 5, // Follow redirects (default is 5, but explicit is better)
})

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
  // Get token from store (will be hydrated from localStorage by Zustand persist)
  const token = useAuthStore.getState().accessToken
  // Fallback: try to get token directly from localStorage if store hasn't hydrated yet
  let authToken = token
  if (!authToken) {
    try {
      const authData = localStorage.getItem('dlp-auth-v3')
      if (authData) {
        const parsed = JSON.parse(authData)
        authToken = parsed?.state?.accessToken
      }
    } catch (e) {
      // Ignore errors
    }
  }
  if (authToken && config.headers) {
    config.headers['Authorization'] = `Bearer ${authToken}`
  }
  return config
})

// Handle token refresh on 401
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      try {
        const refreshToken = useAuthStore.getState().refreshToken
        const response = await axios.post(
          `${API_URL}/auth/refresh`,
          { refresh_token: refreshToken }
        )

        const { access_token, refresh_token } = response.data
        useAuthStore.getState().setTokens(access_token, refresh_token)

        if (originalRequest.headers) {
          originalRequest.headers['Authorization'] = `Bearer ${access_token}`
        }
        return apiClient(originalRequest)
      } catch (refreshError) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      }
    }

    return Promise.reject(error)
  }
)

// Helper functions for Dashboard
export const getStats = async () => {
  const { data } = await apiClient.get('/dashboard/overview')
  return data
}

export const getEventTimeSeries = async (params?: { interval?: string; hours?: number }) => {
  const { data } = await apiClient.get('/dashboard/timeline', {
    params: params || { hours: 24 },
  })
  return data
}

export const getEventsByType = async () => {
  const { data } = await apiClient.get('/events/stats/by-type')
  return data
}

export const getEventsBySeverity = async () => {
  const { data } = await apiClient.get('/events/stats/by-severity')
  return data
}

// Export individual functions for direct imports
export const getAgents = async (params?: any) => {
  const { data } = await apiClient.get('/agents/', { params })
  return data
}

export const getAllAgents = async () => {
  const { data } = await apiClient.get('/agents/all')
  return data
}

export const deleteAgent = async (agentId: string) => {
  const { data } = await apiClient.delete(`/agents/${agentId}`)
  return data
}

/**
 * Pause an endpoint: it stops being policed and its events are discarded
 * until ``durationMinutes`` elapses. Pass null to pause until it is resumed
 * by hand. Reversible and non-destructive — the opposite of deleteAgent.
 */
export const suspendAgent = async (
  agentId: string,
  durationMinutes: number | null,
  reason?: string,
) => {
  const { data } = await apiClient.post(`/agents/${agentId}/suspend`, {
    duration_minutes: durationMinutes,
    reason: reason || null,
  })
  return data
}

/** Lift a pause early. Idempotent — safe on an agent that already resumed. */
export const resumeAgent = async (agentId: string) => {
  const { data } = await apiClient.post(`/agents/${agentId}/resume`)
  return data
}

// Additional exports for direct imports
export const getAlerts = async (params?: any) => {
  const { data } = await apiClient.get('/alerts/', { params })
  return data
}

export const searchEvents = async (params?: any) => {
  const { data } = await apiClient.get('/events/', { params })
  return data
}

export const clearAllEvents = async () => {
  const { data } = await apiClient.delete('/events/clear')
  return data
}

// Type exports
export type Agent = {
  id?: string
  agent_id: string
  /** Short numeric ID assigned by the Postgres sequence
   *  ``agent_code_seq``. The UI zero-pads it for display ("001"); the
   *  raw ``agent_id``/UUID stays the source of truth for API calls. */
  agent_code?: number
  name: string
  os: string
  ip_address: string
  last_seen: string
  created_at: string
  version?: string
  hostname?: string
  /** Precise OS product name, e.g. "Windows 11 Pro" / "Ubuntu 22.04.3 LTS". */
  os_name?: string | null
  /** Granular OS version/build, e.g. "23H2 (Build 22631.4460)" / kernel release. */
  os_version?: string
  /** Primary/active logged-in user on the endpoint (fallback of logged_in_users). */
  username?: string | null
  /** Every user with an active login session, active/console first. */
  logged_in_users?: string[] | null
  capabilities?: Record<string, boolean>
  /** True if heartbeat within ``AGENT_TIMEOUT_SECONDS``. Mirrors
   *  ``lifecycle_status === 'active'``. */
  is_active?: boolean
  /** Two-state label mirroring ``lifecycle_status``. */
  status_label?: 'active' | 'disconnected'
  /** Binary status computed by the backend: "active" if the heartbeat is
   *  fresh, otherwise "disconnected". */
  lifecycle_status?: 'active' | 'disconnected'
  /** Heartbeat age in seconds — handy for "Last seen X ago" without
   *  client-side timezone math. */
  last_seen_seconds_ago?: number | null
  /** Soft-delete flag. Hidden from the default listing; surface with
   *  ``GET /agents/all?include_deleted=true`` when auditing. */
  is_deleted?: boolean
  deleted_at?: string
  deleted_by?: string
  /** Temporarily paused: no policies are applied to this endpoint and its
   *  events are discarded. Distinct from ``is_deleted`` — a paused agent is
   *  still listed, still heartbeats, and comes back on its own. */
  is_suspended?: boolean
  /** When the pause auto-expires. Null while paused means "until someone
   *  resumes it" — there is no timer to wait for. */
  suspended_until?: string | null
  suspended_at?: string | null
  suspended_by?: string | null
  suspend_reason?: string | null
  /** Seconds until auto-resume; null when the pause is indefinite. */
  suspension_seconds_remaining?: number | null
}

export type Event = {
  id: string
  title?: string
  agent_id: string
  /** Server-enriched from the agents table at read time; absent only when
   *  the agent has been deleted. Pair with ``agent_code`` for display. */
  agent_name?: string
  agent_code?: number
  event_type: string
  event_subtype?: string
  severity: string
  description?: string
  classification_level?: string
  classification_score?: number
  classification_labels?: string[]
  classification_type?: string
  classification?: Array<{ label: string; confidence: number; [key: string]: any }>
  classification_metadata?: Record<string, any>
  classification_category?: string
  classification_rules_matched?: string[]
  document_type?: string
  document_type_label?: string
  document_types?: Array<{ type: string; label: string; category?: string; confidence?: number }>
  printer_name?: string
  block_reason?: string
  detected_content?: string
  file_path?: string
  file_name?: string
  file_id?: string
  file_md5?: string
  file_sha256?: string
  mime_type?: string
  folder_id?: string
  folder_name?: string
  folder_path?: string
  timestamp: string | Date
  content?: string
  clipboard_content?: string
  blocked?: boolean
  policy_id?: string | null
  action_taken?: string
  destination?: string | null
  source?: string
  user_email?: string
  matched_policies?: any[]
  metadata?: Record<string, any>
  details?: Record<string, any>
  // ── Web activity (browser extension) ───────────────────────────────────
  activity?: string
  app_category?: string
  app_id?: string
  app_name?: string
  page_url?: string
  page_host?: string
  text_content?: string
  text_truncated?: boolean
  attachment_names?: string[]
  recipients?: string
  policy_reason?: string
  matched_rules?: string[]
  mask_summary?: Array<{ type: string; count: number }>
  masked_text?: string
}

export const api = {
  // Dashboard
  getDashboardOverview: async () => {
    const { data } = await apiClient.get('/dashboard/overview')
    return data
    },
}

export const getEventTimeline = async (hours: number = 24) => {
  const { data } = await apiClient.get('/dashboard/timeline', {
    params: { hours },
  })
  return data
}

export const getAgentsStats = async () => {
  const { data } = await apiClient.get('/dashboard/stats/agents')
  return data
}

export const getClassificationStats = async () => {
  const { data } = await apiClient.get('/dashboard/stats/classification')
  return data
}

// Stats functions (aliases for backwards compatibility) - removed duplicates, using exports from above

export const getEvent = async (eventId: string) => {
  const { data } = await apiClient.get(`/events/${eventId}`)
  return data
}

export const getEventStats = async () => {
  const { data } = await apiClient.get('/events/stats/summary')
  return data
}

// Classification functions
export const getClassifiedFiles = async (params?: any) => {
  const { data } = await apiClient.get('/classification/files', { params })
  return data
}

export const getClassifiedFile = async (fileId: string) => {
  const { data } = await apiClient.get(`/classification/files/${fileId}`)
  return data
}

export const getClassificationSummary = async () => {
  const { data } = await apiClient.get('/classification/stats/summary')
  return data
}

export const getClassificationByType = async () => {
  const { data } = await apiClient.get('/classification/stats/by-type')
  return data
}

export const getDetectionPatterns = async () => {
  const { data } = await apiClient.get('/classification/patterns')
  return data
}

// Policies functions
export const getPolicies = async (params?: any) => {
  // Use trailing slash to avoid redirect
  const { data } = await apiClient.get('/policies/', { params })
  return data
}

export const getPolicy = async (policyId: string) => {
  const { data } = await apiClient.get(`/policies/${policyId}`)
  return data
}

export const createPolicy = async (policy: any) => {
  const { data } = await apiClient.post('/policies/', policy)
  return data
}

export const updatePolicy = async (policyId: string, policy: any) => {
  const { data } = await apiClient.put(`/policies/${policyId}`, policy)
  return data
}

export const deletePolicy = async (policyId: string) => {
  const { data } = await apiClient.delete(`/policies/${policyId}`)
  return data
}

export const getPolicyStats = async () => {
  const { data } = await apiClient.get('/policies/stats/summary')
  return data
}

export const enablePolicy = async (policyId: string) => {
  const { data } = await apiClient.post(`/policies/${policyId}/enable`)
  return data
}

export const disablePolicy = async (policyId: string) => {
  const { data } = await apiClient.post(`/policies/${policyId}/disable`)
  return data
}

export const refreshPolicyBundles = async () => {
  const { data } = await apiClient.post('/policies/cache/refresh')
  return data
}

export const importPolicies = async (payload: {
  policies: any[]
  on_conflict?: 'skip' | 'rename' | 'replace'
}) => {
  const { data } = await apiClient.post('/policies/import', payload)
  return data
}

// Events helper used by dashboard pages
export const getEvents = async (params?: any) => {
  const { data } = await apiClient.get('/events/', { params })
  // The backend returns a paginated envelope; the dashboard expects a flat list.
  return data.events || []
}

// Users functions
export const getCurrentUser = async () => {
  const { data } = await apiClient.get('/users/me')
  return data
}

export const getUsers = async (params?: any) => {
  const { data } = await apiClient.get('/users/', { params })
  return data
}

export const getUser = async (userId: string) => {
  const { data } = await apiClient.get(`/users/${userId}`)
  return data
}

export const getUserStats = async () => {
  const { data } = await apiClient.get('/users/stats/summary')
  return data
}

// ── Admin User Management ──
// These target the Phase-1 RBAC-enforced admin endpoints on /users.
// Distinct from the legacy `getUsers` / `getUser` helpers above which are
// used by the DLP user-activity monitoring page.

export type AdminUser = {
  id: string
  username: string | null
  email: string
  full_name: string
  role: string
  organization: string
  department: string | null
  clearance_level: number
  is_active: boolean
  created_at: string | null
  /** Effective permission set (role defaults ∪ direct grants), sorted. */
  permissions: string[]
  /** Direct grants only — subset of `permissions`. */
  direct_permissions: string[]
}

export type AdminUserCreateInput = {
  email: string
  password: string
  full_name: string
  role: string
  organization?: string
  username?: string
  department?: string
  clearance_level?: number
  /** Optional direct-grant permissions, unioned with the role defaults. */
  permissions?: string[]
}

export type AdminUserUpdateInput = {
  full_name?: string
  role?: string
  department?: string
  clearance_level?: number
  is_active?: boolean
  /** When present (even []), replaces the user's direct permission grants. */
  permissions?: string[]
}

export type PermissionDef = {
  id: string
  name: string
  description: string
}

export const listAllPermissions = async (): Promise<PermissionDef[]> => {
  const { data } = await apiClient.get('/permissions/')
  return data
}

export const adminListUsers = async (params?: {
  skip?: number
  limit?: number
  role?: string
  is_active?: boolean
}): Promise<AdminUser[]> => {
  const { data } = await apiClient.get('/users/', { params })
  return data
}

export const adminCreateUser = async (
  input: AdminUserCreateInput
): Promise<AdminUser> => {
  const { data } = await apiClient.post('/users/', input)
  return data
}

export const adminUpdateUser = async (
  userId: string,
  input: AdminUserUpdateInput
): Promise<AdminUser> => {
  const { data } = await apiClient.put(`/users/${userId}`, input)
  return data
}

export const adminDeactivateUser = async (userId: string) => {
  const { data } = await apiClient.delete(`/users/${userId}`)
  return data
}

/** Permanently delete a user row. Use with caution — referential cleanup
 *  is CASCADE/SET NULL; historical audit entries remain but lose the
 *  actor linkage. */
export const adminHardDeleteUser = async (userId: string) => {
  const { data } = await apiClient.delete(`/users/${userId}`, {
    params: { hard: true },
  })
  return data
}

// Alerts functions
export const acknowledgeAlert = async (alertId: string) => {
  const { data } = await apiClient.post(`/alerts/${alertId}/acknowledge`)
  return data
}

export const resolveAlert = async (alertId: string) => {
  const { data } = await apiClient.post(`/alerts/${alertId}/resolve`)
  return data
}

export const getAlert = async (alertId: string) => {
  const { data } = await apiClient.get(`/alerts/${alertId}`)
  return data
}

export const changePassword = async (
  username: string,
  currentPassword: string,
  newPassword: string,
  newPasswordConfirm: string
) => {
  const { data } = await apiClient.post('/auth/change-password', {
    username,
    current_password: currentPassword,
    new_password: newPassword,
    new_password_confirm: newPasswordConfirm,
  })
  return data
}

// ── Incident Management ──
export async function getIncidents(params?: { skip?: number; limit?: number; severity?: number; status?: string; assigned_to?: string }) {
  const { data } = await apiClient.get('/incidents/', { params })
  return data
}

export async function getIncident(id: string) {
  const { data } = await apiClient.get(`/incidents/${id}`)
  return data
}

export async function createIncident(payload: { event_id?: string; severity: number; title: string; description?: string }) {
  const { data } = await apiClient.post('/incidents/', payload)
  return data
}

export async function updateIncident(id: string, payload: { status?: string; assigned_to?: string }) {
  const { data } = await apiClient.patch(`/incidents/${id}`, payload)
  return data
}

export async function getIncidentComments(id: string) {
  const { data } = await apiClient.get(`/incidents/${id}/comments`)
  return data
}

export async function addIncidentComment(id: string, comment: string) {
  const { data } = await apiClient.post(`/incidents/${id}/comments`, { comment })
  return data
}

export async function getIncidentStats() {
  const { data } = await apiClient.get('/incidents/statistics')
  return data
}

// ── Auto Incidents (MongoDB-backed) ──
export async function getAutoIncidents(params?: { status?: string; severity?: number; limit?: number; skip?: number }) {
  const { data } = await apiClient.get('/incidents/auto/list', { params })
  return data
}

export async function getAutoIncident(id: string) {
  const { data } = await apiClient.get(`/incidents/auto/${id}`)
  return data
}

export async function updateAutoIncident(id: string, payload: { status?: string; assigned_to?: string }) {
  const { data } = await apiClient.patch(`/incidents/auto/${id}`, payload)
  return data
}

// ── Audit Logs ──
export async function getAuditLogs(params?: { skip?: number; limit?: number; user_id?: string; action?: string; start_date?: string; end_date?: string }) {
  const { data } = await apiClient.get('/audit-logs/', { params })
  return data
}

export async function getAuditActions() {
  const { data } = await apiClient.get('/audit-logs/actions')
  return data
}

// ── Fingerprints ──
export async function getFingerprints(params?: { skip?: number; limit?: number; label_id?: string }) {
  const { data } = await apiClient.get('/fingerprints/', { params })
  return data
}

export async function addFingerprint(payload: { hash: string; file_name?: string; label_id?: string }) {
  const { data } = await apiClient.post('/fingerprints/', payload)
  return data
}

export async function checkFingerprint(hash: string) {
  const { data } = await apiClient.post('/fingerprints/check', { hash })
  return data
}

export async function deleteFingerprint(id: string) {
  const { data } = await apiClient.delete(`/fingerprints/${id}`)
  return data
}

// ── Scan Jobs ──
export async function getScanJobs(params?: { skip?: number; limit?: number; status?: string }) {
  const { data } = await apiClient.get('/scans/', { params })
  return data
}

export async function createScanJob(target: string) {
  const { data } = await apiClient.post('/scans/', { target })
  return data
}

export async function getScanJob(id: string) {
  const { data } = await apiClient.get(`/scans/${id}`)
  return data
}

export async function getScanResults(jobId: string, params?: { skip?: number; limit?: number }) {
  const { data } = await apiClient.get(`/scans/${jobId}/results`, { params })
  return data
}

// ── Multi-factor authentication (self-service TOTP) ──────────────────────────
export type MfaStatus = { mfa_enabled: boolean; enrolled_at?: string | null }
export type MfaSetup = { secret: string; otpauth_uri: string; qr_svg: string }
export type MfaConfirm = { enabled: boolean; recovery_codes: string[] }

export const getMfaStatus = async (): Promise<MfaStatus> => {
  const { data } = await apiClient.get('/auth/mfa/status')
  return data
}

export const setupMfa = async (): Promise<MfaSetup> => {
  const { data } = await apiClient.post('/auth/mfa/setup')
  return data
}

export const confirmMfa = async (code: string): Promise<MfaConfirm> => {
  const { data } = await apiClient.post('/auth/mfa/confirm', { code })
  return data
}

export const disableMfa = async (code: string): Promise<{ enabled: boolean }> => {
  const { data } = await apiClient.post('/auth/mfa/disable', { code })
  return data
}

// ── Authorized-IP allowlist (Super Admin only) ──────────────────────────────
export type IPAllowlistEntry = {
  id: string
  cidr: string
  label?: string | null
  is_enabled: boolean
  created_at?: string | null
}
export type IPAllowlistResponse = {
  entries: IPAllowlistEntry[]
  your_ip: string
  enabled: boolean   // master switch: is whitelisting turned on
  enforced: boolean  // actually blocking right now (switch on AND ≥1 range)
}

export const getIpAllowlist = async (): Promise<IPAllowlistResponse> => {
  const { data } = await apiClient.get('/security/ip-allowlist')
  return data
}

export const toggleIpAllowlist = async (enabled: boolean): Promise<{ enabled: boolean }> => {
  const { data } = await apiClient.put('/security/ip-allowlist/toggle', { enabled })
  return data
}

export const addIpAllowlist = async (cidr: string, label?: string) => {
  const { data } = await apiClient.post('/security/ip-allowlist', { cidr, label })
  return data
}

export const deleteIpAllowlist = async (entryId: string) => {
  const { data } = await apiClient.delete(`/security/ip-allowlist/${entryId}`)
  return data
}

// ── SIEM log forwarding (connectors) ────────────────────────────────────────
export type SiemConnector = {
  name: string
  siem_type: string
  connected: boolean
  active: boolean
  host?: string | null
  port?: number | null
  protocol?: string | null
  format?: string | null
  min_severity?: string | null
}

export const getSiemConnectors = async (): Promise<SiemConnector[]> => {
  const { data } = await apiClient.get('/siem/connectors')
  return data?.connectors || []
}

export const registerSyslogConnector = async (cfg: {
  name: string
  host: string
  port: number
  protocol: string
  log_format: string
  facility: string
  min_severity: string
}) => {
  const { data } = await apiClient.post('/siem/connectors', {
    ...cfg,
    siem_type: 'syslog',
  })
  return data
}

export const testSiemConnector = async (name: string) => {
  const { data } = await apiClient.post(`/siem/connectors/${encodeURIComponent(name)}/test`)
  return data
}

export const deleteSiemConnector = async (name: string) => {
  const { data } = await apiClient.delete(`/siem/connectors/${encodeURIComponent(name)}`)
  return data
}

// ── Threat Intelligence (IOC / STIX / TAXII) ────────────────────────────────
export type IOC = {
  id: string
  ioc_type: string
  value: string
  name?: string | null
  tlp?: string | null
  confidence?: number | null
  source?: string | null
  direction?: string | null
  is_shared: boolean
  is_active: boolean
  created_at?: string | null
}
export type TaxiiFeed = {
  id: string
  name: string
  server_url: string
  collection_id?: string | null
  last_polled_at?: string | null
  last_status?: string | null
  total_imported: number
}
export type IocStats = {
  total: number
  active: number
  shared: number
  feeds: number
  by_type: Record<string, number>
}

export type SharingConfig = {
  enabled: boolean
  username: string
  has_password: boolean
  source: 'database' | 'environment'
  taxii_path: string
  collection_id: string
  updated_at: string | null
}

export const getIocs = async (params?: { ioc_type?: string; shared?: boolean; q?: string }): Promise<IOC[]> => {
  const { data } = await apiClient.get('/threat-intel/iocs', { params })
  return data?.iocs || []
}
export const getIocStats = async (): Promise<IocStats> => {
  const { data } = await apiClient.get('/threat-intel/stats')
  return data
}
export const addIoc = async (body: { ioc_type: string; value: string; tlp?: string; confidence?: number; name?: string }) => {
  const { data } = await apiClient.post('/threat-intel/iocs', body)
  return data
}
export const deleteIoc = async (id: string) => {
  const { data } = await apiClient.delete(`/threat-intel/iocs/${id}`)
  return data
}
export const shareIoc = async (id: string, shared: boolean) => {
  const { data } = await apiClient.post(`/threat-intel/iocs/${id}/share`, { shared })
  return data
}
export const importIocs = async (format: 'csv' | 'stix', content: string) => {
  const { data } = await apiClient.post('/threat-intel/iocs/import', { format, content })
  return data
}
export const getTaxiiFeeds = async (): Promise<TaxiiFeed[]> => {
  const { data } = await apiClient.get('/threat-intel/feeds')
  return data?.feeds || []
}
export const addTaxiiFeed = async (body: { name: string; server_url: string; collection_id?: string; username?: string; password?: string }) => {
  const { data } = await apiClient.post('/threat-intel/feeds', body)
  return data
}
export const deleteTaxiiFeed = async (id: string) => {
  const { data } = await apiClient.delete(`/threat-intel/feeds/${id}`)
  return data
}
export const pollTaxiiFeed = async (id: string) => {
  const { data } = await apiClient.post(`/threat-intel/feeds/${id}/poll`)
  return data
}
export const getIocMatches = async (): Promise<any[]> => {
  const { data } = await apiClient.get('/threat-intel/matches')
  return data?.matches || []
}

export const getSharingConfig = async (): Promise<SharingConfig> => {
  const { data } = await apiClient.get('/threat-intel/sharing')
  return data
}
export const updateSharingConfig = async (
  body: { enabled: boolean; username?: string; password?: string },
): Promise<SharingConfig> => {
  const { data } = await apiClient.put('/threat-intel/sharing', body)
  return data
}

export type RetentionConfig = {
  event_retention_days: number
  opensearch_retention_days: number
  minimum_days: number
  source: 'database' | 'environment'
  updated_at: string | null
}
export const getRetentionConfig = async (): Promise<RetentionConfig> => {
  const { data } = await apiClient.get('/system/retention')
  return data
}

export interface AboutInfo {
  version: string
  service: string
  backend: string
  opensearch: string
}
export const getAbout = async (): Promise<AboutInfo> => {
  const { data } = await apiClient.get('/system/about')
  return data
}
export const updateRetentionConfig = async (
  body: { event_retention_days: number; opensearch_retention_days: number },
): Promise<RetentionConfig> => {
  const { data } = await apiClient.put('/system/retention', body)
  return data
}


export default apiClient
