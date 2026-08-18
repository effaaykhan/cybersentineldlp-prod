'use client'

import { useState, useEffect } from 'react'
import { 
  Policy, 
  PolicyType, 
  ClipboardConfig,
  FileSystemConfig,
  USBDeviceConfig,
  USBDeviceControlConfig,
  PrinterControlConfig,
  ApplicationControlConfig,
  WirelessTransferControlConfig,
  NetworkShareControlConfig,
  MessagingAppControlConfig,
  PrintContentConfig,
  WebActivityControlConfig,
  USBTransferConfig,
  FileTransferConfig,
  NetworkPreventionConfig
} from '@/types/policy'
import { validatePolicy } from '@/utils/policyUtils'
import PolicyTypeSelector from './PolicyTypeSelector'
import PolicySummary from './PolicySummary'
import { Section, Field, TextInput, TextArea, Select, Toggle } from './formKit'
import { getPolicyTypeLabel } from '@/utils/policyUtils'
import ClipboardPolicyForm from './ClipboardPolicyForm'
import FileSystemPolicyForm from './FileSystemPolicyForm'
import FileTransferPolicyForm from './FileTransferPolicyForm'
import USBDevicePolicyForm from './USBDevicePolicyForm'
import USBTransferPolicyForm from './USBTransferPolicyForm'
import USBDeviceControlForm from './USBDeviceControlForm'
import PrinterControlForm from './PrinterControlForm'
import ApplicationControlForm from './ApplicationControlForm'
import WirelessTransferControlForm from './WirelessTransferControlForm'
import NetworkShareControlForm from './NetworkShareControlForm'
import MessagingAppControlForm from './MessagingAppControlForm'
import PrintContentForm from './PrintContentForm'
import WebActivityControlForm from './WebActivityControlForm'
import NetworkPreventionPolicyForm from './NetworkPreventionPolicyForm'
import ClassificationPolicyForm, { ClassificationPolicy } from './ClassificationPolicyForm'
import { getAgents, Agent } from '@/lib/api'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import Modal, { ModalHeader, ModalFooter } from '@/components/ui/Modal'
import toast from 'react-hot-toast'

interface PolicyCreatorModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (policy: Partial<Policy>) => void
  editingPolicy?: Policy | null
}

/*
 * Channel-scoped classification policies.
 *
 * These use the same conditions/actions builder as `classification_aware_policy`
 * (rules like "classification_level in [Confidential, Restricted] -> block")
 * but ALSO carry a `type`, which is what scopes them server-side to one
 * channel's events. Each entry is the template an admin starts from; they can
 * tune the rules afterwards. Adding a new channel = one entry here + a tile in
 * PolicyTypeSelector + the union member in types/policy.ts.
 */
type ClassificationTemplate = {
  conditions: { match: 'all' | 'any'; rules: Array<{ field: string; operator: string; value: any }> }
  actions: Record<string, any>
}

const SENSITIVE_LEVELS = ['Confidential', 'Restricted']

const POLICY_TEMPLATES: Partial<Record<PolicyType, ClassificationTemplate>> = {
  cloud_upload_prevention: {
    conditions: {
      match: 'all',
      rules: [
        { field: 'event_type', operator: 'equals', value: 'cloud_upload' },
        { field: 'classification_level', operator: 'in', value: SENSITIVE_LEVELS },
      ],
    },
    actions: { block: {}, alert: { severity: 'critical', message: 'Sensitive data upload to cloud blocked' } },
  },
  email_send_prevention: {
    conditions: {
      match: 'all',
      rules: [
        { field: 'event_type', operator: 'equals', value: 'email_send' },
        { field: 'classification_level', operator: 'in', value: SENSITIVE_LEVELS },
      ],
    },
    actions: { block: {}, alert: { severity: 'critical', message: 'Sensitive data blocked from outbound email' } },
  },
  // network_exfiltration_prevention is NOT here: it uses the easy config form
  // (NetworkPreventionPolicyForm) like clipboard, not the conditions/actions
  // builder. The server derives conditions/actions from its config.
}

const isChannelPolicy = (t: PolicyType | null): boolean => t !== null && t in POLICY_TEMPLATES

