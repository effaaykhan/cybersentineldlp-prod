import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  UserPlus, Edit3, Power, Trash2, X, Shield, Loader2, AlertCircle,
  Users as UsersIcon,
} from 'lucide-react'

import {
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeactivateUser,
  adminHardDeleteUser,
  listAllPermissions,
  type AdminUser,
  type AdminUserCreateInput,
  type AdminUserUpdateInput,
  type PermissionDef,
} from '@/lib/api'
import { usePermission } from '@/hooks/usePermission'

// Roles exposed by the dropdowns — mirrors the backend whitelist.
const ROLE_OPTIONS = ['ADMIN', 'ANALYST', 'MANAGER', 'VIEWER'] as const

const EMPTY_CREATE: AdminUserCreateInput = {
  email: '',
  password: '',
  full_name: '',
  role: 'VIEWER',
  organization: 'CyberSentinel',
  username: '',
  department: '',
  clearance_level: 1,
  permissions: [],
}

export default function UserManagement() {
  const { has, permissions, role } = usePermission()
  const canManage = has('manage_users')
  const queryClient = useQueryClient()

  // MANDATORY debug (retained from previous version).
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[UserManagement] /auth/me permissions:', permissions)
    // eslint-disable-next-line no-console
    console.log('[UserManagement] role:', role, 'has(manage_users):', canManage)
  }, [permissions, role, canManage])

  const usersQ = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminListUsers({ limit: 500 }),
    enabled: canManage,
    refetchInterval: 30000,
  })

  const permsCatalogQ = useQuery({
    queryKey: ['permissions-catalog'],
    queryFn: () => listAllPermissions(),
    enabled: canManage,
    staleTime: 60 * 60 * 1000, // catalog is effectively static within a session
  })

  const createMutation = useMutation({
    mutationFn: (input: AdminUserCreateInput) => adminCreateUser(input),
    onSuccess: () => {
      toast.success('User created')
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setCreateOpen(false)
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || 'Create failed'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: AdminUserUpdateInput }) =>
      adminUpdateUser(id, input),
    onSuccess: () => {
      toast.success('User updated')
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setEditTarget(null)
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || 'Update failed'),
  })

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => adminDeactivateUser(id),
    onSuccess: () => {
      toast.success('User deactivated')
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || 'Deactivate failed'),
  })

  const hardDeleteMutation = useMutation({
    mutationFn: (id: string) => adminHardDeleteUser(id),
    onSuccess: () => {
      toast.success('User permanently deleted')
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      setDeleteTarget(null)
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.detail || 'Delete failed'),
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const users = usersQ.data ?? []
  const permsCatalog = permsCatalogQ.data ?? []

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => a.email.localeCompare(b.email)),
    [users]
  )

  // Permission gate (UX only; backend re-enforces)
  if (!canManage) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-xl bg-primary-50 text-primary-600 flex items-center justify-center mb-4">
          <Shield className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 mb-2">
          You don't have access to User Management
        </h2>
        <p className="text-slate-500 max-w-md">
          The <code>manage_users</code> permission is required. Contact your
          administrator if you believe this is an error.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow mb-1.5">Administration</p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
              <UsersIcon className="w-5 h-5" />
            </span>
            User Management
          </h1>
          <p className="text-slate-500 mt-1">
            Create, edit, revoke, and permanently delete DLP accounts. All
            actions are audited.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="btn-primary"
        >
          <UserPlus className="w-5 h-5" />
          Create User
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-card overflow-hidden">
        {usersQ.isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
          </div>
        ) : usersQ.isError ? (
          <div className="p-8 text-center">
            <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <p className="text-slate-700 font-medium">Failed to load users.</p>
            <button
              onClick={() => usersQ.refetch()}
              className="mt-3 text-primary-600 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : sortedUsers.length === 0 ? (
          <div className="p-12 text-center text-slate-500">No users yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <Th>Email</Th>
                  <Th>Username</Th>
                  <Th>Full Name</Th>
                  <Th>Department</Th>
                  <Th>Role</Th>
                  <Th>Clearance</Th>
                  <Th>Permissions</Th>
                  <Th>Status</Th>
                  <Th className="text-right pr-6">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                    <Td className="font-medium text-slate-900">{u.email}</Td>
                    <Td>{u.username || <span className="text-slate-400">—</span>}</Td>
                    <Td>{u.full_name}</Td>
                    <Td>{u.department || <span className="text-slate-400">—</span>}</Td>
                    <Td>
                      <RoleBadge role={u.role} />
                    </Td>
                    <Td className="font-mono tabular-nums">{u.clearance_level}</Td>
                    <Td>
                      <PermissionSummary
                        effective={u.permissions?.length ?? 0}
                        direct={u.direct_permissions?.length ?? 0}
                        total={permsCatalog.length || 15}
                      />
                    </Td>
                    <Td>
                      <StatusBadge active={u.is_active} />
                    </Td>
                    <Td className="text-right pr-6">
                      <div className="inline-flex gap-1">
                        <IconButton
                          title="Edit user + permissions"
                          onClick={() => setEditTarget(u)}
                          color="indigo"
                        >
                          <Edit3 className="w-4 h-4" />
                        </IconButton>
                        {u.is_active && (
                          <IconButton
                            title="Deactivate (soft)"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Deactivate ${u.email}? They will no longer be able to log in. You can reactivate them later.`
                                )
                              )
                                deactivateMutation.mutate(u.id)
                            }}
                            color="yellow"
                            disabled={deactivateMutation.isPending}
                          >
                            <Power className="w-4 h-4" />
                          </IconButton>
                        )}
                        <IconButton
                          title="Delete permanently"
                          onClick={() => setDeleteTarget(u)}
                          color="red"
                          disabled={hardDeleteMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createOpen && (
        <CreateUserDialog
          permsCatalog={permsCatalog}
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) => createMutation.mutate(input)}
          isSubmitting={createMutation.isPending}
        />
      )}

      {editTarget && (
        <EditUserDialog
          user={editTarget}
          permsCatalog={permsCatalog}
          onClose={() => setEditTarget(null)}
          onSubmit={(input) =>
            updateMutation.mutate({ id: editTarget.id, input })
          }
          isSubmitting={updateMutation.isPending}
        />
      )}

      {deleteTarget && (
        <HardDeleteDialog
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => hardDeleteMutation.mutate(deleteTarget.id)}
          isSubmitting={hardDeleteMutation.isPending}
        />
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Th({ children, className = '' }: any) {
  return (
    <th
      className={`px-6 py-3 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider ${className}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className = '' }: any) {
  return (
    <td className={`px-6 py-4 whitespace-nowrap text-sm text-slate-700 ${className}`}>
      {children}
    </td>
  )
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    ADMIN:   'bg-red-50 text-red-700 ring-red-600/20',
    ANALYST: 'bg-primary-50 text-primary-700 ring-primary-600/20',
    MANAGER: 'bg-purple-50 text-purple-700 ring-purple-600/20',
    VIEWER:  'bg-slate-100 text-slate-700 ring-slate-500/20',
    AGENT:   'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  }
  const cls = colors[role?.toUpperCase()] || 'bg-slate-100 text-slate-700 ring-slate-500/20'
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ring-1 ring-inset ${cls}`}>
      {role}
    </span>
  )
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-500/20">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Inactive
    </span>
  )
}

function PermissionSummary({
  effective,
  direct,
  total,
}: {
  effective: number
  direct: number
  total: number
}) {
  return (
    <span
      className="text-xs text-slate-600 font-mono tabular-nums"
      title={`${effective} effective permissions (role defaults + ${direct} direct grant${direct === 1 ? '' : 's'})`}
    >
      <span className="font-semibold text-slate-800">{effective}</span>
      <span className="text-slate-400"> / {total}</span>
      {direct > 0 && (
        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-600/20">
          +{direct} direct
        </span>
      )}
    </span>
  )
}

function IconButton({
  children,
  title,
  onClick,
  color,
  disabled,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  color: 'indigo' | 'yellow' | 'red'
  disabled?: boolean
}) {
  const colorMap: Record<string, string> = {
    indigo: 'hover:bg-primary-50 text-primary-600',
    yellow: 'hover:bg-amber-50 text-amber-600',
    red:    'hover:bg-red-50 text-red-600',
  }
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg ${colorMap[color]} disabled:opacity-50 transition-colors`}
    >
      {children}
    </button>
  )
}

