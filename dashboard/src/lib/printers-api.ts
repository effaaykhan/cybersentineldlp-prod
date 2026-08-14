import apiClient from './api'

export interface SanctionedPrinter {
  id: string
  printer_name: string
  label?: string | null
  printer_type?: string | null
  is_enabled: boolean
  // 'allow' = sanctioned; 'deny' = explicitly disapproved (blocked in every scope).
  decision: 'allow' | 'deny'
  notes?: string | null
  approved_at?: string | null
}

export interface SeenPrinter {
  printer_name: string
  agent_id?: string | null
  last_action?: string | null
  last_seen?: string | null
  sanctioned: boolean
}

export interface PrinterListResponse {
  printers: SanctionedPrinter[]
  count: number
  enabled_count: number
  allow_count: number
  deny_count: number
  // Allowlist scope is active — ALLOW rows decide which printers work.
  enforced: boolean
  // Any printer_control policy is active — DENY rows bite in every scope.
  deny_enforced: boolean
}

export const listPrinters = async (): Promise<PrinterListResponse> => {
  const { data } = await apiClient.get('/printers/')
  return data
}

export const seenPrinters = async (): Promise<{ printers: SeenPrinter[]; count: number }> => {
  const { data } = await apiClient.get('/printers/seen')
  return data
}

export const approvePrinter = async (body: {
  printer_name: string
  label?: string
  printer_type?: string
  notes?: string
  decision?: 'allow' | 'deny'
}): Promise<SanctionedPrinter> => {
  const { data } = await apiClient.post('/printers/', body)
  return data
}

export const updatePrinter = async (
  id: string,
  body: { label?: string; notes?: string; is_enabled?: boolean; decision?: 'allow' | 'deny' },
): Promise<SanctionedPrinter> => {
  const { data } = await apiClient.patch(`/printers/${id}`, body)
  return data
}

export const revokePrinter = async (id: string): Promise<void> => {
  await apiClient.delete(`/printers/${id}`)
}
