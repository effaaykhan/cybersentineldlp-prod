'use client'

import { useState } from 'react'
import { USBTransferConfig } from '@/types/policy'
import { Plus, Trash2 } from 'lucide-react'
import FileIdentityDenylist from './FileIdentityDenylist'

interface USBTransferPolicyFormProps {
  config: USBTransferConfig
  onChange: (config: USBTransferConfig) => void
}

export default function USBTransferPolicyForm({ config, onChange }: USBTransferPolicyFormProps) {
  const [newPath, setNewPath] = useState('')

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

  return (
    <div className="space-y-6">
      {/* Monitored Directories */}
      <div>
        <label className="block text-sm font-medium text-cs-ink-2 mb-3">
          Monitored Directories *
        </label>
        <p className="text-xs text-cs-muted mb-3">
          Only files from these directories will trigger this policy when copied to USB drives
        </p>
        
        {/* Existing Paths */}
        {config.monitoredPaths.length > 0 && (
          <div className="space-y-2 mb-3">
            {config.monitoredPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-cs-panel-2 rounded-cs-sm border border-cs-hair"
              >
                <code className="text-sm text-cs-indigo flex-1">{path}</code>
                <button
                  onClick={() => handleRemovePath(index)}
                  className="ml-3 p-1 text-cs-muted hover:text-cs-crit transition-colors"
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
            placeholder="e.g., C:\\Users\\%USERNAME%\\Documents"
            className="flex-1 px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all font-mono text-sm"
          />
          <button
            onClick={handleAddPath}
            className="px-4 py-2 bg-cs-indigo hover:bg-cs-indigo-d text-white rounded-cs-sm transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
        <p className="text-xs text-cs-muted mt-2">
          Supports environment variables: %USERNAME%, $USER, etc.
        </p>
      </div>

      {/* Action Selection */}
      <div>
        <label className="block text-sm font-medium text-cs-ink-2 mb-3">
          Action When Transfer Detected
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="usb-transfer-action"
              value="block"
              checked={config.action === 'block'}
              onChange={() => onChange({ ...config, action: 'block', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-cs-ink font-medium text-sm">Block Transfer</div>
              <div className="text-cs-muted text-xs">Delete file immediately on USB drive</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="usb-transfer-action"
              value="quarantine"
              checked={config.action === 'quarantine'}
              onChange={() => onChange({ ...config, action: 'quarantine' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div className="flex-1">
              <div className="text-cs-ink font-medium text-sm">Quarantine Transfer</div>
              <div className="text-cs-muted text-xs">Move file to quarantine folder on USB drive</div>
            </div>
          </label>

          {config.action === 'quarantine' && (
            <div className="ml-7">
              <input
                type="text"
                value={config.quarantinePath || ''}
                onChange={(e) => onChange({ ...config, quarantinePath: e.target.value })}
                placeholder="e.g., C:\\Quarantine or /quarantine"
                className="w-full px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all font-mono text-sm"
              />
              <p className="text-xs text-cs-muted mt-1">
                Path on the USB drive where quarantined files will be moved
              </p>
            </div>
          )}

          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="usb-transfer-action"
              value="alert"
              checked={config.action === 'alert'}
              onChange={() => onChange({ ...config, action: 'alert', quarantinePath: undefined })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-cs-ink font-medium text-sm">Alert Only</div>
              <div className="text-cs-muted text-xs">Log and alert, but don't block the transfer</div>
            </div>
          </label>
        </div>
      </div>

      <FileIdentityDenylist config={config} onChange={onChange} />
    </div>
  )
}

