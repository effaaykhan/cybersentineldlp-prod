import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ScanText, FlaskConical, FileUp } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { extractErrorDetail } from '@/utils/errorUtils'
import {
  getCatalogue, classifyDocument, fileToBase64,
  type Classifier, type ClassifyResult,
} from '@/lib/document-classifier-api'

const CATEGORY_LABEL: Record<string, string> = {
  identity: 'Identity documents',
  legal_ip: 'Legal & IP',
  financial: 'Financial',
  technical: 'Technical',
  corporate: 'Corporate',
  healthcare: 'Healthcare',
  security: 'Security',
}

export default function DocumentClassifiers() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['doc-classifier-catalogue'],
    queryFn: getCatalogue,
  })

  const grouped = useMemo(() => {
    const g: Record<string, Classifier[]> = {}
    for (const c of data?.classifiers || []) (g[c.category] ||= []).push(c)
    return g
  }, [data])

  if (isLoading) return <LoadingSpinner size="lg" />
  if (error) return <ErrorMessage message="Failed to load classifiers" retry={() => refetch()} />

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-1.5">Enforce</p>
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">Document Classifiers</h1>
        <p className="mt-1 text-sm text-cs-ink-2 max-w-2xl">
          {data?.count} built-in classifiers identify <strong>what kind</strong> of document or image
          content is — a patent, an M&amp;A agreement, a passport, source code, and more. Images and
          scanned PDFs are read via OCR first. The detected type rides along on every transfer as a
          policy-matchable field; it does not change existing detection.
        </p>
      </div>

      <Tester />

      {/* Catalogue */}
      <div className="space-y-5">
        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-cs-muted mb-2">
              {CATEGORY_LABEL[cat] || cat}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {items.map((c) => (
                <div key={c.id} className="rounded-cs-sm border border-cs-hair bg-cs-panel px-3 py-2">
                  <div className="text-sm font-medium text-cs-ink">{c.label}</div>
                  <div className="text-xs num text-cs-muted">{c.id}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Tester() {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ClassifyResult | null>(null)

  const run = useMutation({
    mutationFn: async () => {
      if (file) {
        const file_b64 = await fileToBase64(file)
        return classifyDocument({ file_b64, filename: file.name })
      }
      if (!text.trim()) throw new Error('Paste text or choose a file')
      return classifyDocument({ content: text })
    },
    onSuccess: (r) => setResult(r),
    onError: (e: any) => toast.error(extractErrorDetail(e, e?.message || 'Classification failed')),
  })

  const conf = (n: number) => `${Math.round(n * 100)}%`

  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
        <FlaskConical className="h-4 w-4 text-cs-indigo" /> Classify content
      </div>
      <textarea
        className="input text-sm" rows={5} value={text}
        onChange={(e) => { setText(e.target.value); setFile(null) }}
        placeholder="Paste document text — a patent claim, an invoice, source code…"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <label className="btn btn-secondary cursor-pointer">
          <FileUp className="h-4 w-4" /> {file ? file.name : 'Upload file / image'}
          <input type="file" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] || null); setText('') }} />
        </label>
        <button className="btn btn-primary" disabled={run.isPending || (!text.trim() && !file)} onClick={() => run.mutate()}>
          <ScanText className="h-4 w-4" /> {run.isPending ? 'Classifying…' : 'Classify'}
        </button>
        {file && <button className="text-xs text-cs-muted underline" onClick={() => setFile(null)}>clear file</button>}
      </div>

      {result && (
        <div className="rounded-cs-sm border border-cs-hair p-3 mt-1">
          {result.extract_kind && result.extract_kind !== 'text' && (
            <div className="text-xs text-cs-muted mb-2">Read via <span className="num">{result.extract_kind}</span></div>
          )}
          {result.document_types.length === 0 ? (
            <div className="text-sm text-cs-muted">No document type recognised.</div>
          ) : (
            <ul className="space-y-2">
              {result.document_types.map((d) => (
                <li key={d.type} className="text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-cs-ink">{d.label}</span>
                    <span className="badge badge-info">{d.category}</span>
                    <span className="ml-auto num text-cs-indigo font-semibold">{conf(d.confidence)}</span>
                  </div>
                  {d.matched_signals?.length > 0 && (
                    <div className="text-xs text-cs-muted mt-0.5">signals: {d.matched_signals.join(', ')}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
