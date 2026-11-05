import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, Crown, MailPlus, MoreHorizontal, Pencil, RotateCcw, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, num } from '../../lib/format';
import { UsageMeters, type MeterUsage } from '../../components/UsagePanel';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  JsonView,
  KeyValue,
  Menu,
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  Pagination,
  Select,
  StatusBadge,
  Tabs,
  When,
  useConfirm,
  type MenuItem,
} from '../../components/ui';
import { EntitlementsPanel } from '../../components/EntitlementsPanel';
import type { OrgRow } from './OrganizationsPage';
import { CustomFieldInputs, PriorityBadge, RoleField, SlaBadge, UserPicker, formatCustomValue, useCustomFieldDefs, type PickedUser } from './shared';

interface Member {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  user_status: string;
  role: string;
  status: 'active' | 'invited' | 'pending_approval' | 'suspended';
  created_at: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  requires_approval: boolean;
  expires_at: string;
  created_at: string;
}

interface OrgDetail extends OrgRow {
  members: Member[];
  invitations: Invitation[];
  panels: {
    billing?: { subscriptions: { id: string; status: string; quantity: number; current_period_end: string | null; product_name: string }[] };
  };
}

interface CreditBalance {
  type: string;
  balance: number;
  updatedAt: string;
}

interface LedgerRow {
  id: string;
  credit_type: string;
  amount: number;
  balance_after: number;
  remaining: number | null;
  reason: string | null;
  source: string;
  expires_at: string | null;
  created_at: string;
}

