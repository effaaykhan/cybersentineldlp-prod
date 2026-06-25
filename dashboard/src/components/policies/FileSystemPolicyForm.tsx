'use client'

import { useState } from 'react'
import { FileSystemConfig } from '@/types/policy'
import { Plus, Trash2, X } from 'lucide-react'
import { predefinedPatterns } from '@/utils/policyUtils'

interface FileSystemPolicyFormProps {
  config: FileSystemConfig
  onChange: (config: FileSystemConfig) => void
}

const commonExtensions = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.txt', '.json', '.xml', '.sql', '.zip', '.rar', '.7z', '.db']

export default function FileSystemPolicyForm({ config, onChange }: FileSystemPolicyFormProps) {
  const [newPath, setNewPath] = useState('')
  const [newExtension, setNewExtension] = useState('')

  // Patterns block uses the same predefined list as ClipboardPolicyForm so
  // a "detect credit card numbers" rule means the same thing across all
  // monitoring surfaces. Without patterns, the agent has nothing to scan
  // file contents *against* and the policy fires no events.
  const selectedPredefined = config.patterns?.predefined ?? []
  const handlePredefinedToggle = (patternId: string) => {
    const next = selectedPredefined.includes(patternId)
      ? selectedPredefined.filter(p => p !== patternId)
      : [...selectedPredefined, patternId]
    onChange({
      ...config,
      patterns: {
        predefined: next,
        custom: config.patterns?.custom ?? [],
      },
    })
  }

  const handleAddPath = () => {
    if (!newPath.trim()) {
      alert('Please enter a path')
      return
    }

    if (config.monitoredPaths.includes(newPath.trim())) {
      alert('Path already added')
      return
    }

    onChange({
      ...config,
      monitoredPaths: [...config.monitoredPaths, newPath.trim()]
    })

    setNewPath('')
  }

  const handleRemovePath = (index: number) => {
    onChange({
      ...config,
      monitoredPaths: config.monitoredPaths.filter((_, i) => i !== index)
    })
  }

  const handleToggleExtension = (ext: string) => {
    const currentExtensions = config.fileExtensions || []
    const newExtensions = currentExtensions.includes(ext)
      ? currentExtensions.filter(e => e !== ext)
      : [...currentExtensions, ext]

    onChange({
      ...config,
      fileExtensions: newExtensions.length > 0 ? newExtensions : undefined
    })
  }

  const handleAddCustomExtension = () => {
    if (!newExtension.trim()) {
      alert('Please enter a file extension')
      return
    }

    const ext = newExtension.startsWith('.') ? newExtension : `.${newExtension}`
    const currentExtensions = config.fileExtensions || []

    if (currentExtensions.includes(ext)) {
      alert('Extension already added')
      return
    }

    onChange({
      ...config,
      fileExtensions: [...currentExtensions, ext]
    })

    setNewExtension('')
  }

  const handleRemoveExtension = (ext: string) => {
    const currentExtensions = config.fileExtensions || []
    onChange({
      ...config,
      fileExtensions: currentExtensions.filter(e => e !== ext)
    })
  }

  const handleToggleEvent = (event: keyof FileSystemConfig['events']) => {
    onChange({
      ...config,
      events: {
        ...config.events,
        [event]: !config.events[event]
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* Monitored Directories */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Monitored Directories *
        </label>
        
        {/* Existing Paths */}
        {config.monitoredPaths.length > 0 && (
          <div className="space-y-2 mb-3">
            {config.monitoredPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg border border-gray-700"
              >
                <code className="text-sm text-indigo-300 flex-1">{path}</code>
                <button
                  onClick={() => handleRemovePath(index)}
                  className="ml-3 p-1 text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add Path */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddPath()}
            placeholder="e.g., C:\\Users\\%USERNAME%\\Documents or /home/$USER/Documents"
            className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
          />
          <button
            onClick={handleAddPath}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Supports environment variables: %USERNAME%, $USER, etc.
        </p>
      </div>

      {/* File Extensions */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          File Extensions (Optional)
        </label>
        <p className="text-xs text-gray-400 mb-3">
          Leave empty to monitor all file types
        </p>

        {/* Common Extensions */}
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

        {/* Selected Extensions */}
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

        {/* Custom Extension Input */}
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
          At least one pattern is required. Files are opened and scanned for these data types — the policy only fires when a match is found.
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
          "Create" covers new files, copies/pastes, and downloads (they all produce a new file at the destination).
        </p>
        <div className="space-y-2">
          {Object.entries(config.events).map(([event, enabled]) => (
            <label
              key={event}
              className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all"
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => handleToggleEvent(event as keyof FileSystemConfig['events'])}
                className="w-4 h-4 text-indigo-600 rounded"
              />
              <div>
                <div className="text-white font-medium text-sm capitalize">
                  File {event}
                </div>
                <div className="text-gray-400 text-xs">{`Monitor file ${event} operations`}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Action Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Action When Sensitive File Is Detected
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filesystem-action"
              value="block"
              checked={config.action === 'block'}
              onChange={() => onChange({ ...config, action: 'block', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Block</div>
              <div className="text-gray-400 text-xs">Delete the offending file immediately and raise an alert</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filesystem-action"
              value="quarantine"
              checked={config.action === 'quarantine'}
              onChange={() => onChange({ ...config, action: 'quarantine' })}
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
              name="filesystem-action"
              value="alert"
              checked={config.action === 'alert'}
              onChange={() => onChange({ ...config, action: 'alert', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Alert</div>
              <div className="text-gray-400 text-xs">Send an alert but leave the file in place</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="filesystem-action"
              value="log"
              checked={config.action === 'log'}
              onChange={() => onChange({ ...config, action: 'log', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Log Only</div>
              <div className="text-gray-400 text-xs">Record the event silently with no notification or enforcement</div>
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
              onChange={(e) => onChange({ ...config, quarantinePath: e.target.value || undefined })}
              placeholder="e.g., C:\\CyberSentinel\\Quarantine"
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
