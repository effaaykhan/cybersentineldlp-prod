'use client'

import { useState } from 'react'
import { FileTransferConfig } from '@/types/policy'
import { Plus, Trash2, X } from 'lucide-react'
import { predefinedPatterns } from '@/utils/policyUtils'

interface Props {
  config: FileTransferConfig
  onChange: (config: FileTransferConfig) => void
}

const commonExtensions = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.txt', '.json', '.xml', '.sql', '.zip', '.rar', '.7z', '.db']

export default function FileTransferPolicyForm({ config, onChange }: Props) {
  const [newSource, setNewSource] = useState('')
  const [newDest, setNewDest] = useState('')
  const [newExtension, setNewExtension] = useState('')

  const update = (partial: Partial<FileTransferConfig>) =>
    onChange({ ...config, ...partial })

  // ── Source / destination path management ──────────────────────────
  const handleAddSource = () => {
    const v = newSource.trim()
    if (!v) { alert('Please enter a path'); return }
    if (config.protectedPaths.includes(v)) { alert('Path already added'); return }
    update({ protectedPaths: [...config.protectedPaths, v] })
    setNewSource('')
  }
  const handleRemoveSource = (i: number) =>
    update({ protectedPaths: config.protectedPaths.filter((_, idx) => idx !== i) })

  const handleAddDest = () => {
    const v = newDest.trim()
    if (!v) { alert('Please enter a path'); return }
    if (config.monitoredDestinations.includes(v)) { alert('Path already added'); return }
    update({ monitoredDestinations: [...config.monitoredDestinations, v] })
    setNewDest('')
  }
  const handleRemoveDest = (i: number) =>
    update({ monitoredDestinations: config.monitoredDestinations.filter((_, idx) => idx !== i) })

  // ── File extensions ───────────────────────────────────────────────
  const handleToggleExtension = (ext: string) => {
    const cur = config.fileExtensions || []
    const next = cur.includes(ext) ? cur.filter(e => e !== ext) : [...cur, ext]
    update({ fileExtensions: next.length ? next : undefined })
  }
  const handleAddCustomExtension = () => {
    if (!newExtension.trim()) { alert('Please enter a file extension'); return }
    const ext = newExtension.startsWith('.') ? newExtension : `.${newExtension}`
    const cur = config.fileExtensions || []
    if (cur.includes(ext)) { alert('Extension already added'); return }
    update({ fileExtensions: [...cur, ext] })
    setNewExtension('')
  }
  const handleRemoveExtension = (ext: string) => {
    const cur = config.fileExtensions || []
    update({ fileExtensions: cur.filter(e => e !== ext) })
  }

  // ── Events / patterns ─────────────────────────────────────────────
  const toggleEvent = (key: keyof FileTransferConfig['events']) =>
    update({ events: { ...config.events, [key]: !config.events[key] } })

  const selectedPredefined = config.patterns?.predefined ?? []
  const handlePredefinedToggle = (id: string) => {
    const next = selectedPredefined.includes(id)
      ? selectedPredefined.filter(p => p !== id)
      : [...selectedPredefined, id]
    update({
      patterns: {
        predefined: next,
        custom: config.patterns?.custom ?? [],
      },
    })
  }

  return (
    <div className="space-y-6">
      {/* Info banner explaining the FT semantic */}
      <div className="rounded-lg border border-indigo-500/30 bg-indigo-900/10 p-3 text-xs text-indigo-200">
        <strong>How this policy fires:</strong> the agent watches the destination paths below. When a file appears at a destination and its content matches one of the selected patterns, the agent looks up the same file (by SHA-256) inside the protected source paths to attribute the event back to its origin.
      </div>

      {/* Protected source paths */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Protected Source Paths *
        </label>
        <p className="text-xs text-gray-400 mb-3">
          Folders containing sensitive originals. Used as the lookup pool when matching a file that arrives at a destination.
        </p>

        {config.protectedPaths.length > 0 && (
          <div className="space-y-2 mb-3">
            {config.protectedPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg border border-gray-700"
              >
                <code className="text-sm text-indigo-300 flex-1">{path}</code>
                <button
                  onClick={() => handleRemoveSource(index)}
                  className="ml-3 p-1 text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddSource()}
            placeholder="e.g., C:\\Sensitive or /opt/data"
            className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
          />
          <button
            onClick={handleAddSource}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      {/* Destination paths */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Destination Paths to Monitor *
        </label>
        <p className="text-xs text-gray-400 mb-3">
          Folders the agent watches for arriving files. Activity here can fire the policy.
        </p>

        {config.monitoredDestinations.length > 0 && (
          <div className="space-y-2 mb-3">
            {config.monitoredDestinations.map((path, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg border border-gray-700"
              >
                <code className="text-sm text-indigo-300 flex-1">{path}</code>
                <button
                  onClick={() => handleRemoveDest(index)}
                  className="ml-3 p-1 text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newDest}
            onChange={(e) => setNewDest(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddDest()}
            placeholder="e.g., D:\\Staging or /mnt/share"
            className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
          />
          <button
            onClick={handleAddDest}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      {/* File Extensions */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          File Extensions (Optional)
        </label>
        <p className="text-xs text-gray-400 mb-3">
          Leave empty to scan all file types arriving at the destinations.
        </p>

        <div className="flex flex-wrap gap-2 mb-3">
          {commonExtensions.map((ext) => {
            const isSelected = config.fileExtensions?.includes(ext) || false
            return (
              <button
                key={ext}
                onClick={() => handleToggleExtension(ext)}
                className={`px-3 py-1 rounded-lg border-2 text-sm font-mono transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-900/30 text-white'
                    : 'border-gray-600 bg-gray-900/30 text-gray-400 hover:border-gray-500'
                }`}
              >
                {ext}
              </button>
            )
          })}
        </div>

        {config.fileExtensions && config.fileExtensions.length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-gray-400 mb-2">Selected Extensions:</div>
            <div className="flex flex-wrap gap-2">
              {config.fileExtensions.map((ext) => (
                <div
                  key={ext}
                  className="flex items-center gap-2 px-3 py-1 bg-indigo-900/30 border border-indigo-500/50 rounded-lg text-sm"
                >
                  <code className="text-indigo-300">{ext}</code>
                  <button
                    onClick={() => handleRemoveExtension(ext)}
                    className="text-gray-400 hover:text-red-400 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={newExtension}
            onChange={(e) => setNewExtension(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddCustomExtension()}
            placeholder="e.g., .custom or custom"
            className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
          />
          <button
            onClick={handleAddCustomExtension}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      {/* Sensitive Data Patterns */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Sensitive Data Patterns *
        </label>
        <p className="text-xs text-gray-400 mb-3">
          At least one pattern is required. Arriving files are scanned for these data types — the policy only fires when a match is found.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {predefinedPatterns.map((pattern) => {
            const isSelected = selectedPredefined.includes(pattern.id)
            return (
              <div
                key={pattern.id}
                onClick={() => handlePredefinedToggle(pattern.id)}
                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-900/30'
                    : 'border-gray-600 bg-gray-900/30 hover:border-gray-500'
                }`}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    className="mt-1 w-4 h-4 text-indigo-600 rounded"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-sm text-white">{pattern.name}</div>
                    <div className="text-xs mt-1 opacity-70 font-mono text-gray-400">{pattern.example}</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Events to Monitor */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Events to Monitor *
        </label>
        <p className="text-xs text-gray-400 mb-3">
          "Create" covers files arriving at the destination via copy, paste, or download.
        </p>
        <div className="space-y-2">
          {(['create', 'modify', 'delete', 'move'] as const).map((event) => (
            <label
              key={event}
              className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all"
            >
              <input
                type="checkbox"
                checked={config.events[event]}
                onChange={() => toggleEvent(event)}
                className="w-4 h-4 text-indigo-600 rounded"
              />
              <div>
                <div className="text-white font-medium text-sm capitalize">
                  File {event}
                </div>
                <div className="text-gray-400 text-xs">{`Detect file ${event} operations at the destination`}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Action Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Action When Transfer Is Detected
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filetransfer-action"
              value="block"
              checked={config.action === 'block'}
              onChange={() => update({ action: 'block', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Block</div>
              <div className="text-gray-400 text-xs">Delete the arriving file at the destination and raise an alert</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filetransfer-action"
              value="quarantine"
              checked={config.action === 'quarantine'}
              onChange={() => update({ action: 'quarantine' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Quarantine</div>
              <div className="text-gray-400 text-xs">Move the file to a quarantine folder; can be restored by an admin</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filetransfer-action"
              value="alert"
              checked={config.action === 'alert'}
              onChange={() => update({ action: 'alert', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Alert</div>
              <div className="text-gray-400 text-xs">Send an alert but leave the file in place</div>
            </div>
          </label>
        </div>

        {config.action === 'quarantine' && (
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Quarantine Folder (optional)
            </label>
            <input
              type="text"
              value={config.quarantinePath ?? ''}
              onChange={(e) => update({ quarantinePath: e.target.value || undefined })}
              placeholder="e.g., C:\\CyberSentinelDLP\\Quarantine"
              className="w-full px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
            />
            <p className="text-xs text-gray-400 mt-2">
              Leave empty to use the agent's default quarantine folder.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
