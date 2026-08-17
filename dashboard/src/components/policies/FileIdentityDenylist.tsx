import { FileIdentityDenylist as DenylistShape } from '@/types/policy'

interface Props {
  config: DenylistShape & Record<string, any>
  onChange: (config: any) => void
}

function parseTokens(s: string): string[] {
  return s.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
}
function normExt(e: string): string {
  const x = e.toLowerCase().replace(/^\*+/, '')
  return x.startsWith('.') ? x : '.' + x
}

// Optional file-identity denylist for the USB / Print channels: block or alert a
// file by custom extension or exact MD5/SHA-256 — independent of content
// classification, so it also catches renamed and non-text files.
export default function FileIdentityDenylist({ config, onChange }: Props) {
  const exts = config.blockedExtensions || []
  const hashes = config.blockedHashes || []
  const action = config.blockedHashAction || config.blockedExtensionAction || 'block'

  const setExts = (text: string) =>
    onChange({ ...config, blockedExtensions: parseTokens(text).map(normExt) })
  const setHashes = (text: string) =>
    onChange({ ...config, blockedHashes: parseTokens(text).map(h => h.toLowerCase()) })
  const setAction = (a: 'block' | 'alert') =>
    onChange({ ...config, blockedExtensionAction: a, blockedHashAction: a })

  const inputCls =
    'w-full px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-white ' +
    'placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all font-mono text-sm'

  return (
    <div className="space-y-4 pt-4 border-t border-cs-hair">
      <div>
        <h4 className="text-sm font-semibold text-cs-ink">File Identity Denylist <span className="text-cs-muted-2 font-normal">(optional)</span></h4>
        <p className="text-xs text-cs-muted mt-1">
          Block or alert on files by <strong>custom extension</strong> or <strong>exact hash</strong> — matched by file
          identity, so it also catches renamed files and non-text documents. Leave blank to disable.
        </p>
      </div>

      <div>
        <label className="block text-sm text-cs-ink-2 mb-1">Blocked file extensions</label>
        <input
          type="text"
          defaultValue={exts.join(', ')}
          onBlur={e => setExts(e.target.value)}
          placeholder=".dwg, .iso, .catpart"
          className={inputCls}
        />
        {exts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {exts.map((x, i) => (
              <span key={i} className="px-2 py-0.5 rounded bg-cs-indigo/20 text-cs-indigo text-xs font-mono">{x}</span>
            ))}
          </div>
        )}
        <p className="text-xs text-cs-muted-2 mt-1">Comma- or space-separated. Normalised to lowercase with a leading dot.</p>
      </div>

      <div>
        <label className="block text-sm text-cs-ink-2 mb-1">Blocked file hashes <span className="text-cs-muted-2">(MD5 or SHA-256)</span></label>
        <textarea
          defaultValue={hashes.join('\n')}
          onBlur={e => setHashes(e.target.value)}
          placeholder={'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nd41d8cd98f00b204e9800998ecf8427e'}
          rows={4}
          className={inputCls}
        />
        <p className="text-xs text-cs-muted-2 mt-1">One hash per line (or comma-separated). Case-insensitive.</p>
      </div>

      <div>
        <label className="block text-sm text-cs-ink-2 mb-1">On match</label>
        <select
          value={action}
          onChange={e => setAction(e.target.value as 'block' | 'alert')}
          className="px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink text-sm focus:border-cs-indigo"
        >
          <option value="block">Block the transfer/print</option>
          <option value="alert">Alert only (don't block)</option>
        </select>
      </div>
    </div>
  )
}
