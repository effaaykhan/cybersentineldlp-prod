'use client'

import { PolicyType } from '@/types/policy'
import {
  Clipboard, FileText, Usb, HardDrive, Shield, UploadCloud, Mail, Network,
  Printer, AppWindow, Bluetooth, FolderInput, MessageSquare, Globe,
} from 'lucide-react'

interface PolicyTypeSelectorProps {
  selectedType: PolicyType | null
  onSelectType: (type: PolicyType) => void
}

type Entry = {
  type: PolicyType
  label: string
  description: string
  icon: typeof Clipboard
}

/**
 * Grouped by the CHANNEL each policy guards, not by the order they were written.
 *
 * Sixteen tiles in one undifferentiated grid is a list to be read end to end
 * before choosing. Someone arriving here already knows roughly where the leak
 * they are worried about goes — out of a port, onto paper, into a browser — and
 * groups let them skip straight to it. The order runs from the physical edge of
 * the machine outward to the network, which is how people describe these risks
 * out loud.
 *
 * The heading this replaced read "Select Policy Type (v2)". It was set in the
 * app's near-black ink on the modal's near-black surface, so nobody had ever
 * seen it — and it exposed an internal version number to an operator, which is
 * not their business.
 */
const GROUPS: { name: string; blurb: string; items: Entry[] }[] = [
  {
    name: 'Removable media',
    blurb: 'Anything plugged into the machine',
    items: [
      { type: 'usb_device_control', label: 'USB Device Control', description: 'Allow only sanctioned USB storage; block every other device', icon: Shield },
      { type: 'usb_file_transfer_monitoring', label: 'USB File Transfer', description: 'Inspect and control files copied to removable drives', icon: HardDrive },
      { type: 'usb_device_monitoring', label: 'USB Device Activity', description: 'Record connections and disconnections', icon: Usb },
    ],
  },
  {
    name: 'The endpoint itself',
    blurb: 'Files, clipboard and printing on the device',
    items: [
      { type: 'clipboard_monitoring', label: 'Clipboard', description: 'Detect sensitive data copied to the clipboard', icon: Clipboard },
      { type: 'file_system_monitoring', label: 'File Activity', description: 'Watch directories for file operations (detect only)', icon: FileText },
      { type: 'file_transfer_monitoring', label: 'File Transfer', description: 'Block or quarantine moves out of protected folders', icon: FolderInput },
      { type: 'printer_control', label: 'Printer Control', description: 'Block all printing, or only network or local printers', icon: Printer },
      { type: 'print_content_prevention', label: 'Print Content', description: 'Inspect the document itself and stop sensitive print jobs', icon: Printer },
      { type: 'application_control', label: 'Application Control', description: 'Allow or block actions by the application performing them', icon: AppWindow },
    ],
  },
  {
    name: 'Off the machine',
    blurb: 'Where data goes once it leaves',
    items: [
      { type: 'web_activity_control', label: 'Web Activity Control', description: 'Per-activity control in the browser — upload, download, attach, send, post and AI prompts', icon: Globe },
      { type: 'network_exfiltration_prevention', label: 'Network Prevention', description: 'Sensitive data leaving over FTP, SCP, curl, netcat, DNS tunnelling and more', icon: Network },
      { type: 'network_share_control', label: 'Network Shares', description: 'Copying files to mapped drives and file servers', icon: FolderInput },
      { type: 'wireless_transfer_control', label: 'Bluetooth & Wireless', description: 'Bluetooth file transfer and Nearby Sharing — audio and input keep working', icon: Bluetooth },
      { type: 'messaging_app_control', label: 'Messaging Apps', description: 'Attachments in Teams, WhatsApp, Telegram, Slack, Discord and Signal', icon: MessageSquare },
      { type: 'cloud_upload_prevention', label: 'Cloud Upload', description: 'Confidential and Restricted files uploaded to cloud apps', icon: UploadCloud },
      { type: 'email_send_prevention', label: 'Email Send', description: 'Outbound mail carrying sensitive attachments or body text', icon: Mail },
    ],
  },
  {
    name: 'Content rules',
    blurb: 'Conditions that apply across channels',
    items: [
      { type: 'classification_aware_policy', label: 'Classification-Aware', description: 'Build conditions on classification level and confidence', icon: Shield },
    ],
  },
]

export default function PolicyTypeSelector({ selectedType, onSelectType }: PolicyTypeSelectorProps) {
  return (
    <div className="space-y-6">
      {GROUPS.map((group) => (
        <section key={group.name}>
          <header className="flex items-baseline gap-2 mb-2.5">
            <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-cs-muted-2">
              {group.name}
            </h4>
            <span className="text-[11.5px] text-cs-muted">{group.blurb}</span>
          </header>

          <div className="grid gap-2.5 sm:grid-cols-2">
            {group.items.map(({ type, label, description, icon: Icon }) => {
              const isSelected = selectedType === type
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => onSelectType(type)}
                  aria-pressed={isSelected}
                  className={`group text-left rounded-cs-card border p-3.5 transition-all
                    focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint
                    ${
                      isSelected
                        ? 'border-cs-indigo bg-cs-indigo-faint'
                        : 'border-cs-hair bg-cs-panel hover:border-cs-muted-2 hover:shadow-[0_1px_3px_rgba(21,23,28,.06)]'
                    }`}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`shrink-0 mt-[1px] transition-colors ${
                        isSelected ? 'text-cs-indigo' : 'text-cs-muted-2 group-hover:text-cs-ink-2'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block text-[13.5px] font-semibold leading-tight ${
                          isSelected ? 'text-cs-indigo' : 'text-cs-ink'
                        }`}
                      >
                        {label}
                      </span>
                      <span className="block text-[11.5px] text-cs-muted mt-1 leading-relaxed">
                        {description}
                      </span>
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
