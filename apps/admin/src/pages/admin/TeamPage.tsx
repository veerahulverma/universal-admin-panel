import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MailPlus, MoreHorizontal, RotateCw, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Menu,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  Toolbar,
  When,
  useConfirm,
  type Column,
} from '../../components/ui';
import { OrgScopeField, OrgScopeSummary, RolePicker, usePermissionCatalog, useRoles } from './shared';
import type { AdminRow, Invitation, InviteResult, Role } from './types';

const DEFAULTS = { tab: 'admins', status: '', q: '', sort: 'name', order: 'asc' };

function isLocked(a: { locked_until: string | null }): boolean {
  return Boolean(a.locked_until && new Date(a.locked_until) > new Date());
}

export function InviteResultView({ result }: { result: InviteResult }) {
  return (
    <div className="space-y-3">
      {result.emailed ? (
        <Callout tone="success" title={`Invitation emailed to ${result.email}`}>
          The link expires {dateTime(result.expiresAt)}. You can also share it directly:
        </Callout>
      ) : (
        <Callout tone="warning" title="Email is not configured">
          No email was sent. Share this one-time link with {result.email} over a trusted channel. It expires {dateTime(result.expiresAt)}.
        </Callout>
      )}
      <CodeBlock code={result.inviteLink} />
      <p className="text-xs text-muted-foreground">Anyone with this link can create the administrator account, so treat it like a password. It is shown only now.</p>
    </div>
  );
}

function InviteDialog({ open, onOpenChange, roles, initial }: { open: boolean; onOpenChange: (o: boolean) => void; roles: Role[] | undefined; initial?: { email: string; roleIds: string[]; orgScope: string[] | null; replaces?: string } }) {
  const catalog = usePermissionCatalog();
  const [email, setEmail] = useState(initial?.email ?? '');
  const [roleIds, setRoleIds] = useState<string[]>(initial?.roleIds ?? []);
  const [orgScope, setOrgScope] = useState<string[] | null>(initial?.orgScope ?? null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  const invite = useAction(
    async () => {
      const res = await api.post<InviteResult>('/api/admin/team/invitations', { email, roleIds, orgScope });
      // Resending replaces the old invitation so only the newest link works.
      if (initial?.replaces) await api.delete(`/api/admin/team/invitations/${initial.replaces}`).catch(() => undefined);
      return res;
    },
    {
      success: initial?.replaces ? 'New invitation created' : 'Invitation created',
      invalidate: [['team-invitations']],
      onSuccess: setResult,
      onError: (err) => setError(errorMessage(err)),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.replaces ? `Resend invitation to ${initial.email}` : 'Invite an administrator'}
      description={result ? undefined : 'They choose their own name and password when accepting. Invitations expire after 7 days.'}
      size="lg"
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="invite-admin" loading={invite.isPending} disabled={!roleIds.length}>
              {initial?.replaces ? 'Send new invitation' : 'Send invitation'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <InviteResultView result={result} />
      ) : (
        <form
          id="invite-admin"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            invite.mutate();
          }}
        >
          <FormError message={error} />
          <Field label="Email" htmlFor="invite-email" required>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!initial} readOnly={Boolean(initial?.replaces)} />
          </Field>
          <Field label="Roles" hint="Permissions combine across roles. You can only grant roles whose permissions you hold yourself." required>
            {roles ? <RolePicker roles={roles} catalog={catalog.data?.data} value={roleIds} onChange={setRoleIds} /> : <Callout tone="warning">You need permission to view roles before you can invite administrators.</Callout>}
          </Field>
          <OrgScopeField value={orgScope} onChange={setOrgScope} />
        </form>
      )}
    </Modal>
  );
}

