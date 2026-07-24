import apiClient from './api'

export interface Classifier {
  id: string
  label: string
  category: string
}

export interface DocTypeMatch {
  type: string
  label: string
  category: string
  confidence: number
  matched_signals: string[]
}

export interface ClassifyResult {
  matched: boolean
  extract_kind: string
  document_types: DocTypeMatch[]
  note?: string
}

export const getCatalogue = async (): Promise<{ count: number; classifiers: Classifier[] }> => {
  const { data } = await apiClient.get('/document-classifier/')
  return data
}

export const classifyDocument = async (body: {
  content?: string
  file_b64?: string
  filename?: string
  top_k?: number
  min_confidence?: number
}): Promise<ClassifyResult> => {
  const { data } = await apiClient.post('/document-classifier/classify', body)
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
