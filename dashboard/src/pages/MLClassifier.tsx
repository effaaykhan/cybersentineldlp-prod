import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, FlaskConical, Upload, RotateCcw, Shield } from 'lucide-react'
import toast from 'react-hot-toast'
import LoadingSpinner from '@/components/LoadingSpinner'
import ErrorMessage from '@/components/ErrorMessage'
import { extractErrorDetail } from '@/utils/errorUtils'
import {
  getStatus, predict, retrain, resetModel, fileToBase64,
  LEVELS, type Level, type MLStatus, type MLPrediction, type RetrainResult,
} from '@/lib/ml-classifier-api'

const LEVEL_STYLE: Record<Level, string> = {
  Public: 'badge-success',
  Internal: 'badge-info',
  Confidential: 'badge-warning',
  Restricted: 'badge-danger',
}

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`

export default function MLClassifier() {
  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ['ml-classifier-status'],
    queryFn: getStatus,
  })

  if (isLoading) return <LoadingSpinner size="lg" />
  if (error) return <ErrorMessage message="Failed to load ML classifier status" retry={() => refetch()} />

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow mb-1.5">Enforce</p>
        <h1 className="text-2xl font-bold tracking-tight text-cs-ink">ML Sensitivity Classifier</h1>
        <p className="mt-1 text-sm text-cs-ink-2 max-w-2xl">
          A machine-learning model classifies content into <strong>Public / Internal / Confidential /
          Restricted</strong> automatically on every transfer (USB, cloud, email). It only ever
          <em> raises</em> the enforced level, never lowers it — so it strengthens, and never weakens,
          your existing detection. Retrain it on your own labelled documents to fit your content.
        </p>
      </div>

      <StatusCard status={status!} />
      <Tester available={!!status?.available} />
      <RetrainCard />
    </div>
  )
}

function StatusCard({ status }: { status: MLStatus }) {
  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink mb-3">
        <BrainCircuit className="h-4 w-4 text-cs-indigo" /> Model status
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Status" value={status.available ? 'Active' : 'Unavailable'}
          tone={status.available ? 'ok' : 'bad'} />
        <Stat label="Cross-val accuracy" value={pct(status.cv_accuracy)} />
        <Stat label="Trained on" value={status.trained_on === 'synthetic' ? 'Built-in corpus'
          : status.trained_on === 'custom' ? 'Your data only' : 'Built-in + your data'} />
        <Stat label="Persisted" value={status.persisted ? 'Yes' : 'In-memory'} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {LEVELS.map((l) => (
          <span key={l} className="text-xs text-cs-ink-2">
            <span className={`badge ${LEVEL_STYLE[l]} mr-1`}>{l}</span>
            <span className="num">{status.counts?.[l] ?? 0}</span>
            {status.custom_counts?.[l] ? <span className="text-cs-indigo num"> (+{status.custom_counts[l]})</span> : null}
          </span>
        ))}
      </div>
      {status.trained_on === 'synthetic' && (
        <p className="mt-3 text-xs text-cs-muted">
          This is the built-in model trained on a synthetic corpus — a strong starting point.
          Retrain below on your real labelled documents for production accuracy.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div>
      <div className="text-xs text-cs-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'ok' ? 'text-cs-emerald' : tone === 'bad' ? 'text-cs-rose' : 'text-cs-ink'}`}>
        {value}
      </div>
    </div>
  )
}

function Tester({ available }: { available: boolean }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<MLPrediction | null>(null)

  const run = useMutation({
    mutationFn: () => predict(text),
    onSuccess: setResult,
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Prediction failed')),
  })

  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
        <FlaskConical className="h-4 w-4 text-cs-indigo" /> Test a prediction
      </div>
      <textarea
        className="input text-sm" rows={4} value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste any text to see how the model would classify it…"
      />
      <button className="btn btn-primary" disabled={!available || run.isPending || !text.trim()}
        onClick={() => run.mutate()}>
        {run.isPending ? 'Classifying…' : 'Classify'}
      </button>

      {result && (
        <div className="rounded-cs-sm border border-cs-hair p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className={`badge ${LEVEL_STYLE[result.level]}`}>{result.level}</span>
            <span className="num text-cs-indigo font-semibold">{pct(result.confidence)}</span>
            {!result.confident && (
              <span className="text-xs text-cs-muted">low confidence — would not raise the level</span>
            )}
          </div>
          <div className="space-y-1">
            {LEVELS.map((l) => (
              <div key={l} className="flex items-center gap-2">
                <span className="text-xs text-cs-ink-2 w-24">{l}</span>
                <div className="flex-1 h-2 rounded-full bg-cs-hair overflow-hidden">
                  <div className="h-full bg-cs-indigo" style={{ width: pct(result.probabilities?.[l]) }} />
                </div>
                <span className="text-xs num text-cs-muted w-10 text-right">{pct(result.probabilities?.[l])}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RetrainCard() {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [replace, setReplace] = useState(false)
  const [last, setLast] = useState<RetrainResult | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ml-classifier-status'] })

  const run = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a CSV file')
      const csv_b64 = await fileToBase64(file)
      return retrain({ csv_b64, replace })
    },
    onSuccess: (r) => {
      setLast(r)
      invalidate()
      toast.success(`Retrained — cross-val accuracy ${pct(r.cv_accuracy)}`)
    },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Retrain failed')),
  })

  const reset = useMutation({
    mutationFn: resetModel,
    onSuccess: () => { setLast(null); invalidate(); toast.success('Reset to the built-in model') },
    onError: (e: any) => toast.error(extractErrorDetail(e, 'Reset failed')),
  })

  return (
    <div className="rounded-cs-card border border-cs-hair bg-cs-panel p-5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
        <Shield className="h-4 w-4 text-cs-indigo" /> Retrain on your data <span className="badge badge-info">admin</span>
      </div>
      <p className="text-sm text-cs-ink-2">
        Upload a CSV whose rows are <code className="num">text,label</code> — the label is one of{' '}
        <span className="num">Public / Internal / Confidential / Restricted</span> (case-insensitive; a
        header row is fine). Aim for a few dozen real examples per level.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="btn btn-secondary cursor-pointer">
          <Upload className="h-4 w-4" /> {file ? file.name : 'Choose CSV'}
          <input type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-cs-ink-2">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Train on my data only (otherwise merge with the built-in corpus)
        </label>
        <button className="btn btn-primary" disabled={run.isPending || !file} onClick={() => run.mutate()}>
          {run.isPending ? 'Retraining…' : 'Retrain'}
        </button>
        <button className="btn btn-ghost text-cs-muted" disabled={reset.isPending} onClick={() => reset.mutate()}>
          <RotateCcw className="h-4 w-4" /> Reset to built-in
        </button>
      </div>

      {last && (
        <div className="rounded-cs-sm border border-cs-hair p-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>Examples added: <span className="num font-semibold">{last.examples_added ?? '—'}</span></span>
            <span>Cross-val accuracy:{' '}
              <span className="num text-cs-muted">{pct(last.cv_accuracy_before)}</span>
              <span className="mx-1">→</span>
              <span className="num text-cs-emerald font-semibold">{pct(last.cv_accuracy)}</span>
            </span>
            <span>Persisted: <span className="num">{last.persisted ? 'yes' : 'no'}</span></span>
          </div>
        </div>
      )}
      <p className="text-xs text-cs-muted">
        Retraining only ever helps the model raise protection on your content — it cannot weaken the
        regex, EDM, or fingerprint detection that already runs.
      </p>
    </div>
  )
}