/*
  How wide the dialog needs to be.

  It used to be one width for everything — the width the activity matrix needs
  — so a clipboard policy with four checkboxes opened a 1150px panel and set its
  text inputs a mile wide. A dialog should be as big as its work and no bigger:
  wide for the things that are genuinely two-dimensional (a category × activity
  matrix, a list of applications, a stack of condition rows), ordinary for the
  rest.
*/
const WIDE_FORMS: PolicyType[] = [
  'web_activity_control',
  'application_control',
  'classification_aware_policy',
  'cloud_upload_prevention',
  'email_send_prevention',
  'network_exfiltration_prevention',
  'file_transfer_monitoring',
  'usb_file_transfer_monitoring',
]

// The generic classification policy and every channel-scoped policy above use
// the conditions/actions builder rather than a typed `config` object.
const usesClassificationBuilder = (t: PolicyType | null): boolean =>
  t === 'classification_aware_policy' || isChannelPolicy(t)

const getDefaultConfig = (type: PolicyType): ClipboardConfig | FileSystemConfig | USBDeviceConfig | USBDeviceControlConfig | PrinterControlConfig | ApplicationControlConfig | WirelessTransferControlConfig | NetworkShareControlConfig | MessagingAppControlConfig | PrintContentConfig | WebActivityControlConfig | USBTransferConfig | FileTransferConfig | NetworkPreventionConfig | {} => {
  switch (type) {
    case 'classification_aware_policy':
    case 'cloud_upload_prevention':
    case 'email_send_prevention':
      // These use conditions/actions, not a typed config object.
      return {}

    case 'network_exfiltration_prevention':
      // Easy config form (like clipboard). Server derives conditions/actions.
      return {
        dataTypes: [],
        customPatterns: [],
        monitoredMethods: [],
        monitoredPorts: [21, 22, 69, 80, 443, 445, 8000, 8080],
        direction: 'outbound',
        action: 'block',
      } as NetworkPreventionConfig

    case 'clipboard_monitoring':
      return {
        patterns: {
          predefined: [],
          custom: []
        },
        action: 'alert'
      } as ClipboardConfig
    
    case 'file_system_monitoring':
      return {
        monitoredPaths: [],
        events: {
          create: true,
          modify: false,
          delete: false,
          move: false
        },
        patterns: {
          predefined: [],
          custom: [],
        },
        action: 'alert'
      } as FileSystemConfig

    case 'file_transfer_monitoring':
      return {
        protectedPaths: [],
        monitoredDestinations: [],
        fileExtensions: [],
        events: {
          create: true,
          modify: true,
          delete: false,
          move: true
        },
        patterns: {
          predefined: [],
          custom: [],
        },
        action: 'block'
      } as FileTransferConfig
    
    case 'usb_device_monitoring':
      return {
        events: {
          connect: true,
          disconnect: false,
          fileTransfer: false
        },
        action: 'alert'
      } as USBDeviceConfig
    
    case 'usb_file_transfer_monitoring':
      return {
        monitoredPaths: [],
        action: 'block'
      } as USBTransferConfig

    case 'usb_device_control':
      return { mode: 'enforce' } as USBDeviceControlConfig

    case 'printer_control':
      return { mode: 'enforce', scope: 'block_network' } as PrinterControlConfig

    case 'application_control':
      return { mode: 'allowlist', applications: [], channels: [], exceptions: {} } as ApplicationControlConfig

    case 'wireless_transfer_control':
      return { mode: 'enforce', block_bluetooth_file_transfer: true, block_nearby_sharing: true } as WirelessTransferControlConfig

    case 'network_share_control':
      return { mode: 'block_all', exceptions: {} } as NetworkShareControlConfig

    case 'messaging_app_control':
      return { action: 'alert', apps: [], exceptions: {} } as MessagingAppControlConfig

    case 'print_content_prevention':
      return { mode: 'enforce', levels: ['Confidential', 'Restricted'] } as PrintContentConfig

    // Deliberately rules NOTHING. Every other type ships defaults that do
    // something; this one ships an empty matrix, because an operator who saves
    // it unchanged must not discover afterwards that they have started blocking
    // their own company's email. Enforcement here is opt-in, cell by cell.
    case 'web_activity_control':
      return {
        mode: 'enforce',
        minLevel: 'Confidential',
        matrix: {},
        appOverrides: [],
        blockUninspectable: true,
      } as WebActivityControlConfig

    default:
      return {}
  }
}

