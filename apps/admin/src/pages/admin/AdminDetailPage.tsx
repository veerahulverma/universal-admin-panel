import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Laptop, LockOpen, LogOut, MoreHorizontal, Pencil, Power, ShieldCheck, ShieldOff, Smartphone, Trash2, UserCog } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Menu,
  Modal,
  Mono,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  Tabs,
  Textarea,
  When,
  useConfirm,
  type MenuItem,
} from '../../components/ui';
import { IpCaveat, OrgScopeField, OrgScopeSummary, RolePicker, describeAgent, groupByNamespace, namespaceLabel, targetHref, usePermissionCatalog, useRoles } from './shared';
import type { AdminDetail } from './types';

function EditAdminDialog({ admin, self, open, onOpenChange }: { admin: AdminDetail; self: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = useAuth();
  const roles = useRoles(can('iam.roles.view'));
  const catalog = usePermissionCatalog(can('iam.roles.view'));
  const [name, setName] = useState(admin.name);
  const [roleIds, setRoleIds] = useState(admin.roles.map((r) => r.id));
  const [orgScope, setOrgScope] = useState<string[] | null>(admin.org_scope);
  const [allowedIps, setAllowedIps] = useState(admin.allowed_ips.join('\n'));
  const [error, setError] = useState<string | null>(null);

  const save = useAction(
    () => {
      const ips = allowedIps.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const sameRoles = roleIds.length === admin.roles.length && roleIds.every((id) => admin.roles.some((r) => r.id === id));
      return api.patch(`/api/admin/team/${admin.id}`, {
        name: name.trim() || undefined,
        // The server refuses role changes on your own account; only send what changed.
        roleIds: self || sameRoles ? undefined : roleIds,
        orgScope,
        allowedIps: ips,
      });
    },
    { success: 'Administrator updated', invalidate: [['team-admin', admin.id], ['team']], onSuccess: () => onOpenChange(false), onError: (err) => setError(errorMessage(err)) },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${admin.name}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-admin" loading={save.isPending} disabled={!self && !roleIds.length}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-admin"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="ea-name">
          <Input id="ea-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Roles" hint={self ? 'You cannot change your own roles; ask another administrator.' : 'You can only grant roles whose permissions you hold yourself.'} required={!self}>
          {roles.data ? (
            <RolePicker roles={roles.data.data} catalog={catalog.data?.data} value={roleIds} onChange={setRoleIds} disabled={self} />
          ) : (
            <p className="text-sm text-muted-foreground">{admin.roles.map((r) => r.name).join(', ') || 'No roles'}</p>
          )}
        </Field>
        <OrgScopeField value={orgScope} onChange={setOrgScope} />
        <Field label="Allowed sign-in networks" htmlFor="ea-ips" hint="Optional. One IP address or CIDR range per line (for example 203.0.113.0/24). Leave empty to allow any network. Use with care: home and mobile IPs change.">
          <Textarea id="ea-ips" rows={3} className="font-mono text-xs" value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="203.0.113.0/24" />
        </Field>
      </form>
    </Modal>
  );
}

function PermissionsTab({ admin }: { admin: AdminDetail }) {
  const { can } = useAuth();
  const catalog = usePermissionCatalog(can('iam.roles.view'));
  const defs = useMemo(() => {
    const byKey = new Map((catalog.data?.data ?? []).map((d) => [d.key, d]));
    return admin.permissions.map((key) => byKey.get(key) ?? { key, label: key, module: key.split('.')[0] });
  }, [admin.permissions, catalog.data]);
  if (!defs.length) return <EmptyState icon={<KeyRound />} title="No permissions" description="This administrator has no roles, so they cannot do anything in the console." />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Effective permissions from {admin.roles.map((r) => r.name).join(', ')}. Change them by editing the roles{can('iam.roles.view') && <> under <Link className="text-primary hover:underline" to="/admin/roles">Roles</Link></>}.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {groupByNamespace(defs).map((g) => (
          <Card key={g.ns} title={namespaceLabel(g.ns)} description={`${g.items.length} permission${g.items.length === 1 ? '' : 's'}`}>
            <ul className="space-y-1.5">
              {g.items.map((d) => (
                <li key={d.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{d.label}</span>
                  <code className="font-mono text-xs text-muted-foreground">{d.key}</code>
                  {'dangerous' in d && d.dangerous && <Badge tone="warning">sensitive</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SessionsTab({ admin, self }: { admin: AdminDetail; self: boolean }) {
  const { can, me } = useAuth();
  const confirm = useConfirm();
  const revoke = useAction((id: string) => api.delete(`/api/admin/team/sessions/${id}`), { success: 'Session signed out', invalidate: [['team-admin', admin.id], ['team-sessions']] });
  if (!admin.sessions.length) return <EmptyState icon={<Laptop />} title="No active sessions" />;
  return (
    <Card padded={false} title="Active sessions" description={<IpCaveat />}>
      <ul className="divide-y">
        {admin.sessions.map((s) => {
          const current = self && s.id === me?.session.id;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {s.client === 'mobile' ? <Smartphone className="size-5 text-muted-foreground" aria-hidden="true" /> : <Laptop className="size-5 text-muted-foreground" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {s.client === 'mobile' ? 'Mobile app' : describeAgent(s.user_agent)}
                  {current && <Badge tone="success">this session</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{s.ip ?? 'unknown IP'}</span> · signed in {dateTime(s.created_at)} · active <When value={s.last_seen_at} /> · expires {dateTime(s.expires_at)}
                </p>
              </div>
              {can('iam.admins.manage') && !current && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={revoke.isPending && revoke.variables === s.id}
                  onClick={async () => {
                    const { confirmed } = await confirm({ title: 'Sign out this session?', description: `${admin.name} will have to sign in again on that device.`, confirmLabel: 'Sign out' });
                    if (confirmed) revoke.mutate(s.id);
                  }}
                >
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ActivityTab({ admin }: { admin: AdminDetail }) {
  const { can } = useAuth();
  if (!admin.activity.length) return <EmptyState title="No recorded actions yet" />;
  return (
    <Card
      padded={false}
      title="Recent actions"
      description="The 25 most recent audit log entries by this administrator"
      actions={can('security.audit.view') && <ButtonLink to={`/admin/audit?actorType=admin&actorId=${admin.id}`} size="sm">Full history</ButtonLink>}
    >
      <ul className="divide-y">
        {admin.activity.map((a) => {
          const href = targetHref(a.target_type, a.target_id);
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{a.action}</code>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {a.target_type && (href ? <Link className="text-primary hover:underline" to={href}>{a.target_type} {a.target_id}</Link> : `${a.target_type} ${a.target_id ?? ''}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                <When value={a.created_at} />
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default function AdminDetailPage() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['team-admin', id], queryFn: () => api.get<AdminDetail>(`/api/admin/team/${id}`) });
  const invalidate = [['team-admin', id], ['team']];

  const patch = useAction((body: { status?: 'active' | 'disabled'; unlock?: boolean }) => api.patch(`/api/admin/team/${id}`, body), {
    success: (_r, v) => (v.unlock ? 'Account unlocked' : v.status === 'disabled' ? 'Administrator disabled and signed out' : 'Administrator enabled'),
    invalidate,
  });
  const reset2fa = useAction(() => api.post(`/api/admin/team/${id}/reset-2fa`), { success: 'Two-factor authentication reset. They must enroll again at next sign-in.', invalidate });
  const revokeAll = useAction(() => api.post<{ revoked: number }>(`/api/admin/team/${id}/revoke-sessions`), { success: (r) => `${r.revoked} session(s) signed out`, invalidate });
  const remove = useAction(() => api.delete(`/api/admin/team/${id}`), {
    success: 'Administrator removed. Their audit history is kept.',
    invalidate,
    onSuccess: () => navigate('/admin/team'),
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const self = a.id === me?.admin.id;
  const locked = Boolean(a.locked_until && new Date(a.locked_until) > new Date());
  // Editing someone who holds permissions you lack is refused by the server (privilege escalation guard).
  const missing = a.permissions.filter((p) => !(me?.permissions ?? []).includes(p));
  const outranked = !self && missing.length > 0;
  const manage = can('iam.admins.manage') && !outranked;

  const actions: MenuItem[] = [
    { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(true), hidden: !manage },
    { label: 'Unlock sign-in', icon: <LockOpen className="size-4" />, hidden: !manage || !locked, onSelect: () => patch.mutate({ unlock: true }) },
    {
      label: 'Sign out everywhere',
      icon: <LogOut className="size-4" />,
      hidden: !can('iam.admins.manage') || self || a.sessions.length === 0,
      onSelect: async () => {
        if ((await confirm({ title: `Sign ${a.name} out of every session?`, confirmLabel: 'Sign out' })).confirmed) revokeAll.mutate();
      },
    },
    {
      label: 'Reset two-factor authentication',
      icon: <ShieldOff className="size-4" />,
      hidden: !manage || self || !a.totp_enabled,
      onSelect: async () => {
        const r = await confirm({
          title: `Reset 2FA for ${a.name}?`,
          description: 'Use this when they lost their authenticator and recovery codes. Their sessions end and they must set up 2FA again. A security event is recorded.',
          confirmLabel: 'Reset 2FA',
          tone: 'danger',
        });
        if (r.confirmed) reset2fa.mutate();
      },
    },
    { separator: true, label: '', hidden: !manage || self },
    {
      label: a.status === 'active' ? 'Disable account' : 'Enable account',
      icon: <Power className="size-4" />,
      danger: a.status === 'active',
      hidden: !manage || self,
      onSelect: async () => {
        if (a.status === 'active') {
          const r = await confirm({ title: `Disable ${a.name}?`, description: 'They are signed out everywhere and cannot sign in until re-enabled. The last active super administrator cannot be disabled.', confirmLabel: 'Disable', tone: 'danger' });
          if (r.confirmed) patch.mutate({ status: 'disabled' });
        } else patch.mutate({ status: 'active' });
      },
    },
    {
      label: 'Remove administrator',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !can('iam.admins.delete') || self || outranked,
      onSelect: async () => {
        const r = await confirm({
          title: `Remove ${a.name}?`,
          description: 'The account is disabled and all roles are removed. Their audit history is kept. To give access again, send a new invitation.',
          confirmLabel: 'Remove',
          tone: 'danger',
          typeToConfirm: 'REMOVE',
        });
        if (r.confirmed) remove.mutate();
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Team', to: '/admin/team' }, { label: a.name }]}
        documentTitle={a.name}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={a.name} email={a.email} size="lg" />
            <span className="min-w-0">
              <span className="block truncate">{a.name}</span>
              <span className="block truncate text-md font-normal text-muted-foreground">{a.email}</span>
            </span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={a.status} />
            {locked && <Badge tone="danger">locked until {dateTime(a.locked_until)}</Badge>}
            {a.totp_enabled ? <Badge tone="success">2FA on</Badge> : <Badge tone="warning">2FA off</Badge>}
            {a.roles.map((r) => (
              <Badge key={r.id} tone={r.key === 'super_admin' ? 'primary' : 'neutral'}>
                {r.name}
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
            {actions.some((x) => !x.hidden && !x.separator) && (
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
      <div className="mb-4 space-y-3">
        {self && (
          <Callout title="This is your account" action={<ButtonLink to="/account" size="sm" icon={<UserCog className="size-4" />}>Account & security</ButtonLink>}>
            Change your password, two-factor authentication and devices from your account page. Another administrator must change your roles.
          </Callout>
        )}
        {outranked && can('iam.admins.manage') && (
          <Callout tone="warning" title="View only">
            {a.name} holds {missing.length} permission{missing.length === 1 ? '' : 's'} you do not have, so you cannot change this account.
          </Callout>
        )}
        {!a.totp_enabled && a.status === 'active' && !self && (
          <Callout tone="warning" title="Two-factor authentication is off">
            This account is protected by a password only. Ask {a.name} to enable 2FA, or require it for all administrators in the sign-in settings.
          </Callout>
        )}
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            value: 'overview',
            label: 'Overview',
            content: (
              <div className="grid gap-4 lg:grid-cols-3">
                <Card title="Account" className="lg:col-span-2">
                  <KeyValue
                    items={[
                      { label: 'Email', value: a.email },
                      { label: 'Administrator ID', value: <Mono copy>{a.id}</Mono> },
                      { label: 'Status', value: <StatusBadge status={a.status} /> },
                      { label: 'Two-factor authentication', value: a.totp_enabled ? <span className="inline-flex items-center gap-1 text-success"><ShieldCheck className="size-4" /> Enabled</span> : 'Not enabled' },
                      { label: 'Last sign-in', value: a.last_login_at ? `${dateTime(a.last_login_at)}${a.last_login_ip ? ` from ${a.last_login_ip}` : ''}` : 'Never' },
                      { label: 'Password changed', value: a.password_changed_at ? dateTime(a.password_changed_at) : null },
                      { label: 'Member since', value: dateTime(a.created_at) },
                      { label: 'Sign-in lock', value: locked ? `Locked until ${dateTime(a.locked_until)} after repeated failures` : 'Not locked' },
                    ]}
                  />
                </Card>
                <div className="space-y-4">
                  <Card title="Data access">
                    <OrgScopeSummary scope={a.org_scope} />
                  </Card>
                  <Card title="Allowed sign-in networks">
                    {a.allowed_ips.length ? (
                      <ul className="space-y-1 font-mono text-xs">
                        {a.allowed_ips.map((ip) => (
                          <li key={ip}>{ip}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">Any network</p>
                    )}
                  </Card>
                </div>
              </div>
            ),
          },
          { value: 'permissions', label: 'Permissions', count: a.permissions.length, content: <PermissionsTab admin={a} /> },
          { value: 'sessions', label: 'Sessions', count: a.sessions.length, content: <SessionsTab admin={a} self={self} /> },
          { value: 'activity', label: 'Activity', content: <ActivityTab admin={a} /> },
        ]}
      />
      {editing && <EditAdminDialog admin={a} self={self} open={editing} onOpenChange={setEditing} />}
    </>
  );
}