function InvitationsTab({ roles, onResend }: { roles: Role[] | undefined; onResend: (inv: Invitation) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const invitations = useQuery({ queryKey: ['team-invitations'], queryFn: () => api.get<{ data: Invitation[] }>('/api/admin/team/invitations') });
  const revoke = useAction((id: string) => api.delete(`/api/admin/team/invitations/${id}`), { success: 'Invitation revoked', invalidate: [['team-invitations']] });
  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? id;

  if (invitations.error) return <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} />;
  const columns: Column<Invitation>[] = [
    { key: 'email', header: 'Email', cell: (i) => <span className="font-medium">{i.email}</span> },
    { key: 'roles', header: 'Roles', cell: (i) => <span className="flex flex-wrap gap-1">{i.role_ids.map((id) => <Badge key={id}>{roleName(id)}</Badge>)}</span> },
    { key: 'scope', header: 'Data access', cell: (i) => <OrgScopeSummary scope={i.org_scope} /> },
    { key: 'invited', header: 'Invited', priority: 'low', cell: (i) => <span>{i.invited_by_name ?? 'Unknown'} · <When value={i.created_at} /></span> },
    { key: 'expires', header: 'Expires', cell: (i) => <When value={i.expires_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        can('iam.admins.manage') ? (
          <span className="inline-flex gap-1">
            <Button size="sm" variant="outline" icon={<RotateCw className="size-3.5" />} onClick={() => onResend(i)}>
              Resend
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              aria-label={`Revoke invitation for ${i.email}`}
              loading={revoke.isPending && revoke.variables === i.id}
              onClick={async () => {
                const { confirmed } = await confirm({ title: `Revoke the invitation for ${i.email}?`, description: 'The link stops working immediately.', confirmLabel: 'Revoke', tone: 'danger' });
                if (confirmed) revoke.mutate(i.id);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <Card padded={false}>
      <DataTable
        caption="Pending invitations"
        columns={columns}
        rows={invitations.data?.data}
        rowKey={(i) => i.id}
        loading={invitations.isLoading}
        empty={<EmptyState icon={<MailPlus />} title="No pending invitations" description="Invitations you send appear here until they are accepted, revoked or expire." />}
      />
    </Card>
  );
}

export default function TeamPage() {
  const { can, me } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(DEFAULTS);
  const [inviting, setInviting] = useState<null | { email: string; roleIds: string[]; orgScope: string[] | null; replaces?: string }>(null);
  const roles = useRoles(can('iam.roles.view'));
  const team = useQuery({
    queryKey: ['team', state.status],
    queryFn: () => api.get<{ data: AdminRow[] }>('/api/admin/team', { status: state.status || undefined }),
    placeholderData: keepPreviousData,
  });
  const invitations = useQuery({ queryKey: ['team-invitations'], queryFn: () => api.get<{ data: Invitation[] }>('/api/admin/team/invitations') });
  const revokeSessions = useAction((id: string) => api.post<{ revoked: number }>(`/api/admin/team/${id}/revoke-sessions`), { success: (r) => `${r.revoked} session(s) signed out`, invalidate: [['team']] });

  const q = String(state.q ?? '').trim().toLowerCase();
  const rows = useMemo(() => {
    const list = (team.data?.data ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q) || a.roles.some((r) => r.name.toLowerCase().includes(q)));
    const dir = state.order === 'desc' ? -1 : 1;
    const key = String(state.sort);
    const val = (a: AdminRow) => (key === 'last_login_at' ? a.last_login_at ?? '' : key === 'created_at' ? a.created_at : a.name.toLowerCase());
    return [...list].sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : 0));
  }, [team.data, q, state.sort, state.order]);

  const total = team.data?.data.length ?? 0;
  const without2fa = (team.data?.data ?? []).filter((a) => a.status === 'active' && !a.totp_enabled).length;

  const columns: Column<AdminRow>[] = [
    {
      key: 'name',
      header: 'Administrator',
      sortable: true,
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={a.name} email={a.email} size="sm" />
          <span className="min-w-0">
            <span className="block truncate">
              {a.name}
              {a.id === me?.admin.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
            </span>
            <span className="block truncate text-xs font-normal text-muted-foreground">{a.email}</span>
          </span>
        </span>
      ),
    },
    { key: 'roles', header: 'Roles', cell: (a) => (a.roles.length ? <span className="flex flex-wrap gap-1">{a.roles.map((r) => <Badge key={r.id} tone={r.key === 'super_admin' ? 'primary' : 'neutral'}>{r.name}</Badge>)}</span> : <span className="text-muted-foreground">No roles</span>) },
    {
      key: 'status',
      header: 'Status',
      cell: (a) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge status={a.status} />
          {isLocked(a) && <Badge tone="danger">locked</Badge>}
          {a.org_scope && <Badge tone="info">{a.org_scope.length} org{a.org_scope.length === 1 ? '' : 's'}</Badge>}
        </span>
      ),
    },
    {
      key: '2fa',
      header: '2FA',
      cell: (a) =>
        a.totp_enabled ? (
          <span className="inline-flex items-center gap-1 text-success">
            <ShieldCheck className="size-4" aria-hidden="true" /> On
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-warning">
            <ShieldOff className="size-4" aria-hidden="true" /> Off
          </span>
        ),
    },
    { key: 'last_login_at', header: 'Last sign-in', sortable: true, cell: (a) => (a.last_login_at ? <span><When value={a.last_login_at} />{a.last_login_ip && <span className="block font-mono text-xs text-muted-foreground">{a.last_login_ip}</span>}</span> : <span className="text-muted-foreground">Never</span>) },
    { key: 'sessions', header: 'Sessions', align: 'right', priority: 'low', cell: (a) => <span className="tabular">{a.active_sessions}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (a) =>
        can('iam.admins.manage') && a.id !== me?.admin.id && a.active_sessions > 0 ? (
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.name}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            }
            items={[
              {
                label: 'Sign out everywhere',
                onSelect: async () => {
                  const { confirmed } = await confirm({ title: `Sign ${a.name} out of every session?`, description: `${a.active_sessions} active session(s) end immediately.`, confirmLabel: 'Sign out' });
                  if (confirmed) revokeSessions.mutate(a.id);
                },
              },
            ]}
          />
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Team"
        description="Administrators who can sign in to this console, their roles, data access and sign-in security."
        actions={
          can('iam.admins.manage') && (
            <Button icon={<MailPlus className="size-4" />} onClick={() => setInviting({ email: '', roleIds: [], orgScope: null })}>
              Invite administrator
            </Button>
          )
        }
      />
      {without2fa > 0 && (
        <div className="mb-4">
          <Callout tone="warning" title={`${without2fa} active administrator${without2fa === 1 ? ' has' : 's have'} no two-factor authentication`}>
            Require it for everyone under Platform → Settings → Admin sign-in & sessions.
          </Callout>
        </div>
      )}
      <Tabs
        value={String(state.tab)}
        onValueChange={(tab) => setState({ tab })}
        tabs={[
          {
            value: 'admins',
            label: 'Administrators',
            count: total || undefined,
            content: (
              <Card padded={false}>
                <Toolbar>
                  <SearchInput value={String(state.q ?? '')} onChange={(v) => setState({ q: v })} placeholder="Search name, email or role…" className="w-full sm:w-72" />
                  <Select
                    aria-label="Status"
                    className="w-auto"
                    value={String(state.status)}
                    onChange={(e) => setState({ status: e.target.value })}
                    placeholder="Any status"
                    options={[
                      { value: 'active', label: 'Active' },
                      { value: 'disabled', label: 'Disabled' },
                    ]}
                  />
                </Toolbar>
                {team.error ? (
                  <ErrorState error={team.error} onRetry={() => void team.refetch()} />
                ) : (
                  <DataTable
                    caption="Administrators"
                    columns={columns}
                    rows={rows}
                    rowKey={(a) => a.id}
                    rowHref={(a) => `/admin/team/${a.id}`}
                    loading={team.isLoading}
                    fetching={team.isFetching && !team.isLoading}
                    sort={String(state.sort)}
                    order={state.order as 'asc' | 'desc'}
                    onSort={(sort, order) => setState({ sort, order })}
                    empty={<EmptyState title={q || state.status ? 'No administrators match' : 'No administrators'} />}
                  />
                )}
              </Card>
            ),
          },
          {
            value: 'invitations',
            label: 'Invitations',
            count: invitations.data?.data.length || undefined,
            content: <InvitationsTab roles={roles.data?.data} onResend={(inv) => setInviting({ email: inv.email, roleIds: inv.role_ids, orgScope: inv.org_scope, replaces: inv.id })} />,
          },
        ]}
      />
      {inviting && <InviteDialog open onOpenChange={(o) => !o && setInviting(null)} roles={roles.data?.data} initial={inviting.email ? inviting : undefined} />}
    </>
  );
}
