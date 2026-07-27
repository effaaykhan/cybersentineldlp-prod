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
  | 'google_drive_local_monitoring'
  | 'google_drive_cloud_monitoring'
  | 'onedrive_cloud_monitoring'
  | 'classification_aware_policy'
  | 'cloud_upload_prevention'
  | 'email_send_prevention'
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
}

export interface USBTransferConfig {
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


