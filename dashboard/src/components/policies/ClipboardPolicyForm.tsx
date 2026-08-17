'use client'

import { useState, useRef, useEffect } from 'react'
import { ClipboardConfig } from '@/types/policy'
import { predefinedPatterns, validateRegex, testRegex } from '@/utils/policyUtils'
import { Check, X, Plus, Trash2 } from 'lucide-react'

interface ClipboardPolicyFormProps {
  config: ClipboardConfig
  onChange: (config: ClipboardConfig) => void
}

export default function ClipboardPolicyForm({ config: rawConfig, onChange }: ClipboardPolicyFormProps) {
  // Defensive: some clipboard policies were saved with a different
  // config shape (monitoredEvents/contentTypes/dataTypes instead of
  // patterns.predefined/custom). Normalize so the form never crashes
  // on missing nested properties.
  const config: ClipboardConfig = {
    ...rawConfig,
    patterns: {
      predefined: rawConfig?.patterns?.predefined ?? [],
      custom: rawConfig?.patterns?.custom ?? [],
    },
    action: rawConfig?.action ?? 'alert',
  }

  const [customRegex, setCustomRegex] = useState('')
  const [customDescription, setCustomDescription] = useState('')
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<boolean | null>(null)

  // Select-all state for the predefined Detection Patterns.
  const allPatternIds = predefinedPatterns.map((p) => p.id)
  const selectedCount = allPatternIds.filter((id) => config.patterns.predefined.includes(id)).length
  const allSelected = allPatternIds.length > 0 && selectedCount === allPatternIds.length
  const someSelected = selectedCount > 0 && !allSelected

  // Native checkboxes can't express the "indeterminate" (partial) look via a
  // prop, so drive it imperatively whenever the partial state changes.
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  const handleToggleAll = () => {
    onChange({
      ...config,
      patterns: {
        ...config.patterns,
        predefined: allSelected ? [] : allPatternIds,
      },
    })
  }

  const handlePredefinedToggle = (patternId: string) => {
    const newPredefined = config.patterns.predefined.includes(patternId)
      ? config.patterns.predefined.filter(p => p !== patternId)
      : [...config.patterns.predefined, patternId]
    
    onChange({
      ...config,
      patterns: {
        ...config.patterns,
        predefined: newPredefined
      }
    })
  }

  const handleAddCustomPattern = () => {
    const validation = validateRegex(customRegex)
    if (!validation.valid) {
      alert(validation.error)
      return
    }

    const newCustom = [
      ...config.patterns.custom,
      { regex: customRegex, description: customDescription || undefined }
    ]

    onChange({
      ...config,
      patterns: {
        ...config.patterns,
        custom: newCustom
      }
    })

    setCustomRegex('')
    setCustomDescription('')
  }

  const handleRemoveCustomPattern = (index: number) => {
    const newCustom = config.patterns.custom.filter((_, i) => i !== index)
    onChange({
      ...config,
      patterns: {
        ...config.patterns,
        custom: newCustom
      }
    })
  }

  const handleTestRegex = () => {
    if (!customRegex.trim()) {
      alert('Please enter a regex pattern to test')
      return
    }

    const validation = validateRegex(customRegex)
    if (!validation.valid) {
      alert(validation.error)
      return
    }

    const result = testRegex(customRegex, testText)
    setTestResult(result)
  }

  const regexValidation = customRegex ? validateRegex(customRegex) : null

  return (
    <div className="space-y-6">
      {/* Predefined Patterns */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium text-cs-ink-2">
            Detection Patterns
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-medium text-cs-ink-2 hover:text-cs-ink transition-colors">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={handleToggleAll}
              className="w-4 h-4 rounded border border-cs-hair bg-cs-panel text-indigo-600 focus:ring-2 focus:ring-cs-indigo-faint/40 cursor-pointer"
            />
            <span>
              {allSelected ? 'Deselect all' : 'Select all'}
              <span className="ml-1 text-cs-muted-2">({selectedCount}/{allPatternIds.length})</span>
            </span>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {predefinedPatterns.map((pattern) => {
            const isSelected = config.patterns.predefined.includes(pattern.id)
            
            return (
              <button
                key={pattern.id}
                onClick={() => handlePredefinedToggle(pattern.id)}
                className={`p-3 rounded-cs-sm border-2 text-left transition-all ${
                  isSelected
                    ? 'border-cs-indigo bg-indigo-900/30 text-white'
                    : 'border-cs-hair bg-cs-panel-2 text-cs-muted hover:border-cs-hair'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{pattern.name}</div>
                    <div className="text-xs mt-1 opacity-70 font-mono">{pattern.example}</div>
                  </div>
                  {isSelected && <Check className="w-5 h-5 text-cs-indigo" />}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom Patterns */}
      <div>
        <label className="block text-sm font-medium text-cs-ink-2 mb-3">
          Custom Regex Patterns
        </label>
        
        {/* Existing Custom Patterns */}
        {config.patterns.custom.length > 0 && (
          <div className="space-y-2 mb-4">
            {config.patterns.custom.map((custom, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-cs-panel-2 rounded-cs-sm border border-cs-hair"
              >
                <div className="flex-1">
                  <code className="text-sm text-cs-indigo">{custom.regex}</code>
                  {custom.description && (
                    <p className="text-xs text-cs-muted mt-1">{custom.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleRemoveCustomPattern(index)}
                  className="ml-3 p-1 text-cs-muted hover:text-cs-crit transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add Custom Pattern */}
        <div className="space-y-3 p-4 bg-cs-panel-2 rounded-cs-sm border border-cs-hair">
          <div>
            <label className="block text-xs font-medium text-cs-ink-2 mb-2">
              Regex Pattern
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={customRegex}
                onChange={(e) => setCustomRegex(e.target.value)}
                placeholder="e.g., \\d{4}-\\d{4}-\\d{4}"
                className="flex-1 px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all font-mono text-sm"
              />
              {regexValidation && (
                <div className={`flex items-center px-2 ${
                  regexValidation.valid ? 'text-cs-ok' : 'text-cs-crit'
                }`}>
                  {regexValidation.valid ? <Check className="w-5 h-5" /> : <X className="w-5 h-5" />}
                </div>
              )}
            </div>
            {regexValidation && !regexValidation.valid && (
              <p className="text-xs text-cs-crit mt-1">{regexValidation.error}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-cs-ink-2 mb-2">
              Description (Optional)
            </label>
            <input
              type="text"
              value={customDescription}
              onChange={(e) => setCustomDescription(e.target.value)}
              placeholder="e.g., Custom ID Pattern"
              className="w-full px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all text-sm"
            />
          </div>

          {/* Test Regex */}
          <div>
            <label className="block text-xs font-medium text-cs-ink-2 mb-2">
              Test Pattern
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder="Enter sample text to test"
                className="flex-1 px-3 py-2 bg-cs-panel-2 border border-cs-hair rounded-cs-sm text-cs-ink placeholder:text-cs-muted-2 focus:border-cs-indigo focus:ring-2 focus:ring-cs-indigo-faint transition-all text-sm"
              />
              <button
                onClick={handleTestRegex}
                disabled={!customRegex.trim() || !testText.trim()}
                className="px-4 py-2 bg-cs-indigo hover:bg-cs-indigo-d disabled:bg-cs-hair-2 disabled:text-cs-muted-2 text-white rounded-cs-sm transition-colors text-sm font-medium"
              >
                Test
              </button>
            </div>
            {testResult !== null && (
              <p className={`text-xs mt-2 ${
                testResult ? 'text-cs-ok' : 'text-cs-crit'
              }`}>
                {testResult ? '✓ Pattern matches!' : '✗ Pattern does not match'}
              </p>
            )}
          </div>

          <button
            onClick={handleAddCustomPattern}
            disabled={!customRegex.trim() || (regexValidation && !regexValidation.valid)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-cs-indigo hover:bg-cs-indigo-d disabled:bg-cs-hair-2 disabled:text-cs-muted-2 text-white rounded-cs-sm transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Custom Pattern
          </button>
        </div>
      </div>

      {/* Action Selection */}
      <div>
        <label className="block text-sm font-medium text-cs-ink-2 mb-3">
          Action When Pattern Detected
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="clipboard-action"
              value="block"
              checked={config.action === 'block'}
              onChange={() => onChange({ ...config, action: 'block' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-cs-ink font-medium text-sm">Block</div>
              <div className="text-cs-muted text-xs">
                Clear the clipboard so the copied content cannot be pasted, and raise an alert
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="clipboard-action"
              value="alert"
              checked={config.action === 'alert'}
              onChange={() => onChange({ ...config, action: 'alert' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-cs-ink font-medium text-sm">Alert</div>
              <div className="text-cs-muted text-xs">Send alert notification when pattern is detected</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-cs-sm border border-cs-hair bg-cs-panel-2 cursor-pointer hover:border-cs-hair transition-all">
            <input
              type="radio"
              name="clipboard-action"
              value="log"
              checked={config.action === 'log'}
              onChange={() => onChange({ ...config, action: 'log' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-cs-ink font-medium text-sm">Log Only</div>
              <div className="text-cs-muted text-xs">Log the event without sending alerts</div>
            </div>
          </label>
        </div>
      </div>
    </div>
  )
}

