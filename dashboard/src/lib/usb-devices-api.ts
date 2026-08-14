import apiClient from './api'

export type UsbMatchType = 'serial' | 'manufacturer' | 'device_id' | 'model'
export type UsbDecision = 'allow' | 'deny'

export interface SanctionedDevice {
  id: string
  match_type: UsbMatchType
  match_value?: string | null
  decision: UsbDecision
  alias?: string | null
  serial_number?: string | null
  label?: string | null
  vendor_id?: string | null
  product_id?: string | null
  product_name?: string | null
  manufacturer?: string | null
  is_enabled: boolean
  notes?: string | null
  approved_at?: string | null
  // Live state. `connected` is true ONLY when the agent that reported the plug-in
  // is still beating; when that endpoint is offline the honest answer is
  // "unknown", not "connected" — no disconnect is ever emitted by a machine
  // that was shut down. Prefer connection_state for display.
  connected?: boolean | null
  connection_state?: 'connected' | 'disconnected' | 'unknown' | null
  reporting_host?: string | null
  reporting_agent_online?: boolean | null
  last_seen?: string | null
}

export interface SeenDevice {
  serial_number: string
  // True when this device was cleared off the triage queue. It is NOT allowed
  // by that — strict allowlist still blocks it — only hidden from the list.
  dismissed?: boolean
  vendor_id?: string | null
  product_id?: string | null
  product_name?: string | null
  manufacturer?: string | null
  volume_label?: string | null
  drive_letter?: string | null
  agent_id?: string | null
  host?: string | null
  last_seen?: string | null
  connected?: boolean | null
  connection_state?: 'connected' | 'disconnected' | 'unknown' | null
  reporting_agent_online?: boolean | null
  sanctioned: boolean
}

export interface DeviceListResponse {
  devices: SanctionedDevice[]
  count: number
  enabled_count: number
  allow_count: number
  deny_count: number
  enforced: boolean
}

export interface ApproveBody {
  match_type?: UsbMatchType
  decision?: UsbDecision
  match_value?: string
  serial_number?: string
  alias?: string
  label?: string
  vendor_id?: string
  product_id?: string
  product_name?: string
  manufacturer?: string
  notes?: string
}

export interface DeviceActivityEvent {
  event: 'connect' | 'disconnect'
  timestamp?: string | null
  agent_id?: string | null
  host?: string | null
  user_email?: string | null
  drive_letter?: string | null
  volume_label?: string | null
}

export interface DeviceActivity {
  serial_number: string
  events: DeviceActivityEvent[]
  count: number
}

export const listDevices = async (): Promise<DeviceListResponse> => {
  const { data } = await apiClient.get('/usb-devices/')
  return data
}

export const seenDevices = async (
  includeDismissed = false,
): Promise<{
  devices: SeenDevice[]
  count: number
  dismissed_count: number
  include_dismissed: boolean
}> => {
  const { data } = await apiClient.get('/usb-devices/seen', {
    params: includeDismissed ? { include_dismissed: true } : undefined,
  })
  return data
}

export const approveDevice = async (body: ApproveBody): Promise<SanctionedDevice> => {
  const { data } = await apiClient.post('/usb-devices/', body)
  return data
}

export const updateDevice = async (
  id: string,
  body: { alias?: string; label?: string; notes?: string; is_enabled?: boolean },
): Promise<SanctionedDevice> => {
  const { data } = await apiClient.patch(`/usb-devices/${id}`, body)
  return data
}

export const revokeDevice = async (id: string): Promise<void> => {
  await apiClient.delete(`/usb-devices/${id}`)
}

export const getDeviceActivity = async (serial: string): Promise<DeviceActivity> => {
  const { data } = await apiClient.get('/usb-devices/activity', { params: { serial } })
  return data
}

export const dismissSeenDevice = async (body: {
  serial_number: string
  product_name?: string
  manufacturer?: string
  note?: string
}): Promise<{ serial_number: string; dismissed: boolean; already: boolean }> => {
  const { data } = await apiClient.post('/usb-devices/seen/dismiss', body)
  return data
}

export const restoreSeenDevice = async (serial: string): Promise<void> => {
  await apiClient.delete(`/usb-devices/seen/dismiss/${encodeURIComponent(serial)}`)
}
