'use client'

import { PolicyType } from '@/types/policy'
import { Clipboard, FileText, Usb, HardDrive, Shield, UploadCloud, Mail } from 'lucide-react'

interface PolicyTypeSelectorProps {
  selectedType: PolicyType | null
  onSelectType: (type: PolicyType) => void
}

const policyTypes: Array<{
  type: PolicyType
  label: string
  description: string
  icon: typeof Clipboard
}> = [
  {
    type: 'clipboard_monitoring',
    label: 'Clipboard Monitoring',
    description: 'Monitor clipboard for sensitive data',
    icon: Clipboard
  },
  {
    type: 'file_system_monitoring',
    label: 'File System Monitoring',
    description: 'Monitor directories for file operations (detect only)',
    icon: FileText
  },
  {
    type: 'file_transfer_monitoring',
    label: 'File Transfer Monitoring',
    description: 'Block/quarantine transfers between protected and destination folders',
    icon: HardDrive
  },
  {
    type: 'usb_device_monitoring',
    label: 'USB Device Monitoring',
    description: 'Monitor USB device connections',
    icon: Usb
  },
  {
    type: 'usb_file_transfer_monitoring',
    label: 'USB File Transfer Monitoring',
    description: 'Monitor and control file transfers to USB',
    icon: HardDrive
  },
  {
    type: 'classification_aware_policy',
    label: 'Classification-Aware Policy',
    description: 'Advanced policy based on content classification and confidence scores',
    icon: Shield
  },
  {
    type: 'cloud_upload_prevention',
    label: 'Cloud Upload Prevention',
    description: 'Block Confidential/Restricted files from being uploaded to any cloud app; alert on Internal',
    icon: UploadCloud
  },
  {
    type: 'email_send_prevention',
    label: 'Email Send Prevention',
    description: 'Block outbound email carrying Confidential/Restricted attachments or body text; alert on Internal',
    icon: Mail
  }
]

export default function PolicyTypeSelector({ selectedType, onSelectType }: PolicyTypeSelectorProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-cs-ink mb-2">Select Policy Type (v2)</h3>
        <p className="text-sm text-cs-muted">Choose the type of monitoring policy you want to create</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {policyTypes.map(({ type, label, description, icon: Icon }) => {
          const isSelected = selectedType === type

          return (
            <button
              key={type}
              onClick={() => onSelectType(type)}
              className={`p-4 rounded-cs-card border-2 transition-all text-left ${
                isSelected
                  ? 'border-cs-indigo bg-cs-indigo-faint text-cs-ink'
                  : 'border-cs-hair bg-cs-hair-2 text-cs-ink-2 hover:border-cs-muted-2 hover:text-cs-ink'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-cs-sm ${
                  isSelected
                    ? 'bg-cs-indigo-faint text-cs-indigo'
                    : 'bg-cs-hair-2 text-cs-muted'
                }`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold text-sm mb-1">{label}</h4>
                  <p className="text-xs opacity-70">{description}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