// Merge a stored config over the type's defaults so every key the forms expect
// is present.
//
// The forms dereference their config directly — e.g. USBTransferPolicyForm does
// `config.monitoredPaths.length` — so a policy whose stored config omits a key
// threw "Cannot read properties of undefined" and React unmounted the tree,
// which the user sees as a BLANK SCREEN on edit. Policies created via the API or
// SQL (rather than through this wizard) routinely carry only a partial config,
// so this is not a rare edge case. Guarding here fixes every form at once
// instead of scattering `?.` through five components.
//
// The second pass fills nested object defaults (patterns{}, events{}) — a shallow
// spread would leave `config.patterns.custom` undefined and crash exactly the
// same way. Arrays are values, not containers to merge, so they're left alone.
const withConfigDefaults = (type: PolicyType | null, stored: any) => {
  const defaults: any = getDefaultConfig(type ?? 'clipboard_monitoring')
  const isPlainObject = (v: any) => v && typeof v === 'object' && !Array.isArray(v)
  if (!isPlainObject(stored)) return defaults

  const merged: any = { ...defaults, ...stored }
  for (const key of Object.keys(defaults)) {
    if (isPlainObject(defaults[key])) {
      merged[key] = { ...defaults[key], ...(isPlainObject(stored[key]) ? stored[key] : {}) }
    }
  }
  return merged
}