interface AuditRow {
  seq: number;
  id: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

interface TicketRow {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  requester_email: string;
  assignee_name: string | null;
  sla_breached_at: string | null;
  first_responded_at: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  updated_at: string;
}

// ---- Dialogs ----------------------------------------------------------------------------------

function EditOrganizationDialog({ org, open, onOpenChange }: { org: OrgDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const defs = useCustomFieldDefs('organization', open);
  const [form, setForm] = useState({
    name: org.name,
    slug: org.slug,
    externalId: org.external_id ?? '',
    billingEmail: org.billing_email ?? '',
    seatLimit: org.seat_limit ? String(org.seat_limit) : '',
    customDomain: org.custom_domain ?? '',
    tags: org.tags.join(', '),
  });
  const [custom, setCustom] = useState<Record<string, unknown>>(org.custom_fields ?? {});
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch(`/api/admin/organizations/${org.id}`, {
        name: form.name,
        slug: form.slug || undefined,
        externalId: form.externalId || undefined,
        billingEmail: form.billingEmail || undefined,
        seatLimit: form.seatLimit ? Number(form.seatLimit) : null,
        customDomain: form.customDomain || null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        customFields: custom,
      }),
    { success: 'Organization updated', invalidate: [['organization', org.id], ['organizations']], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit organization"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-org" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-org"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Name" htmlFor="eo-name" required>
          <Input id="eo-name" value={form.name} onChange={set('name')} required />
        </Field>
        <Field label="Slug" htmlFor="eo-slug">
          <Input id="eo-slug" value={form.slug} onChange={set('slug')} />
        </Field>
        <Field label="Billing email" htmlFor="eo-billing">
          <Input id="eo-billing" type="email" value={form.billingEmail} onChange={set('billingEmail')} />
        </Field>
        <Field label="Seat limit" htmlFor="eo-seats" hint="Empty means unlimited">
          <Input id="eo-seats" type="number" min={1} step={1} value={form.seatLimit} onChange={set('seatLimit')} />
        </Field>
        <Field label="External ID" htmlFor="eo-ext">
          <Input id="eo-ext" value={form.externalId} onChange={set('externalId')} />
        </Field>
        <Field label="Custom domain" htmlFor="eo-domain">
          <Input id="eo-domain" value={form.customDomain} onChange={set('customDomain')} placeholder="app.example.com" />
        </Field>
        <Field label="Tags" htmlFor="eo-tags" hint="Comma separated" className="sm:col-span-2">
          <Input id="eo-tags" value={form.tags} onChange={set('tags')} />
        </Field>
        <CustomFieldInputs defs={defs.data?.data ?? []} value={custom} onChange={setCustom} idPrefix="eo-cf" />
      </form>
    </Modal>
  );
}

function AddMemberDialog({ org, open, onOpenChange }: { org: OrgDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [user, setUser] = useState<PickedUser | null>(null);
  const [role, setRole] = useState('member');
  const [error, setError] = useState<string | null>(null);
  const add = useAction(() => api.post(`/api/admin/organizations/${org.id}/members`, { userId: user!.id, role }), {
    success: 'Member added',
    invalidate: [['organization', org.id], ['organizations']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add an existing user"
      description="The user joins immediately. Seat limits are enforced."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-member" loading={add.isPending} disabled={!user}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="add-member"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          add.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="User" htmlFor="am-user" required>
          <UserPicker id="am-user" value={user} onChange={setUser} excludeIds={org.members.map((m) => m.user_id)} />
        </Field>
        <Field label="Role" htmlFor="am-role" hint="Roles are defined by your application, for example admin, member or billing.">
          <RoleField id="am-role" value={role} onChange={setRole} />
        </Field>
      </form>
    </Modal>
  );
}

function InviteDialog({ org, open, onOpenChange }: { org: OrgDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invite = useAction(() => api.post<{ email: string }>(`/api/admin/organizations/${org.id}/invitations`, { email, role, requiresApproval }), {
    success: (r) => `Invitation sent to ${r.email}`,
    invalidate: [['organization', org.id]],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Invite to ${org.name}`}
      description="An invitation email with a link valid for 14 days is sent to the address."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="invite-member" loading={invite.isPending}>
            Send invitation
          </Button>
        </>
      }
    >
      <form
        id="invite-member"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          invite.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Email" htmlFor="inv-email" required>
          <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Role" htmlFor="inv-role">
          <RoleField id="inv-role" value={role} onChange={setRole} />
        </Field>
        <Checkbox checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} label="Require approval after acceptance" description="The membership stays pending until an organization admin approves it." />
      </form>
    </Modal>
  );
}

function RoleDialog({ org, member, onClose }: { org: OrgDetail; member: Member; onClose: () => void }) {
  const [role, setRole] = useState(member.role);
  const save = useAction(() => api.patch(`/api/admin/organizations/${org.id}/members/${member.user_id}`, { role }), {
    success: 'Role updated',
    invalidate: [['organization', org.id]],
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Change role for ${member.name || member.email}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="member-role" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="member-role"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Role" htmlFor="mr-role" hint="Use “Make owner” to transfer ownership.">
          <RoleField id="mr-role" value={role} onChange={setRole} />
        </Field>
      </form>
    </Modal>
  );
}

function UsageAdjustDialog({ orgId, meters, mode, onClose }: { orgId: string; meters: MeterUsage[]; mode: 'adjust' | 'reset'; onClose: () => void }) {
  const [meter, setMeter] = useState(meters[0]?.meter ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = useAction(
    () =>
      mode === 'adjust'
        ? api.post('/api/admin/usage/adjust', { orgId, meter, quantity: Number(quantity), reason })
        : api.post('/api/admin/usage/reset', { orgId, meter, reason }),
    { success: mode === 'adjust' ? 'Usage adjusted' : 'Usage reset for this period', invalidate: [['org-usage', orgId]], onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'adjust' ? 'Correct usage' : 'Reset usage'}
      description={mode === 'adjust' ? 'Add (positive) or remove (negative) units, for example after an incident. Recorded in the usage log and audit log.' : 'Sets the current period’s usage of the meter back to zero.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="usage-adjust" variant={mode === 'reset' ? 'danger' : 'primary'} loading={submit.isPending}>
            {mode === 'adjust' ? 'Apply correction' : 'Reset usage'}
          </Button>
        </>
      }
    >
      <form
        id="usage-adjust"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          submit.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Meter" htmlFor="ua-meter">
          <Select id="ua-meter" value={meter} onChange={(e) => setMeter(e.target.value)} options={meters.map((m) => ({ value: m.meter, label: `${m.name} (${num(m.used)} used)` }))} />
        </Field>
        {mode === 'adjust' && (
          <Field label="Units" htmlFor="ua-qty" hint="Use a negative number to remove usage">
            <Input id="ua-qty" type="number" step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
          </Field>
        )}
        <Field label="Reason" htmlFor="ua-reason" required>
          <Input id="ua-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

function CreditsDialog({ orgId, types, onClose }: { orgId: string; types: string[]; onClose: () => void }) {
  const [form, setForm] = useState({ action: 'grant', creditType: types[0] ?? 'credits', amount: '', reason: '', expiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = useAction(
    () =>
      api.post(`/api/admin/credits/${form.action}`, {
        orgId,
        creditType: form.creditType,
        amount: Number(form.amount),
        reason: form.reason,
        expiresAt: form.action === 'grant' && form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      }),
    { success: form.action === 'grant' ? 'Credits granted' : 'Credits deducted', invalidate: [['org-usage', orgId], ['org-credits', orgId]], onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Adjust credits"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="org-credits" loading={submit.isPending}>
            {form.action === 'grant' ? 'Grant credits' : 'Deduct credits'}
          </Button>
        </>
      }
    >
      <form
        id="org-credits"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          submit.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Action" htmlFor="oc-action">
          <Select id="oc-action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} options={[{ value: 'grant', label: 'Grant (complimentary)' }, { value: 'deduct', label: 'Deduct' }]} />
        </Field>
        <Field label="Credit type" htmlFor="oc-type">
          <Input id="oc-type" value={form.creditType} onChange={(e) => setForm({ ...form, creditType: e.target.value })} required />
        </Field>
        <Field label="Amount" htmlFor="oc-amount">
          <Input id="oc-amount" type="number" min={1} step={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
        </Field>
        {form.action === 'grant' && (
          <Field label="Expires" htmlFor="oc-exp" hint="Optional">
            <Input id="oc-exp" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
        )}
        <Field label="Reason" htmlFor="oc-reason" hint="Recorded in the credit ledger and audit log" className="sm:col-span-2">
          <Input id="oc-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Tabs -------------------------------------------------------------------------------------

function OverviewTab({ org }: { org: OrgDetail }) {
  const { can } = useAuth();
  const defs = useCustomFieldDefs('organization', can('customers.users.view'));
  const defByKey = new Map((defs.data?.data ?? []).map((d) => [d.key, d]));
  const custom = Object.entries(org.custom_fields ?? {});
  const owner = org.members.find((m) => m.user_id === org.owner_user_id);
  const active = org.members.filter((m) => m.status === 'active').length;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Details" className="lg:col-span-2">
        <KeyValue
          items={[
            { label: 'Organization ID', value: <Mono copy>{org.id}</Mono> },
            { label: 'Slug', value: <Mono>{org.slug}</Mono> },
            { label: 'External ID', value: <Mono copy>{org.external_id}</Mono> },
            {
              label: 'Owner',
              value: owner ? (
                <Link className="text-primary hover:underline" to={`/customers/users/${owner.user_id}`}>
                  {owner.name || owner.email}
                </Link>
              ) : (
                'No owner'
              ),
            },
            { label: 'Billing email', value: org.billing_email },
            { label: 'Seats', value: org.seat_limit ? `${num(active)} of ${num(org.seat_limit)} used` : `${num(active)} active · unlimited` },
            { label: 'Custom domain', value: org.custom_domain },
            { label: 'Created', value: dateTime(org.created_at) },
            { label: 'Last updated', value: dateTime(org.updated_at) },
          ]}
        />
      </Card>
      <div className="space-y-4">
        <Card title="Tags">
          {org.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {org.tags.map((t) => (
                <Badge key={t} tone="primary">
                  {t}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tags.</p>
          )}
        </Card>
        {custom.length > 0 && (
          <Card title="Custom fields">
            <KeyValue columns={1} items={custom.map(([k, v]) => ({ label: defByKey.get(k)?.label ?? k, value: formatCustomValue(defByKey.get(k), v) }))} />
          </Card>
        )}
        {Object.keys(org.metadata ?? {}).length > 0 && (
          <Card title="Metadata">
            <JsonView value={org.metadata} />
          </Card>
        )}
      </div>
    </div>
  );
}

function MembersTab({ org }: { org: OrgDetail }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('customers.organizations.manage');
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editingRole, setEditingRole] = useState<Member | null>(null);
  const invalidate = [['organization', org.id], ['organizations']];
  const update = useAction((v: { userId: string; status: 'active' | 'suspended' }) => api.patch(`/api/admin/organizations/${org.id}/members/${v.userId}`, { status: v.status }), {
    success: (_r, v) => (v.status === 'active' ? 'Membership activated' : 'Membership suspended'),
    invalidate,
  });
  const remove = useAction((userId: string) => api.delete(`/api/admin/organizations/${org.id}/members/${userId}`), { success: 'Member removed', invalidate });
  const transfer = useAction((userId: string) => api.post(`/api/admin/organizations/${org.id}/transfer-ownership`, { userId }), { success: 'Ownership transferred', invalidate });
  const revoke = useAction((id: string) => api.delete(`/api/admin/organizations/${org.id}/invitations/${id}`), { success: 'Invitation revoked', invalidate: [['organization', org.id]] });

  const actionsFor = (m: Member): MenuItem[] => [
    { label: 'Change role', icon: <Pencil className="size-4" />, onSelect: () => setEditingRole(m), hidden: m.role === 'owner' },
    { label: 'Approve membership', icon: <UserPlus className="size-4" />, onSelect: () => update.mutate({ userId: m.user_id, status: 'active' }), hidden: m.status !== 'pending_approval' },
    {
      label: 'Make owner',
      icon: <Crown className="size-4" />,
      hidden: m.role === 'owner' || m.status !== 'active',
      onSelect: async () => {
        const r = await confirm({ title: `Make ${m.name || m.email} the owner?`, description: 'The current owner becomes an admin of the organization.', confirmLabel: 'Transfer ownership' });
        if (r.confirmed) transfer.mutate(m.user_id);
      },
    },
    {
      label: 'Suspend membership',
      icon: <Ban className="size-4" />,
      hidden: m.status !== 'active' || m.role === 'owner',
      onSelect: async () => {
        if ((await confirm({ title: `Suspend ${m.name || m.email} in ${org.name}?`, description: 'They keep their account but lose access to this organization.', confirmLabel: 'Suspend' })).confirmed) update.mutate({ userId: m.user_id, status: 'suspended' });
      },
    },
    { label: 'Reactivate membership', icon: <RotateCcw className="size-4" />, hidden: m.status !== 'suspended', onSelect: () => update.mutate({ userId: m.user_id, status: 'active' }) },
    { separator: true, label: '', hidden: m.role === 'owner' },
    {
      label: 'Remove from organization',
      icon: <UserMinus className="size-4" />,
      danger: true,
      hidden: m.role === 'owner',
      onSelect: async () => {
        if ((await confirm({ title: `Remove ${m.name || m.email}?`, description: `They lose access to ${org.name}. Their user account is not deleted.`, tone: 'danger', confirmLabel: 'Remove' })).confirmed) remove.mutate(m.user_id);
      },
    },
  ];

  return (
    <div className="space-y-4">
      <Card
        title="Members"
        description={org.seat_limit ? `${org.members.filter((m) => m.status === 'active').length} of ${org.seat_limit} seats in use` : undefined}
        padded={false}
        actions={
          manage && (
            <>
              <Button size="sm" variant="outline" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
                Add user
              </Button>
              <Button size="sm" variant="outline" icon={<MailPlus className="size-4" />} onClick={() => setInviting(true)}>
                Invite by email
              </Button>
            </>
          )
        }
      >
        <DataTable
          caption="Members"
          rows={org.members}
          rowKey={(m) => m.id}
          empty={<EmptyState title="No members" description="Add existing users or invite people by email." />}
          columns={[
            {
              key: 'member',
              header: 'Member',
              cell: (m) => (
                <Link to={`/customers/users/${m.user_id}`} className="block min-w-0 hover:underline">
                  <span className="block truncate font-medium">{m.name || m.email}</span>
                  {m.name && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                </Link>
              ),
            },
            { key: 'role', header: 'Role', cell: (m) => (m.role === 'owner' ? <Badge tone="primary"><Crown className="size-3" aria-hidden="true" />owner</Badge> : <Badge>{m.role}</Badge>) },
            {
              key: 'status',
              header: 'Status',
              cell: (m) => (
                <span className="flex flex-wrap gap-1">
                  <StatusBadge status={m.status} />
                  {m.user_status !== 'active' && <Badge tone="warning">user {m.user_status}</Badge>}
                </span>
              ),
            },
            { key: 'joined', header: 'Joined', cell: (m) => <When value={m.created_at} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (m) =>
                manage ? (
                  <Menu
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.name || m.email}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                    items={actionsFor(m)}
                  />
                ) : null,
            },
          ]}
        />
      </Card>

      <Card title="Pending invitations" padded={false}>
        <DataTable
          caption="Pending invitations"
          rows={org.invitations}
          rowKey={(i) => i.id}
          empty={<p className="px-4 py-4 text-sm text-muted-foreground">No pending invitations.</p>}
          columns={[
            { key: 'email', header: 'Email', cell: (i) => i.email },
            { key: 'role', header: 'Role', cell: (i) => <Badge>{i.role}</Badge> },
            { key: 'approval', header: 'Approval', cell: (i) => (i.requires_approval ? <Badge tone="warning">required</Badge> : <span className="text-muted-foreground">—</span>) },
            { key: 'expires', header: 'Expires', cell: (i) => <When value={i.expires_at} /> },
            {
              key: 'revoke',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (i) =>
                manage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={async () => {
                      if ((await confirm({ title: `Revoke the invitation for ${i.email}?`, confirmLabel: 'Revoke', tone: 'danger' })).confirmed) revoke.mutate(i.id);
                    }}
                  >
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>

      {adding && <AddMemberDialog org={org} open={adding} onOpenChange={setAdding} />}
      {inviting && <InviteDialog org={org} open={inviting} onOpenChange={setInviting} />}
      {editingRole && <RoleDialog org={org} member={editingRole} onClose={() => setEditingRole(null)} />}
    </div>
  );
}

function BillingTab({ org }: { org: OrgDetail }) {
  const subs = org.panels.billing?.subscriptions ?? [];
  return (
    <Card title="Subscriptions" description="Plans billed to the organization (seat-based plans use the quantity)" padded={false}>
      <DataTable
        caption="Subscriptions"
        rows={subs}
        rowKey={(s) => s.id}
        rowHref={(s) => `/revenue/subscriptions/${s.id}`}
        empty={<EmptyState title="No subscriptions" />}
        columns={[
          { key: 'product', header: 'Plan', cell: (s) => s.product_name },
          { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
          { key: 'quantity', header: 'Quantity', align: 'right', cell: (s) => <span className="tabular">{num(s.quantity)}</span> },
          { key: 'period', header: 'Current period ends', cell: (s) => dateTime(s.current_period_end) },
        ]}
      />
    </Card>
  );
}

function UsageTab({ org }: { org: OrgDetail }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<'adjust' | 'reset' | 'credits' | null>(null);
  const [page, setPage] = useState(1);
  const usage = useQuery({ queryKey: ['org-usage', org.id], queryFn: () => api.get<{ meters: MeterUsage[]; credits: CreditBalance[] }>('/api/admin/usage', { orgId: org.id }) });
  const credits = useQuery({
    queryKey: ['org-credits', org.id, page],
    queryFn: () => api.get<{ balances: CreditBalance[]; ledger: Page<LedgerRow> }>('/api/admin/credits', { orgId: org.id, page, pageSize: 10 }),
    enabled: can('usage.credits.view'),
    placeholderData: keepPreviousData,
  });
  if (usage.isLoading) return <PageSkeleton />;
  if (usage.error) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const meters = usage.data?.meters ?? [];
  const balances = usage.data?.credits ?? [];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Quotas and usage"
          description="Shared by all members, enforced on the server"
          className="lg:col-span-2"
          actions={
            can('usage.adjust.manage') &&
            meters.length > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={() => setDialog('adjust')}>
                  Correct
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDialog('reset')}>
                  Reset
                </Button>
              </>
            )
          }
        >
          <UsageMeters meters={meters} />
        </Card>
        <Card title="Credit balances" actions={can('usage.credits.manage') && <Button size="sm" variant="outline" onClick={() => setDialog('credits')}>Adjust</Button>}>
          {balances.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credits.</p>
          ) : (
            <ul className="divide-y">
              {balances.map((c) => (
                <li key={c.type} className="flex items-center justify-between py-2 text-sm">
                  <span>{c.type}</span>
                  <span className="font-semibold tabular">{num(c.balance)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {can('usage.credits.view') && (
        <Card title="Credit ledger" padded={false}>
          <DataTable
            caption="Credit ledger"
            rows={credits.data?.ledger.data}
            loading={credits.isLoading}
            fetching={credits.isFetching && !credits.isLoading}
            rowKey={(l) => l.id}
            empty={<p className="px-4 py-4 text-sm text-muted-foreground">No credit movements.</p>}
            columns={[
              { key: 'amount', header: 'Change', cell: (l) => <span className={l.amount > 0 ? 'font-medium text-success tabular' : 'font-medium tabular'}>{l.amount > 0 ? '+' : ''}{num(l.amount)} {l.credit_type}</span> },
              { key: 'balance', header: 'Balance after', align: 'right', cell: (l) => <span className="tabular">{num(l.balance_after)}</span> },
              { key: 'source', header: 'Source', cell: (l) => <Badge>{l.source}</Badge> },
              { key: 'reason', header: 'Reason', cell: (l) => <span className="block max-w-xs truncate">{l.reason ?? '—'}</span> },
              { key: 'expires', header: 'Expires', priority: 'low', cell: (l) => (l.expires_at ? dateTime(l.expires_at) : '—') },
              { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} /> },
            ]}
          />
          {credits.data && <Pagination page={credits.data.ledger.page} pageSize={credits.data.ledger.pageSize} total={credits.data.ledger.total} onPage={setPage} />}
        </Card>
      )}
      {(dialog === 'adjust' || dialog === 'reset') && <UsageAdjustDialog orgId={org.id} meters={meters} mode={dialog} onClose={() => setDialog(null)} />}
      {dialog === 'credits' && <CreditsDialog orgId={org.id} types={balances.map((b) => b.type)} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SupportTab({ org }: { org: OrgDetail }) {
  const [page, setPage] = useState(1);
  const tickets = useQuery({
    queryKey: ['tickets', { orgId: org.id, page }],
    queryFn: () => api.get<Page<TicketRow>>('/api/admin/support/tickets', { orgId: org.id, page, pageSize: 20, sort: 'updated_at' }),
    placeholderData: keepPreviousData,
  });
  if (tickets.error) return <ErrorState error={tickets.error} onRetry={() => void tickets.refetch()} />;
  return (
    <Card title="Support tickets" padded={false}>
      <DataTable
        caption="Support tickets"
        rows={tickets.data?.data}
        loading={tickets.isLoading}
        fetching={tickets.isFetching && !tickets.isLoading}
        rowKey={(t) => t.id}
        rowHref={(t) => `/customers/support/${t.id}`}
        empty={<EmptyState title="No tickets from this organization" />}
        columns={[
          { key: 'subject', header: 'Ticket', cell: (t) => <span className="block max-w-sm truncate">{t.number} · {t.subject}</span> },
          { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
          { key: 'priority', header: 'Priority', cell: (t) => <PriorityBadge priority={t.priority} /> },
          { key: 'sla', header: 'SLA', cell: (t) => <SlaBadge ticket={t} compact /> },
          { key: 'requester', header: 'Requester', priority: 'low', cell: (t) => t.requester_email },
          { key: 'updated', header: 'Updated', cell: (t) => <When value={t.updated_at} /> },
        ]}
      />
      {tickets.data && <Pagination page={tickets.data.page} pageSize={tickets.data.pageSize} total={tickets.data.total} onPage={setPage} />}
    </Card>
  );
}

function ActivityTab({ org }: { org: OrgDetail }) {
  const [page, setPage] = useState(1);
  const logs = useQuery({
    queryKey: ['org-audit', org.id, page],
    queryFn: () => api.get<Page<AuditRow>>('/api/admin/audit-logs', { targetType: 'organization', targetId: org.id, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  if (logs.error) return <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />;
  return (
    <Card title="Administrative activity" description="Changes made to this organization, from the audit log" padded={false}>
      <DataTable
        caption="Administrative activity"
        rows={logs.data?.data}
        loading={logs.isLoading}
        fetching={logs.isFetching && !logs.isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No recorded changes" />}
        columns={[
          { key: 'action', header: 'Action', cell: (a) => <span className="font-mono text-xs">{a.action}</span> },
          { key: 'actor', header: 'By', cell: (a) => a.actor_label ?? a.actor_type },
          {
            key: 'details',
            header: 'Details',
            priority: 'low',
            cell: (a) => {
              const meta = a.metadata && Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '';
              return <span className="block max-w-md truncate font-mono text-xs text-muted-foreground" title={meta}>{meta || '—'}</span>;
            },
          },
          { key: 'when', header: 'When', cell: (a) => <When value={a.created_at} /> },
        ]}
      />
      {logs.data && <Pagination page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPage={setPage} />}
    </Card>
  );
}

// ---- Page -------------------------------------------------------------------------------------

export default function OrganizationDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const q = useQuery({ queryKey: ['organization', id], queryFn: () => api.get<OrgDetail>(`/api/admin/organizations/${id}`) });
  const invalidate = [['organization', id], ['organizations']];
  const setStatus = useAction((body: { status: 'active' | 'suspended'; reason?: string }) => api.post(`/api/admin/organizations/${id}/status`, body), {
    success: (_r, v) => (v.status === 'active' ? 'Organization reactivated' : 'Organization suspended'),
    invalidate,
  });
  const remove = useAction(() => api.delete(`/api/admin/organizations/${id}`), {
    success: 'Organization deleted',
    invalidate: [['organizations']],
    onSuccess: () => navigate('/customers/organizations', { replace: true }),
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const org = q.data;
  const manage = can('customers.organizations.manage');
  const activeMembers = org.members.filter((m) => m.status === 'active').length;

  const actions: MenuItem[] = [
    { label: 'Add an existing user', icon: <UserPlus className="size-4" />, onSelect: () => setAdding(true), hidden: !manage },
    { label: 'Invite by email', icon: <MailPlus className="size-4" />, onSelect: () => setInviting(true), hidden: !manage },
    { separator: true, label: '', hidden: !manage },
    {
      label: 'Suspend organization',
      icon: <Ban className="size-4" />,
      hidden: !manage || org.status !== 'active',
      onSelect: async () => {
        const r = await confirm({ title: `Suspend ${org.name}?`, description: 'Members lose access to this organization until it is reactivated. Your application receives an organization.suspended event.', confirmLabel: 'Suspend', reason: { label: 'Reason (recorded in the audit log)', required: true } });
        if (r.confirmed) setStatus.mutate({ status: 'suspended', reason: r.reason });
      },
    },
    { label: 'Reactivate organization', icon: <RotateCcw className="size-4" />, hidden: !manage || org.status !== 'suspended', onSelect: () => setStatus.mutate({ status: 'active' }) },
    {
      label: 'Delete organization',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !can('customers.organizations.delete'),
      onSelect: async () => {
        const r = await confirm({ title: `Delete ${org.name}?`, description: 'The organization is removed and every membership is deleted. User accounts are kept. This cannot be undone from the console.', tone: 'danger', confirmLabel: 'Delete organization', typeToConfirm: org.slug });
        if (r.confirmed) remove.mutate();
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', to: '/customers/organizations' }, { label: org.name }]}
        documentTitle={org.name}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-ui bg-primary/10 text-lg font-semibold text-primary" aria-hidden="true">
              {org.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate">{org.name}</span>
              <span className="flex items-center gap-1 text-md font-normal text-muted-foreground">
                <span className="truncate font-mono">{org.slug}</span>
                <CopyButton value={org.id} label="Copy organization ID" />
              </span>
            </span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={org.status} />
            <Badge>
              {num(activeMembers)} member{activeMembers === 1 ? '' : 's'}
              {org.seat_limit ? ` / ${num(org.seat_limit)} seats` : ''}
            </Badge>
            {org.tags.slice(0, 4).map((t) => (
              <Badge key={t} tone="primary">
                {t}
              </Badge>
            ))}
          </>
        }
        actions={
          <>
            {manage && (
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {actions.some((a) => !a.hidden && !a.separator) && (
              <Menu
                trigger={
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
                items={actions}
              />
            )}
          </>
        }
      />
      {org.status === 'suspended' && (
        <div className="mb-4">
          <Callout tone="warning" title="This organization is suspended">
            Members cannot use it until it is reactivated. See the Activity tab for the reason.
          </Callout>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview', content: <OverviewTab org={org} /> },
          { value: 'members', label: 'Members', count: org.members.length + org.invitations.length, content: <MembersTab org={org} /> },
          { value: 'billing', label: 'Billing', hidden: !org.panels.billing, content: org.panels.billing && <BillingTab org={org} /> },
          { value: 'usage', label: 'Usage & credits', hidden: !can('usage.meters.view'), content: tab === 'usage' && <UsageTab org={org} /> },
          { value: 'access', label: 'Plan & access', hidden: !can('catalog.entitlements.view'), content: tab === 'access' && <EntitlementsPanel subject={{ orgId: org.id }} /> },
          { value: 'support', label: 'Support', hidden: !can('support.tickets.view'), content: tab === 'support' && <SupportTab org={org} /> },
          { value: 'activity', label: 'Activity', hidden: !can('security.audit.view'), content: tab === 'activity' && <ActivityTab org={org} /> },
        ]}
      />
      {editing && <EditOrganizationDialog org={org} open={editing} onOpenChange={setEditing} />}
      {adding && <AddMemberDialog org={org} open={adding} onOpenChange={setAdding} />}
      {inviting && <InviteDialog org={org} open={inviting} onOpenChange={setInviting} />}
    </>
  );
}
