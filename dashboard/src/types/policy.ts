/**
 * Policy Type Definitions
 * Shared types for policy management
 */

export type PolicyType =
  | 'clipboard_monitoring'
  | 'file_system_monitoring'
  | 'file_transfer_monitoring'
  | 'usb_device_monitoring'
  | 'usb_file_transfer_monitoring'
  | 'usb_device_control'
  | 'printer_control'
  | 'application_control'
  | 'wireless_transfer_control'
  | 'network_share_control'
  | 'messaging_app_control'
  | 'google_drive_local_monitoring'
  | 'google_drive_cloud_monitoring'
  | 'onedrive_cloud_monitoring'
  | 'classification_aware_policy'
  | 'cloud_upload_prevention'
  | 'email_send_prevention'
  | 'print_content_prevention'
  | 'network_exfiltration_prevention'

export type PolicySeverity = 'low' | 'medium' | 'high' | 'critical'
export type ClipboardAction = 'alert' | 'log' | 'block'
export type NetworkPreventionAction = 'block' | 'alert' | 'log'
export type FileSystemAction = 'alert' | 'log' | 'block' | 'quarantine'
export type FileTransferAction = 'block' | 'quarantine' | 'alert'
export type USBDeviceAction = 'alert' | 'log' | 'block'
export type USBTransferAction = 'block' | 'quarantine' | 'alert'

export interface ClipboardConfig {
  patterns: {
    predefined: string[]  // ['ssn', 'credit_card', 'api_key']
    custom: Array<{ regex: string, description?: string }>
  }
  action: ClipboardAction
}

export interface FileSystemConfig {
  monitoredPaths: string[]
  fileExtensions?: string[]
  events: {
    create: boolean
    modify: boolean
    delete: boolean
    move: boolean
  }
  patterns?: {
    predefined: string[]
    custom: Array<{ regex: string, description?: string }>
  }
  action: FileSystemAction
  quarantinePath?: string
}

export interface FileTransferConfig {
  protectedPaths: string[]
  monitoredDestinations: string[]
  fileExtensions?: string[]
  events: {
    create: boolean
    modify: boolean
    delete: boolean
    move: boolean
  }
  patterns?: {
    predefined: string[]
    custom: Array<{ regex: string, description?: string }>
  }
  action: FileTransferAction
  quarantinePath?: string
}

export interface USBDeviceConfig {
  events: {
    connect: boolean
    disconnect: boolean
    fileTransfer: boolean
  }
  action: USBDeviceAction
}

export interface USBDeviceControlConfig {
  // enforce = block unsanctioned devices; audit = allow but log what would block
  mode: 'enforce' | 'audit'
  // read_write = normal; read_only = USB storage mounts but writes are blocked
  // (global WriteProtect on the endpoint). Independent of enforce/audit.
  access_mode?: 'read_write' | 'read_only'
}

export interface NetworkShareControlConfig {
  // block_all = block every copy to a network share; content_aware = block only
  // Confidential/Restricted files. Exceptions apply in both modes.
  mode: 'block_all' | 'content_aware'
  // audit = log + raise an event only (never deletes); block = quarantine then
  // delete the flagged file off the share. Defaults to audit.
  action?: 'audit' | 'block'
  exceptions: {
    shares?: string[]       // UNC prefixes always allowed, e.g. \\fileserver\public
    users?: string[]        // users / groups exempt
    paths?: string[]        // source path prefixes exempt
    file_types?: string[]   // extensions exempt (no leading dot)
  }
}

export interface MessagingAppControlConfig {
  // alert = log + raise an event only (never terminates the app); block = kill the
  // messaging app when it attaches a Confidential/Restricted file. Defaults to alert.
  action?: 'alert' | 'block'
  // Managed messaging / thick-client exe names (lowercased). Empty = the built-in
  // set (Teams, WhatsApp, Telegram, Slack, Discord, Signal).
  apps?: string[]
  exceptions?: {
    users?: string[]        // users / groups exempt
    file_types?: string[]   // extensions never inspected (no leading dot)
  }
}

export interface WirelessTransferControlConfig {
  // enforce = apply the OS-level disables; audit = log "would block" only
  mode: 'enforce' | 'audit'
  block_bluetooth_file_transfer: boolean   // block Bluetooth OPP/FTP; audio + HID stay allowed
  block_nearby_sharing: boolean            // block Wi-Fi Direct / Windows Nearby Sharing
}

export interface ApplicationControlConfig {
  // allowlist = only the managed apps may perform the action (block the rest)
  // blocklist = the managed apps are blocked from the action (allow the rest)
  mode: 'allowlist' | 'blocklist'
  applications: string[]          // managed app executables, e.g. "chrome.exe"
  channels: string[]              // actions covered: usb | network | email | print | cloud; empty = all
  exceptions: {
    applications?: string[]       // exe names always allowed
    users?: string[]              // users / groups exempt
    paths?: string[]              // path prefixes exempt
    file_types?: string[]         // extensions exempt (no leading dot)
  }
}

