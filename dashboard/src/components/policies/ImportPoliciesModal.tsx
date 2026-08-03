import { useRef, useState } from 'react'
import { X, Upload, FileUp, Shield, CheckCircle2, XCircle, MinusCircle, Loader2 } from 'lucide-react'
import { importPolicies } from '@/lib/api'
import { extractErrorDetail } from '@/utils/errorUtils'
import toast from 'react-hot-toast'

interface ImportPoliciesModalProps {
  isOpen: boolean
  onClose: () => void
  onImported: () => void
}

type ImportResult = {
  total: number
  imported: number
  replaced: number
  skipped: number
  failed: number
  results: { name: string; status: string; detail: string }[]
}

type ConflictMode = 'skip' | 'rename' | 'replace'

const STATUS_META: Record<string, { icon: typeof CheckCircle2; cls: string }> = {
  created: { icon: CheckCircle2, cls: 'text-green-600' },
  replaced: { icon: CheckCircle2, cls: 'text-blue-600' },
  skipped: { icon: MinusCircle, cls: 'text-gray-400' },
  failed: { icon: XCircle, cls: 'text-red-500' },
}

export default function ImportPoliciesModal({ isOpen, onClose, onImported }: ImportPoliciesModalProps) {
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<any[] | null>(null)
  const [onConflict, setOnConflict] = useState<ConflictMode>('skip')
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const loadFile = async (file: File) => {
    setResult(null)
    setFileName(file.name)
    try {
      const data = JSON.parse(await file.text())
      // Accept an export envelope ({policies: [...]}) or a bare array of policies.
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.policies) ? data.policies : null
      if (!list) {
        toast.error('That file has no "policies" array')
        setParsed(null)
        return
      }
      if (list.length === 0) {
        toast.error('No policies found in the file')
        setParsed(null)
        return
      }
      setParsed(list)
    } catch {
      toast.error('Could not parse the file — is it valid JSON?')
      setParsed(null)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) loadFile(file)
  }

  const handleImport = async () => {
    if (!parsed) return
    setImporting(true)
    try {
      const res: ImportResult = await importPolicies({ policies: parsed, on_conflict: onConflict })
      setResult(res)
      onImported()
      const applied = res.imported + res.replaced
      if (applied > 0) {
        const extra = [res.skipped ? `${res.skipped} skipped` : '', res.failed ? `${res.failed} failed` : '']
          .filter(Boolean).join(', ')
        toast.success(`${applied} imported${extra ? ` — ${extra}` : ''}`)
      } else if (res.skipped && !res.failed) {
        toast(`All ${res.skipped} already existed — nothing changed`)
      } else {
        toast.error('Nothing imported')
      }
    } catch (e: any) {
      toast.error(extractErrorDetail(e, 'Import failed'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] flex flex-col border border-gray-200 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100">
              <Upload className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-900">Import Policies</h3>
              <p className="text-sm text-gray-600 mt-0.5">Load policies from an exported JSON file.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {result ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                {([
                  ['Imported', result.imported, 'text-green-600'],
                  ['Replaced', result.replaced, 'text-blue-600'],
                  ['Skipped', result.skipped, 'text-gray-500'],
                  ['Failed', result.failed, 'text-red-500'],
                ] as const).map(([label, n, cls]) => (
                  <div key={label} className="border border-gray-200 rounded-lg p-3 text-center">
                    <div className={`text-2xl font-bold ${cls}`}>{n}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto">
                {result.results.map((r, i) => {
                  const meta = STATUS_META[r.status] || STATUS_META.failed
                  const Icon = meta.icon
                  return (
                    <div key={i} className="flex items-start gap-2 px-3 py-2 text-sm">
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.cls}`} />
                      <div className="min-w-0">
                        <span className="font-medium text-gray-800">{r.name}</span>
                        <span className="text-gray-400"> — {r.detail}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <>
              {/* Dropzone / picker */}
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-lg px-6 py-8 text-center cursor-pointer transition-colors ${
                  dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
                }`}
              >
                <FileUp className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                {fileName ? (
                  <p className="text-sm text-gray-700">
                    <span className="font-medium">{fileName}</span>
                    {parsed && <span className="text-gray-400"> — {parsed.length} {parsed.length === 1 ? 'policy' : 'policies'} found</span>}
                  </p>
                ) : (
                  <p className="text-sm text-gray-500">
                    Drop a policy <span className="font-medium">.json</span> file here, or click to browse
                  </p>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = '' }}
                />
              </div>

              {/* Preview + conflict handling */}
              {parsed && (
                <>
                  <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100">
                    {parsed.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <Shield className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                        <span className="font-medium text-gray-800 truncate">
                          {p?.name || <em className="text-red-500">unnamed</em>}
                        </span>
                        {p?.type && <span className="ml-auto text-xs text-gray-400">{String(p.type).replace(/_/g, ' ')}</span>}
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      If a policy with the same name already exists
                    </label>
                    <div className="space-y-1.5">
                      {([
                        ['skip', 'Skip it', 'Keep the existing policy, ignore the incoming one'],
                        ['rename', 'Import a copy', 'Add it under a unique "(imported)" name'],
                        ['replace', 'Overwrite', 'Replace the existing policy with the imported one'],
                      ] as const).map(([val, label, help]) => (
                        <label key={val} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="onConflict"
                            className="mt-1 text-blue-600 focus:ring-blue-500"
                            checked={onConflict === val}
                            onChange={() => setOnConflict(val)}
                          />
                          <span className="text-sm">
                            <span className="font-medium text-gray-800">{label}</span>
                            <span className="text-gray-400"> — {help}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
          {result ? (
            <button onClick={onClose} className="btn-primary">Done</button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!parsed || importing}
                className="btn-primary gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                Import {parsed ? `(${parsed.length})` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
