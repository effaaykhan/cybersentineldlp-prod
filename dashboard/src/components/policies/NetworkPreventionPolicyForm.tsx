'use client'

import { useState } from 'react'
import { NetworkPreventionConfig } from '@/types/policy'
import { validateRegex, testRegex } from '@/utils/policyUtils'
import { Check, X, Plus, Trash2 } from 'lucide-react'

interface NetworkPreventionPolicyFormProps {
  config: NetworkPreventionConfig
  onChange: (config: NetworkPreventionConfig) => void
}

// Detection categories — same idea as the clipboard policy's data types.
// `value` is the uppercase label persisted in config.dataTypes (matches the
// seeded network policies and the server's classification labels).
const DATA_TYPES: Array<{ value: string; name: string; example: string }> = [
  { value: 'CREDIT_CARD', name: 'Credit Card Number', example: '4111-1111-1111-1111' },
  { value: 'SSN', name: 'Social Security Number (SSN)', example: '123-45-6789' },
  { value: 'AADHAAR', name: 'Aadhaar Number', example: '1234 5678 9012' },
  { value: 'PAN_CARD', name: 'PAN Number', example: 'ABCDE1234F' },
  { value: 'PASSPORT', name: 'Passport Number', example: 'A1234567' },
  { value: 'EMAIL', name: 'Email Address', example: 'user@example.com' },
  { value: 'PHONE', name: 'Phone Number', example: '+1-555-123-4567' },
  { value: 'API_KEY', name: 'API Key', example: 'sk_live_...' },
  { value: 'PRIVATE_KEY', name: 'Private Key', example: '-----BEGIN PRIVATE KEY-----' },
  { value: 'AWS_KEY', name: 'AWS Access Key', example: 'AKIA...' },
  { value: 'DATABASE_CONNECTION', name: 'Database Connection String', example: 'jdbc:mysql://...' },
  { value: 'IFSC', name: 'IFSC Code', example: 'SBIN0001234' },
  { value: 'UPI_ID', name: 'UPI ID', example: 'user@paytm' },
  { value: 'INDIAN_BANK_ACCOUNT', name: 'Indian Bank Account Number', example: '123456789012' },
]

// Exfiltration channels the agent hooks. `value` is the transfer_method the
// agent reports on the real-time evaluate call.
const METHODS: Array<{ value: string; name: string; example: string }> = [
  { value: 'ftp', name: 'FTP', example: 'ftp / ftp.exe' },
  { value: 'sftp', name: 'SFTP', example: 'sftp over SSH' },
  { value: 'scp', name: 'SCP (SSH copy)', example: 'scp file host:' },
  { value: 'tftp', name: 'TFTP', example: 'tftp (UDP 69)' },
  { value: 'http_post', name: 'HTTP(S) POST upload', example: 'multipart / form upload' },
  { value: 'http_server', name: 'HTTP file server', example: 'served over HTTP' },
  { value: 'python_http_server', name: 'Python http.server', example: 'python -m http.server' },
  { value: 'curl', name: 'cURL', example: 'curl -T file' },
  { value: 'wget', name: 'wget', example: 'wget --post-file' },
  { value: 'netcat', name: 'netcat / nc', example: 'nc host port < file' },
  { value: 'powershell_upload', name: 'PowerShell upload', example: 'Invoke-WebRequest' },
  { value: 'smb_copy', name: 'SMB / Windows share', example: 'copy \\\\host\\share' },
  { value: 'webdav', name: 'WebDAV', example: 'PUT over WebDAV' },
  { value: 'rsync', name: 'rsync', example: 'rsync file host:' },
  { value: 'cloud_cli', name: 'Cloud CLI (aws/gcloud/az)', example: 'aws s3 cp' },
  { value: 'dns_tunnel', name: 'DNS tunnel', example: 'data exfil over DNS' },
]