export interface PrinterControlConfig {
  mode: 'enforce' | 'audit'
  // block_all = block every print job; block_network / block_local = by type;
  // allowlist = allow only sanctioned printers, block the rest
  scope: 'block_all' | 'block_network' | 'block_local' | 'allowlist'
}

// File-identity denylist — block/alert a file by custom extension or exact hash,
// independent of content classification (also catches renamed / non-text files).
// Shared shape mixed into the USB and Print channel configs.
export interface FileIdentityDenylist {
  blockedExtensions?: string[]          // e.g. [".dwg", ".iso"] — lowercase, leading dot
  blockedHashes?: string[]              // MD5 or SHA-256 hex, lowercase
  blockedExtensionAction?: 'block' | 'alert'
  blockedHashAction?: 'block' | 'alert'
}

export interface PrintContentConfig extends FileIdentityDenylist {
  // enforce = cancel sensitive print jobs; audit = log "would block", don't cancel
  mode: 'enforce' | 'audit'
  // classification levels that trigger the action
  levels: string[]
}

export interface USBTransferConfig extends FileIdentityDenylist {
  monitoredPaths: string[]
  action: USBTransferAction
  quarantinePath?: string
}

export interface GoogleDriveLocalConfig {
  basePath: string  // Default: "G:\\My Drive\\"
  monitoredFolders: string[]  // Subfolders within basePath
  fileExtensions?: string[]
  events: {
    create: boolean
    modify: boolean
    delete: boolean
    move: boolean
  }
  action: FileSystemAction
  quarantinePath?: string
}

export interface GoogleDriveCloudConfig {
  connectionId: string
  protectedFolders: Array<{
    id: string
    name: string
    path?: string
  }>
  pollingInterval: number // minutes
  action: 'log'
}

export interface OneDriveCloudConfig {
  connectionId: string
  protectedFolders: Array<{
    id: string
    name: string
    path?: string
  }>
  pollingInterval: number // minutes
  action: 'log'
}

// Network prevention config — mirrors the clipboard form (detection
// categories + custom regex + action) plus the network channels/ports to hook.
// The agent consumes the whole object; the server derives conditions/actions
// from it via transform_frontend_config_to_backend('network_exfiltration_prevention').
export interface NetworkPreventionConfig {
  dataTypes: string[]                 // detection categories: SSN, AADHAAR, PAN_CARD, ...
  customPatterns: Array<{ regex: string, description?: string }>
  monitoredMethods: string[]          // ftp, sftp, scp, python_http_server, curl, ...
  monitoredPorts: number[]            // 21, 22, 8000, ...
  direction: 'outbound' | 'inbound'
  action: NetworkPreventionAction
}

// Classification-aware policy types
export interface PolicyCondition {
  field: string
  operator: string
  value: any
}

export interface ClassificationPolicyConfig {
  conditions: {
    match: 'all' | 'any'
    rules: PolicyCondition[]
  }
  actions: {
    alert?: {
      severity: 'low' | 'medium' | 'high' | 'critical'
      message?: string
    }
    block?: {}
    quarantine?: {
      location?: string
    }
    log?: {
      level?: 'info' | 'warning' | 'error'
    }
  }
}

export type PolicyConfig =
  | ClipboardConfig
  | FileSystemConfig
  | FileTransferConfig
  | USBDeviceConfig
  | USBDeviceControlConfig
  | ApplicationControlConfig
  | WirelessTransferControlConfig
  | NetworkShareControlConfig
  | MessagingAppControlConfig
  | PrinterControlConfig
  | PrintContentConfig
  | USBTransferConfig
  | GoogleDriveLocalConfig
  | GoogleDriveCloudConfig
  | OneDriveCloudConfig
  | ClassificationPolicyConfig
  | NetworkPreventionConfig

export interface Policy {
  id: string
  name: string
  description: string
  type?: PolicyType  // Optional for classification-aware policies
  domain?: string    // RBAC policy domain (threat|data_protection|access_control|general)
  severity?: PolicySeverity  // Optional for classification-aware policies
  priority: number
  enabled: boolean
  config?: PolicyConfig  // Optional - used for traditional policies
  // Classification-aware policy fields (alternative to type/config)
  conditions?: {
    match: 'all' | 'any'
    rules: PolicyCondition[]
  }
  actions?: {
    alert?: {
      severity: 'low' | 'medium' | 'high' | 'critical'
      message?: string
    }
    block?: {}
    quarantine?: {
      location?: string
    }
    log?: {
      level?: 'info' | 'warning' | 'error'
    }
  }
  agentId?: string
  agentIds?: string[]
  createdAt?: string
  updatedAt?: string
  createdBy?: string
  violations?: number
  lastViolation?: string
}


