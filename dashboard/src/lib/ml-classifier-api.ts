import apiClient from './api'

export const LEVELS = ['Public', 'Internal', 'Confidential', 'Restricted'] as const
export type Level = (typeof LEVELS)[number]

export interface MLStatus {
  available: boolean
  enabled: boolean
  model: string
  levels: Level[]
  min_confidence: number
  trained_on: string
  counts: Record<string, number>
  custom_counts?: Record<string, number>
  cv_accuracy: number | null
  persisted: boolean
  model_path: string
}

export interface MLPrediction {
  level: Level
  confidence: number
  confident: boolean
  probabilities: Record<string, number>
  model: string
  trained_on: string
}

export interface RetrainResult {
  ok: boolean
  persisted: boolean
  trained_on: string
  counts: Record<string, number>
  custom_counts?: Record<string, number>
  cv_accuracy: number | null
  cv_accuracy_before?: number | null
  examples_added?: number
}

export const getStatus = async (): Promise<MLStatus> => {
  const { data } = await apiClient.get('/ml-classifier/status')
  return data
}

export const predict = async (content: string): Promise<MLPrediction> => {
  const { data } = await apiClient.post('/ml-classifier/predict', { content })
  return data
}

export const retrain = async (body: {
  examples?: Record<string, string[]>
  csv_b64?: string
  replace?: boolean
}): Promise<RetrainResult> => {
  const { data } = await apiClient.post('/ml-classifier/retrain', body)
  return data
}

export const resetModel = async (): Promise<MLStatus> => {
  const { data } = await apiClient.post('/ml-classifier/reset', {})
  return data
}

export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = String(reader.result || '')
      resolve(res.includes(',') ? res.split(',')[1] : res)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