// ── Create dialog ─────────────────────────────────────────────────────────
function CreateUserDialog({
  permsCatalog,
  onClose,
  onSubmit,
  isSubmitting,
}: {
  permsCatalog: PermissionDef[]
  onClose: () => void
  onSubmit: (input: AdminUserCreateInput) => void
  isSubmitting: boolean
}) {
  const [form, setForm] = useState<AdminUserCreateInput>({ ...EMPTY_CREATE })

  const update = <K extends keyof AdminUserCreateInput>(
    k: K,
    v: AdminUserCreateInput[K]
  ) => setForm((f) => ({ ...f, [k]: v }))

  const togglePerm = (name: string) => {
    setForm((f) => {
      const curr = new Set(f.permissions ?? [])
      if (curr.has(name)) curr.delete(name)
      else curr.add(name)
      return { ...f, permissions: Array.from(curr) }
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (form.password.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }
    onSubmit({
      ...form,
      username: form.username?.trim() || undefined,
      department: form.department?.trim() || undefined,
      permissions: form.permissions && form.permissions.length > 0
        ? form.permissions
        : undefined,
    })
  }

  return (
    <Modal title="Create User" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email (login identifier)" required>
            <input
              type="email"
              required
              className="input"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              placeholder="user@cybersentinel.siem"
            />
          </Field>
          <Field label="Username (display alias)">
            <input
              type="text"
              className="input"
              value={form.username || ''}
              onChange={(e) => update('username', e.target.value)}
              placeholder="jdoe"
            />
          </Field>
        </div>

        <Field label="Full name" required>
          <input
            type="text"
            required
            className="input"
            value={form.full_name}
            onChange={(e) => update('full_name', e.target.value)}
          />
        </Field>

        <Field label="Password" required>
          <input
            type="password"
            required
            minLength={8}
            className="input"
            value={form.password}
            onChange={(e) => update('password', e.target.value)}
            placeholder="≥8 chars, upper/lower/digit/symbol"
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Role" required>
            <select
              className="input"
              value={form.role}
              onChange={(e) => update('role', e.target.value)}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Clearance level">
            <input
              type="number"
              min={0}
              max={10}
              className="input"
              value={form.clearance_level ?? 1}
              onChange={(e) =>
                update('clearance_level', Number(e.target.value) || 0)
              }
            />
          </Field>
          <Field label="Department">
            <input
              type="text"
              className="input"
              value={form.department || ''}
              onChange={(e) => update('department', e.target.value)}
              placeholder="e.g. Finance"
            />
          </Field>
        </div>

        <PermissionPicker
          permsCatalog={permsCatalog}
          selected={form.permissions ?? []}
          onToggle={togglePerm}
          helpText={`Direct grants — added on top of what the ${form.role} role already provides. Admins get everything regardless.`}
        />

        <DialogActions onClose={onClose} submitLabel="Create" isSubmitting={isSubmitting} />
      </form>
    </Modal>
  )
}

// ── Edit dialog ───────────────────────────────────────────────────────────
function EditUserDialog({
  user,
  permsCatalog,
  onClose,
  onSubmit,
  isSubmitting,
}: {
  user: AdminUser
  permsCatalog: PermissionDef[]
  onClose: () => void
  onSubmit: (input: AdminUserUpdateInput) => void
  isSubmitting: boolean
}) {
  const [form, setForm] = useState<AdminUserUpdateInput>({
    full_name: user.full_name,
    role: user.role,
    department: user.department || '',
    clearance_level: user.clearance_level ?? 1,
    is_active: user.is_active,
    permissions: user.direct_permissions ?? [],
  })

  const update = <K extends keyof AdminUserUpdateInput>(
    k: K,
    v: AdminUserUpdateInput[K]
  ) => setForm((f) => ({ ...f, [k]: v }))

  const togglePerm = (name: string) => {
    setForm((f) => {
      const curr = new Set(f.permissions ?? [])
      if (curr.has(name)) curr.delete(name)
      else curr.add(name)
      return { ...f, permissions: Array.from(curr) }
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Always send permissions — an empty array means "revoke all direct grants".
    onSubmit({
      ...form,
      department: form.department === '' ? undefined : form.department,
      permissions: form.permissions ?? [],
    })
  }

  return (
    <Modal title={`Edit User — ${user.email}`} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Full name">
          <input
            type="text"
            className="input"
            value={form.full_name || ''}
            onChange={(e) => update('full_name', e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Role">
            <select
              className="input"
              value={form.role}
              onChange={(e) => update('role', e.target.value)}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field label="Clearance level">
            <input
              type="number"
              min={0}
              max={10}
              className="input"
              value={form.clearance_level ?? 1}
              onChange={(e) =>
                update('clearance_level', Number(e.target.value) || 0)
              }
            />
          </Field>
          <Field label="Department">
            <input
              type="text"
              className="input"
              value={form.department || ''}
              onChange={(e) => update('department', e.target.value)}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="active-toggle"
            type="checkbox"
            checked={!!form.is_active}
            onChange={(e) => update('is_active', e.target.checked)}
            className="h-4 w-4 accent-primary-600"
          />
          <label htmlFor="active-toggle" className="text-sm text-slate-700">
            Account is active
          </label>
        </div>

        <PermissionPicker
          permsCatalog={permsCatalog}
          selected={form.permissions ?? []}
          onToggle={togglePerm}
          helpText={`Currently granted directly. Unchecking revokes the permission from this user. Role defaults (${form.role}) still apply on top.`}
        />

        <DialogActions onClose={onClose} submitLabel="Save" isSubmitting={isSubmitting} />
      </form>
    </Modal>
  )
}

// ── Hard-delete confirmation ──────────────────────────────────────────────
function HardDeleteDialog({
  user,
  onClose,
  onConfirm,
  isSubmitting,
}: {
  user: AdminUser
  onClose: () => void
  onConfirm: () => void
  isSubmitting: boolean
}) {
  const [typed, setTyped] = useState('')
  const confirmed = typed.trim() === user.email

  return (
    <Modal title="Delete user permanently" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 border border-red-200">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800">
            <p className="font-semibold">This cannot be undone.</p>
            <p className="mt-1">
              The row will be removed from the database. Audit entries they
              authored will be retained but lose the actor link.
            </p>
          </div>
        </div>
        <p className="text-sm text-slate-700">
          Type <code className="px-1 py-0.5 bg-slate-100 rounded font-mono text-slate-900">{user.email}</code> to confirm.
        </p>
        <input
          type="text"
          className="input font-mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={user.email}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!confirmed || isSubmitting}
            onClick={onConfirm}
            className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Delete permanently
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Permission picker ─────────────────────────────────────────────────────
function PermissionPicker({
  permsCatalog,
  selected,
  onToggle,
  helpText,
}: {
  permsCatalog: PermissionDef[]
  selected: string[]
  onToggle: (name: string) => void
  helpText?: string
}) {
  const selectedSet = new Set(selected)

  // Group permissions by their natural prefix so the grid is scannable.
  const groups = useMemo(() => {
    const g: Record<string, PermissionDef[]> = {}
    for (const p of permsCatalog) {
      const key = p.name.startsWith('view_all')
        ? 'data visibility'
        : p.name.startsWith('view_')
          ? 'read'
          : p.name.includes('_policy') || p.name.includes('_dashboard')
            ? 'write'
            : p.name.startsWith('manage_')
              ? 'admin'
              : 'other'
      if (!g[key]) g[key] = []
      g[key].push(p)
    }
    return g
  }, [permsCatalog])

  if (permsCatalog.length === 0) {
    return (
      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-500">
        Loading permission catalog…
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-800">
          Direct Permissions
          <span className="ml-2 text-xs text-slate-500 font-normal font-mono tabular-nums">
            {selected.length} of {permsCatalog.length} selected
          </span>
        </span>
      </div>
      {helpText && (
        <p className="text-xs text-slate-500 mb-3">{helpText}</p>
      )}
      <div className="space-y-3">
        {Object.entries(groups).map(([group, perms]) => (
          <div key={group}>
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
              {group}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {perms.map((p) => (
                <label
                  key={p.id}
                  className="flex items-start gap-2 cursor-pointer hover:bg-slate-50 px-2 py-1 rounded-lg"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-0.5 accent-primary-600"
                    checked={selectedSet.has(p.name)}
                    onChange={() => onToggle(p.name)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-800 font-mono truncate">
                      {p.name}
                    </div>
                    {p.description && (
                      <div className="text-xs text-slate-500 truncate">
                        {p.description}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Shared primitives ─────────────────────────────────────────────────────
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
  wide?: boolean
}) {
  // Close on Escape, lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    // Use items-start + py-8 so tall content doesn't get its top clipped off
    // the viewport (flex-centering would push it beyond the scroll region).
    // The outer layer scrolls if the card exceeds viewport height.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        // max-h caps the card to leave breathing room top+bottom; min-h-0 on
        // the flex child lets the body's overflow-y-auto actually scroll.
        className={`bg-white rounded-xl border border-slate-200 shadow-xl w-full flex flex-col max-h-[calc(100vh-4rem)] ${
          wide ? 'max-w-2xl' : 'max-w-md'
        }`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0">{children}</div>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </span>
      {children}
    </label>
  )
}

function DialogActions({
  onClose,
  submitLabel,
  isSubmitting,
}: {
  onClose: () => void
  submitLabel: string
  isSubmitting: boolean
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onClose}
        className="btn-secondary"
        disabled={isSubmitting}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={isSubmitting}
        className="btn-primary disabled:opacity-60"
      >
        {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
        {submitLabel}
      </button>
    </div>
  )
}
