import { useRef, useState } from 'react'
import { X, Upload, FileUp, Shield, CheckCircle2, XCircle, MinusCircle, Loader2 } from 'lucide-react'
import { importPolicies } from '@/lib/api'
import { extractErrorDetail } from '@/utils/errorUtils'
import toast from 'react-hot-toast'
import Modal, { ModalFooter } from '@/components/ui/Modal'

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
  replaced: { icon: CheckCircle2, cls: 'text-cs-indigo' },
  skipped: { icon: MinusCircle, cls: 'text-cs-muted' },
  failed: { icon: XCircle, cls: 'text-cs-crit' },
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
    <Modal
      open
      onClose={onClose}
      size="lg"
      bodyClassName="px-6 py-5 space-y-5"
      header={
        <div className="flex items-center gap-3">
          <div className="rounded-cs-sm bg-cs-indigo-faint p-2">
            <Upload className="h-5 w-5 text-cs-indigo" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-cs-ink">Import policies</h3>
            <p className="mt-0.5 text-[12.5px] text-cs-muted">Load policies from an exported JSON file.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-cs-sm p-1.5 text-cs-muted transition-colors hover:bg-cs-panel-2 hover:text-cs-ink
                       focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
      }
      footer={
        <ModalFooter>
          {result ? (
            <button onClick={onClose} className="btn btn-primary">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="btn btn-ghost">Cancel</button>
              <button onClick={handleImport} disabled={!parsed || importing} className="btn btn-primary">
                {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                Import{parsed ? ` (${parsed.length})` : ''}
              </button>
            </>
          )}
        </ModalFooter>
      }
    >
          {result ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                {([
                  ['Imported', result.imported, 'text-green-600'],
                  ['Replaced', result.replaced, 'text-cs-indigo'],
                  ['Skipped', result.skipped, 'text-cs-muted-2'],
                  ['Failed', result.failed, 'text-cs-crit'],
                ] as const).map(([label, n, cls]) => (
                  <div key={label} className="border border-cs-hair rounded-cs-sm p-3 text-center">
                    <div className={`text-2xl font-bold ${cls}`}>{n}</div>
                    <div className="text-xs text-cs-muted-2 mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
              <div className="border border-cs-hair rounded-cs-sm divide-y divide-gray-100 max-h-64 overflow-y-auto">
                {result.results.map((r, i) => {
                  const meta = STATUS_META[r.status] || STATUS_META.failed
                  const Icon = meta.icon
                  return (
                    <div key={i} className="flex items-start gap-2 px-3 py-2 text-sm">
                      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.cls}`} />
                      <div className="min-w-0">
                        <span className="font-medium text-cs-ink">{r.name}</span>
                        <span className="text-cs-muted"> — {r.detail}</span>
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
                className={`border-2 border-dashed rounded-cs-sm px-6 py-8 text-center cursor-pointer transition-colors ${
                  dragging ? 'border-cs-indigo bg-cs-indigo-faint' : 'border-cs-hair hover:border-cs-muted-2 hover:bg-cs-panel-2'
                }`}
              >
                <FileUp className="w-8 h-8 text-cs-muted mx-auto mb-2" />
                {fileName ? (
                  <p className="text-sm text-cs-ink-2">
                    <span className="font-medium">{fileName}</span>
                    {parsed && <span className="text-cs-muted"> — {parsed.length} {parsed.length === 1 ? 'policy' : 'policies'} found</span>}
                  </p>
                ) : (
                  <p className="text-sm text-cs-muted-2">
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
                  <div className="border border-cs-hair rounded-cs-sm max-h-48 overflow-y-auto divide-y divide-gray-100">
                    {parsed.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <Shield className="w-3.5 h-3.5 text-cs-ink-2 flex-shrink-0" />
                        <span className="font-medium text-cs-ink truncate">
                          {p?.name || <em className="text-cs-crit">unnamed</em>}
                        </span>
                        {p?.type && <span className="ml-auto text-xs text-cs-muted">{String(p.type).replace(/_/g, ' ')}</span>}
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-cs-ink-2 mb-2">
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
                            className="mt-1 text-cs-indigo focus:ring-blue-500"
                            checked={onConflict === val}
                            onChange={() => setOnConflict(val)}
                          />
                          <span className="text-sm">
                            <span className="font-medium text-cs-ink">{label}</span>
                            <span className="text-cs-muted"> — {help}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
    </Modal>
  )
}