export default function NetworkPreventionPolicyForm({ config: rawConfig, onChange }: NetworkPreventionPolicyFormProps) {
  // Defensive: a seeded/API policy may omit keys or carry extra ones
  // (classificationLevels, monitoredPorts as strings). Normalize so the form
  // never crashes, and preserve any extra keys on change via {...rawConfig}.
  const config: NetworkPreventionConfig = {
    ...rawConfig,
    dataTypes: Array.isArray(rawConfig?.dataTypes) ? rawConfig.dataTypes : [],
    customPatterns: Array.isArray(rawConfig?.customPatterns) ? rawConfig.customPatterns : [],
    monitoredMethods: Array.isArray(rawConfig?.monitoredMethods) ? rawConfig.monitoredMethods : [],
    monitoredPorts: Array.isArray(rawConfig?.monitoredPorts)
      ? rawConfig.monitoredPorts.map((p) => Number(p)).filter((n) => !Number.isNaN(n))
      : [],
    direction: rawConfig?.direction ?? 'outbound',
    action: rawConfig?.action ?? 'block',
  }

  const [customRegex, setCustomRegex] = useState('')
  const [customDescription, setCustomDescription] = useState('')
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<boolean | null>(null)
  const [portsText, setPortsText] = useState(config.monitoredPorts.join(', '))

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  const handleDataTypeToggle = (value: string) =>
    onChange({ ...config, dataTypes: toggle(config.dataTypes, value) })

  const handleMethodToggle = (value: string) =>
    onChange({ ...config, monitoredMethods: toggle(config.monitoredMethods, value) })

  const handleSelectAllMethods = () =>
    onChange({
      ...config,
      monitoredMethods:
        config.monitoredMethods.length === METHODS.length ? [] : METHODS.map((m) => m.value),
    })

  const handlePortsChange = (text: string) => {
    setPortsText(text)
    const ports = text
      .split(/[\s,]+/)
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
    onChange({ ...config, monitoredPorts: ports })
  }

  const handleAddCustomPattern = () => {
    const validation = validateRegex(customRegex)
    if (!validation.valid) {
      alert(validation.error)
      return
    }
    onChange({
      ...config,
      customPatterns: [...config.customPatterns, { regex: customRegex, description: customDescription || undefined }],
    })
    setCustomRegex('')
    setCustomDescription('')
  }

  const handleRemoveCustomPattern = (index: number) =>
    onChange({ ...config, customPatterns: config.customPatterns.filter((_, i) => i !== index) })

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
    setTestResult(testRegex(customRegex, testText))
  }

  const regexValidation = customRegex ? validateRegex(customRegex) : null
  const allMethodsSelected = config.monitoredMethods.length === METHODS.length

  return (
    <div className="space-y-6">
      {/* Exfiltration Channels */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium text-gray-200">
            Exfiltration Channels to Monitor
          </label>
          <button
            onClick={handleSelectAllMethods}
            className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
          >
            {allMethodsSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Leave all unselected to cover every channel. Select specific ones to scope the policy to those tools/protocols.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {METHODS.map((m) => {
            const isSelected = config.monitoredMethods.includes(m.value)
            return (
              <button
                key={m.value}
                onClick={() => handleMethodToggle(m.value)}
                className={`p-3 rounded-lg border-2 text-left transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-900/30 text-white'
                    : 'border-gray-600 bg-gray-900/30 text-gray-400 hover:border-gray-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{m.name}</div>
                    <div className="text-xs mt-1 opacity-70 font-mono">{m.example}</div>
                  </div>
                  {isSelected && <Check className="w-5 h-5 text-indigo-400" />}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Monitored Ports */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-2">
          Monitored Ports <span className="text-gray-500 font-normal">(optional, comma-separated)</span>
        </label>
        <input
          type="text"
          value={portsText}
          onChange={(e) => handlePortsChange(e.target.value)}
          placeholder="e.g., 21, 22, 69, 80, 443, 445, 8000, 8080"
          className="w-full px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm font-mono"
        />
      </div>

      {/* Detection Patterns */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-1">
          Detection Patterns
        </label>
        <p className="text-xs text-gray-500 mb-3">
          Sensitive data categories that make an outbound transfer a violation. Leave empty to act on any file over the selected channels.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {DATA_TYPES.map((d) => {
            const isSelected = config.dataTypes.includes(d.value)
            return (
              <button
                key={d.value}
                onClick={() => handleDataTypeToggle(d.value)}
                className={`p-3 rounded-lg border-2 text-left transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-900/30 text-white'
                    : 'border-gray-600 bg-gray-900/30 text-gray-400 hover:border-gray-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{d.name}</div>
                    <div className="text-xs mt-1 opacity-70 font-mono">{d.example}</div>
                  </div>
                  {isSelected && <Check className="w-5 h-5 text-indigo-400" />}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom Patterns */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Custom Regex Patterns
        </label>

        {config.customPatterns.length > 0 && (
          <div className="space-y-2 mb-4">
            {config.customPatterns.map((custom, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-900/50 rounded-lg border border-gray-700"
              >
                <div className="flex-1">
                  <code className="text-sm text-indigo-300">{custom.regex}</code>
                  {custom.description && (
                    <p className="text-xs text-gray-400 mt-1">{custom.description}</p>
                  )}
                </div>
                <button
                  onClick={() => handleRemoveCustomPattern(index)}
                  className="ml-3 p-1 text-gray-400 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 p-4 bg-gray-900/30 rounded-lg border border-gray-700">
          <div>
            <label className="block text-xs font-medium text-gray-300 mb-2">Regex Pattern</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={customRegex}
                onChange={(e) => setCustomRegex(e.target.value)}
                placeholder="e.g., \\d{4}-\\d{4}-\\d{4}"
                className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono text-sm"
              />
              {regexValidation && (
                <div className={`flex items-center px-2 ${regexValidation.valid ? 'text-green-400' : 'text-red-400'}`}>
                  {regexValidation.valid ? <Check className="w-5 h-5" /> : <X className="w-5 h-5" />}
                </div>
              )}
            </div>
            {regexValidation && !regexValidation.valid && (
              <p className="text-xs text-red-400 mt-1">{regexValidation.error}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300 mb-2">Description (Optional)</label>
            <input
              type="text"
              value={customDescription}
              onChange={(e) => setCustomDescription(e.target.value)}
              placeholder="e.g., Internal project codename"
              className="w-full px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300 mb-2">Test Pattern</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder="Enter sample text to test"
                className="flex-1 px-3 py-2 bg-gray-900/50 border-2 border-gray-600 rounded-lg text-white placeholder-gray-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm"
              />
              <button
                onClick={handleTestRegex}
                disabled={!customRegex.trim() || !testText.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors text-sm font-medium"
              >
                Test
              </button>
            </div>
            {testResult !== null && (
              <p className={`text-xs mt-2 ${testResult ? 'text-green-400' : 'text-red-400'}`}>
                {testResult ? '✓ Pattern matches!' : '✗ Pattern does not match'}
              </p>
            )}
          </div>

          <button
            onClick={handleAddCustomPattern}
            disabled={!customRegex.trim() || (regexValidation != null && !regexValidation.valid)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Custom Pattern
          </button>
        </div>
      </div>

      {/* Action Selection */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-3">
          Action When Data Exfiltration Detected
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="network-action"
              value="block"
              checked={config.action === 'block'}
              onChange={() => onChange({ ...config, action: 'block' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Block</div>
              <div className="text-gray-400 text-xs">
                Stop the transfer before the data leaves, and raise an alert
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="network-action"
              value="alert"
              checked={config.action === 'alert'}
              onChange={() => onChange({ ...config, action: 'alert' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Alert</div>
              <div className="text-gray-400 text-xs">Allow the transfer but send an alert notification</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-3 rounded-lg border-2 border-gray-600 bg-gray-900/30 cursor-pointer hover:border-gray-500 transition-all">
            <input
              type="radio"
              name="network-action"
              value="log"
              checked={config.action === 'log'}
              onChange={() => onChange({ ...config, action: 'log' })}
              className="w-4 h-4 text-indigo-600"
            />
            <div>
              <div className="text-white font-medium text-sm">Log Only</div>
              <div className="text-gray-400 text-xs">Log the event without sending alerts</div>
            </div>
          </label>
        </div>
      </div>
    </div>
  )
}