export default function PolicyCreatorModal({
  isOpen,
  onClose,
  onSave, 
  editingPolicy 
}: PolicyCreatorModalProps) {
  // When editing, skip step 1 (type selection) and go straight to step 2
  // (configuration). The policy type can't be changed for an existing
  // policy anyway, and landing on step 1 with a visually-selected-but-
  // internally-null type confuses users into clicking the tile again.
  const [step, setStep] = useState(editingPolicy ? 2 : 1)
  const [policyType, setPolicyType] = useState<PolicyType | null>(
    editingPolicy?.type || (editingPolicy ? 'classification_aware_policy' : null)
  )
  const [policyName, setPolicyName] = useState(editingPolicy?.name || '')
  const [description, setDescription] = useState(editingPolicy?.description || '')
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>(
    editingPolicy?.severity || 'medium'
  )
  const [priority, setPriority] = useState(editingPolicy?.priority || 100)
  const [enabled, setEnabled] = useState(editingPolicy?.enabled ?? true)
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState(editingPolicy?.agentIds?.[0] || '')
  const [config, setConfig] = useState<ClipboardConfig | FileSystemConfig | USBDeviceConfig | USBDeviceControlConfig | PrinterControlConfig | ApplicationControlConfig | WirelessTransferControlConfig | NetworkShareControlConfig | MessagingAppControlConfig | PrintContentConfig | WebActivityControlConfig | USBTransferConfig | FileTransferConfig | NetworkPreventionConfig>(
    withConfigDefaults(
      editingPolicy?.type || (editingPolicy ? 'classification_aware_policy' : null),
      editingPolicy?.config
    )
  )
  const [classificationPolicy, setClassificationPolicy] = useState<ClassificationPolicy>(() => {
    // DEFENSIVE: even after transformApiPolicyToFrontend there's no
    // guarantee the incoming policy has the exact {match,rules}+object
    // shape this form needs. Coerce into the expected structure rather
    // than dereferencing `.conditions.match` on a potentially-malformed
    // value (which used to blank the screen).
    const rawC: any = editingPolicy?.conditions
    const rawA: any = editingPolicy?.actions
    return {
      conditions: {
        match: (rawC && !Array.isArray(rawC) && rawC.match) || 'all',
        rules: Array.isArray(rawC?.rules)
          ? rawC.rules
          : Array.isArray(rawC)
            ? rawC
            : [],
      },
      actions:
        rawA && typeof rawA === 'object' && !Array.isArray(rawA)
          ? rawA
          : {},
    }
  })

  // Reset form when modal opens/closes or editing policy changes
  useEffect(() => {
    if (isOpen) {
      if (editingPolicy) {
        setStep(2) // skip type selection — can't change type for existing policy
        setPolicyType(editingPolicy.type || 'classification_aware_policy')
        setPolicyName(editingPolicy.name || '')
        setDescription(editingPolicy.description || '')
        setSeverity(editingPolicy.severity || 'medium')
        setPriority(editingPolicy.priority ?? 100)
        setEnabled(editingPolicy.enabled ?? true)
        setAgentId(editingPolicy.agentIds?.[0] || '')
        // Always merge over the type's defaults — do NOT gate on
        // `if (editingPolicy.config)`. A partial config is truthy, so that
        // check happily handed the forms an object missing the keys they
        // dereference, blanking the screen. Merging also covers the
        // config-absent case, which the old guard silently skipped.
        setConfig(
          withConfigDefaults(
            editingPolicy.type || 'classification_aware_policy',
            editingPolicy.config
          )
        )
        // Same defensive coercion as the initial useState — never
        // trust that `conditions` is {match,rules} or that `actions`
        // is an object, because the API serializer may send a list.
        const rawC: any = editingPolicy.conditions
        const rawA: any = editingPolicy.actions
        setClassificationPolicy({
          conditions: {
            match: (rawC && !Array.isArray(rawC) && rawC.match) || 'all',
            rules: Array.isArray(rawC?.rules)
              ? rawC.rules
              : Array.isArray(rawC)
                ? rawC
                : [],
          },
          actions:
            rawA && typeof rawA === 'object' && !Array.isArray(rawA)
              ? rawA
              : {},
        })
      } else {
        // Reset for new policy
        setStep(1)
        setPolicyType(null)
        setPolicyName('')
        setDescription('')
        setSeverity('medium')
        setPriority(100)
        setEnabled(true)
        setAgentId('')
        setConfig(getDefaultConfig('clipboard_monitoring'))
        setClassificationPolicy({
          conditions: {
            match: 'all',
            rules: []
          },
          actions: {}
        })
      }
    }
  }, [isOpen, editingPolicy])

  // Update config when type changes
  useEffect(() => {
    if (policyType && !editingPolicy) {
      setConfig(getDefaultConfig(policyType))
    }
  }, [policyType])

  // Load agents for single-select
  useEffect(() => {
    if (!isOpen) return
    getAgents()
      .then((data) => setAgents(Array.isArray(data) ? data : data?.items || []))
      .catch(() => setAgents([]))
  }, [isOpen])

  /*
    Escape-to-close, focus management, scroll lock and the focus trap all live
    in <Modal>. They used to be re-implemented here — and in six other dialogs,
    each slightly differently.
  */
  const handleClose = () => {
    setStep(1)
    onClose()
  }

  const handleNext = () => {
    if (step === 1) {
      if (!policyType) {
        toast.error('Please select a policy type')
        return
      }
      setStep(2)
    } else if (step === 2) {
      setStep(3)
    }
  }

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1)
    }
  }

  const handleSave = () => {
    if (!policyName.trim()) {
      toast.error('Policy name is required')
      return
    }

    if (!policyType) {
      toast.error('Policy type is required')
      return
    }

    let policy: Partial<Policy>

    if (usesClassificationBuilder(policyType)) {
      // Classification-aware policy uses conditions/actions format
      if (classificationPolicy.conditions.rules.length === 0) {
        toast.error('At least one condition is required for classification-aware policies')
        return
      }

      if (Object.keys(classificationPolicy.actions).length === 0) {
        toast.error('At least one action is required for classification-aware policies')
        return
      }

      // Convert conditions from {match, rules} to just rules array for API
      const conditionsArray = classificationPolicy.conditions.rules.map(rule => ({
        field: rule.field,
        operator: rule.operator,
        value: rule.value
      }))

      // Convert actions from {alert: {}, block: {}} to [{type: "alert", parameters: {}}, {type: "block", parameters: {}}]
      const actionsArray = Object.entries(classificationPolicy.actions).map(([actionType, actionConfig]) => ({
        type: actionType,
        parameters: actionConfig || {}
      }))

      policy = {
        name: policyName.trim(),
        description: description.trim() || undefined,
        priority,
        enabled,
        match: classificationPolicy.conditions.match,
        conditions: conditionsArray,
        actions: actionsArray,
        agentIds: agentId ? [agentId] : [],
        // Stamp the type for cloud-upload prevention so the server-side
        // evaluator scopes it to cloud_upload events; the generic
        // classification policy stays type-less.
        type: isChannelPolicy(policyType) ? policyType : undefined,
      } as unknown as Partial<Policy> & { match: 'all' | 'any' }
    } else {
      // Traditional policy uses type/severity/config format
      policy = {
        name: policyName.trim(),
        description: description.trim() || undefined,
        type: policyType,
        severity,
        priority,
        enabled,
        config,
        agentIds: agentId ? [agentId] : [],
      }

      const validation = validatePolicy(policy)
      if (!validation.valid) {
        toast.error(validation.errors[0] || 'Invalid policy configuration')
        return
      }
    }

    onSave(policy)
    handleClose()
  }

  const canProceedFromStep1 = policyType !== null
  const canProceedFromStep2 = policyType !== null && (
    usesClassificationBuilder(policyType)
      ? classificationPolicy.conditions.rules.length > 0 && Object.keys(classificationPolicy.actions).length > 0
      : config !== null
  )
  const canSave = policyName.trim() !== '' && policyType !== null

  const typeLabel = policyType ? getPolicyTypeLabel(policyType) : null
  const agentName = agents.find((a) => a.agent_id === agentId)?.name || null
  const STEPS = ['Type', 'Configure', 'Review'] as const

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      // Step 1 is a gallery and wants the room; after that the form decides.
      size={step === 1 || (policyType !== null && WIDE_FORMS.includes(policyType)) ? '3xl' : '2xl'}
      /* A half-written policy must not evaporate because a click landed beside
         the panel. Escape and Cancel are the ways out; both are deliberate. */
      closeOnBackdrop={false}
      initialFocus="#policy-name"
      label={editingPolicy ? 'Edit policy' : 'New policy'}
      header={
        /*
          The header states the POLICY TYPE once one is chosen, not "Create New
          Policy". After step 1 the type is the single most important fact about
          what you are editing, and it used to vanish the moment you left the
          type list.
        */
        <ModalHeader
          eyebrow={editingPolicy ? 'Edit policy' : 'New policy'}
          title={typeLabel || 'Choose what to protect'}
          onClose={handleClose}
        >
          {/*
            Replaces three large numbered circles and their connecting rules.
            In a modal that already scrolls, that device cost a band of vertical
            space to say what four words say — and steps you have completed are
            more useful as a way BACK than as decoration.
          */}
          <nav className="mt-3 flex items-center gap-1" aria-label="Progress">
            {STEPS.map((label, i) => {
              const n = i + 1
              const done = step > n
              const current = step === n
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!done}
                  onClick={() => done && setStep(n)}
                  aria-current={current ? 'step' : undefined}
                  className={`flex items-center gap-1.5 rounded-cs-pill px-2.5 py-1 text-[11.5px] font-medium transition-colors
                    focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint
                    ${current ? 'bg-cs-indigo-faint text-cs-indigo' : ''}
                    ${done ? 'text-cs-ink-2 hover:bg-cs-panel-2 cursor-pointer' : ''}
                    ${!done && !current ? 'text-cs-muted-2 cursor-default' : ''}`}
                >
                  {done ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <span
                      className={`grid h-[15px] w-[15px] place-items-center rounded-full text-[9.5px] font-semibold
                        ${current ? 'bg-cs-indigo text-white' : 'bg-cs-hair text-cs-muted'}`}
                    >
                      {n}
                    </span>
                  )}
                  {label}
                </button>
              )
            })}
          </nav>
        </ModalHeader>
      }
      footer={
        <ModalFooter
          left={
            step > 1 ? (
              <button onClick={handleBack} className="btn btn-ghost">
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
            ) : null
          }
        >
          <button onClick={handleClose} className="btn btn-ghost">
            Cancel
          </button>
          {step < 3 ? (
            <button
              onClick={handleNext}
              disabled={step === 1 ? !canProceedFromStep1 : !canProceedFromStep2}
              className="btn btn-primary"
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button onClick={handleSave} disabled={!canSave} className="btn btn-primary">
              {editingPolicy ? 'Save changes' : 'Create policy'}
            </button>
          )}
        </ModalFooter>
      }
    >

          {step === 1 && (
            <PolicyTypeSelector
              selectedType={policyType}
              onSelectType={(type) => {
                setPolicyType(type)
                setConfig(getDefaultConfig(type))
                // Pre-fill the conditions/actions builder with that channel's
                // matrix (block Confidential/Restricted) so the admin starts
                // from a working policy and can tune it. Deep-copied so editing
                // the form never mutates the shared template.
                const template = POLICY_TEMPLATES[type]
                if (template) {
                  setClassificationPolicy(JSON.parse(JSON.stringify(template)))
                }
              }}
            />
          )}

          {step === 2 && policyType && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-w-0 space-y-6">
                <Section eyebrow="Identity" title="Name and describe it">
                  <div className="space-y-3.5">
                    <Field label="Policy name" required htmlFor="policy-name">
                      <TextInput
                        id="policy-name"
                        value={policyName}
                        onChange={(e) => setPolicyName(e.target.value)}
                        placeholder="Block sensitive data leaving over USB"
                      />
                    </Field>
                    <Field
                      label="Description"
                      htmlFor="policy-desc"
                      hint="Why this exists. The next person to inherit it will thank you."
                    >
                      <TextArea
                        id="policy-desc"
                        rows={2}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Stops Confidential documents reaching removable drives."
                      />
                    </Field>
                  </div>
                </Section>

                <Section eyebrow="Scope" title="Where it applies">
                  <div className="space-y-3.5">
                    <div className="grid gap-3.5 sm:grid-cols-2">
                      {!usesClassificationBuilder(policyType) && (
                        <Field label="Severity" htmlFor="policy-severity">
                          <Select
                            id="policy-severity"
                            value={severity}
                            onChange={(e) => setSeverity(e.target.value as typeof severity)}
                          >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="critical">Critical</option>
                          </Select>
                        </Field>
                      )}
                      <Field
                        label="Priority"
                        htmlFor="policy-priority"
                        hint="Higher numbers are evaluated first."
                      >
                        <TextInput
                          id="policy-priority"
                          type="number"
                          min={1}
                          max={1000}
                          value={priority}
                          onChange={(e) => setPriority(parseInt(e.target.value) || 100)}
                        />
                      </Field>
                    </div>

                    <Field
                      label="Applies to"
                      htmlFor="policy-agent"
                      hint="Leave on every agent unless you are piloting this on one machine."
                    >
                      <Select
                        id="policy-agent"
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                      >
                        <option value="">Every agent</option>
                        {agents.map((agent) => (
                          <option key={agent.agent_id} value={agent.agent_id}>
                            {agent.name} ({agent.agent_id})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Toggle
                      id="policy-enabled"
                      checked={enabled}
                      onChange={setEnabled}
                      label="Active"
                      hint="Turn this off to save the policy without enforcing it."
                    />
                  </div>
                </Section>

                <Section eyebrow="Rules" title="What it does">
                {policyType === 'clipboard_monitoring' && (
                  <ClipboardPolicyForm
                    config={config as ClipboardConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}
                
                {policyType === 'file_system_monitoring' && (
                  <FileSystemPolicyForm
                    config={config as FileSystemConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'file_transfer_monitoring' && (
                  <FileTransferPolicyForm
                    config={config as FileTransferConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}
                
                {policyType === 'usb_device_monitoring' && (
                  <USBDevicePolicyForm
                    config={config as USBDeviceConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}
                
                {policyType === 'usb_file_transfer_monitoring' && (
                  <USBTransferPolicyForm
                    config={config as USBTransferConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'usb_device_control' && (
                  <USBDeviceControlForm
                    config={config as USBDeviceControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'printer_control' && (
                  <PrinterControlForm
                    config={config as PrinterControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'application_control' && (
                  <ApplicationControlForm
                    config={config as ApplicationControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'wireless_transfer_control' && (
                  <WirelessTransferControlForm
                    config={config as WirelessTransferControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'network_share_control' && (
                  <NetworkShareControlForm
                    config={config as NetworkShareControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'messaging_app_control' && (
                  <MessagingAppControlForm
                    config={config as MessagingAppControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'print_content_prevention' && (
                  <PrintContentForm
                    config={config as PrintContentConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'web_activity_control' && (
                  <WebActivityControlForm
                    config={config as WebActivityControlConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {policyType === 'network_exfiltration_prevention' && (
                  <NetworkPreventionPolicyForm
                    config={config as NetworkPreventionConfig}
                    onChange={(newConfig) => setConfig(newConfig)}
                  />
                )}

                {usesClassificationBuilder(policyType) && (
                  <ClassificationPolicyForm
                    policy={classificationPolicy}
                    onChange={(newPolicy) => setClassificationPolicy(newPolicy)}
                  />
                )}
                </Section>
              </div>

              <PolicySummary
                draft={{
                  policyType,
                  name: policyName,
                  severity,
                  enabled,
                  agentName,
                  config,
                  classification: classificationPolicy,
                }}
              />
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-w-0 space-y-6">
                <Section eyebrow="Review" title={policyName || 'Untitled policy'}>
                  {description && (
                    <p className="text-[13px] leading-relaxed text-cs-ink-2">{description}</p>
                  )}
                  <dl className="mt-3 divide-y divide-cs-hair-2 rounded-cs-card border border-cs-hair">
                    {[
                      ['Type', typeLabel],
                      ...(!usesClassificationBuilder(policyType)
                        ? [['Severity', <span key="s" className="capitalize">{severity}</span>]]
                        : []),
                      ['Priority', String(priority)],
                      ['Applies to', agentName || 'Every agent'],
                      ['State', enabled ? 'Active' : 'Saved but switched off'],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="flex items-baseline gap-4 px-3.5 py-2.5">
                        <dt className="w-28 shrink-0 text-[11.5px] font-medium text-cs-muted">{k}</dt>
                        <dd className="text-[13px] text-cs-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>

                {usesClassificationBuilder(policyType) && (
                  <Section eyebrow="Conditions" title={
                    classificationPolicy.conditions.match === 'all'
                      ? 'All of these must match'
                      : 'Any of these may match'
                  }>
                    <ul className="space-y-1.5">
                      {classificationPolicy.conditions.rules.map((rule, idx) => (
                        <li
                          key={idx}
                          className="rounded-cs-sm border border-cs-hair bg-cs-panel-2 px-3 py-2 font-mono text-[12px]"
                        >
                          <span className="text-cs-indigo">{rule.field}</span>{' '}
                          <span className="text-cs-muted">{rule.operator}</span>{' '}
                          <span className="text-cs-ink">{JSON.stringify(rule.value)}</span>
                        </li>
                      ))}
                      {classificationPolicy.conditions.rules.length === 0 && (
                        <li className="text-[12.5px] text-cs-muted">
                          No conditions — this policy matches everything on its channel.
                        </li>
                      )}
                    </ul>
                  </Section>
                )}

                {/*
                  The raw config used to be dumped as JSON on this screen. It is
                  kept, because it is genuinely useful when a policy misbehaves —
                  but folded away, because it is not how anyone decides whether
                  to press Create.
                */}
                <details className="group rounded-cs-card border border-cs-hair">
                  <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[12px] font-medium text-cs-muted
                                      hover:text-cs-ink focus:outline-none focus-visible:ring-[3px] focus-visible:ring-cs-indigo-faint">
                    Show the stored configuration
                  </summary>
                  <pre className="overflow-x-auto border-t border-cs-hair-2 bg-cs-panel-2 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-cs-ink-2">
{JSON.stringify(usesClassificationBuilder(policyType) ? classificationPolicy : config, null, 2)}
                  </pre>
                </details>
              </div>

              <PolicySummary
                draft={{
                  policyType,
                  name: policyName,
                  severity,
                  enabled,
                  agentName,
                  config,
                  classification: classificationPolicy,
                }}
              />
            </div>
          )}
    </Modal>
  )
}
