import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { History, Megaphone, RefreshCw, Trash2, UserMinus, UserPlus, Users } from 'lucide-react';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { dateTime, num } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KpiTile,
  Modal,
  PageHeader,
  PageSkeleton,
  Pagination,
  SearchInput,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Tone,
} from '../../components/ui';
import { UserPicker, type PickedUser } from '../customers/shared';
import { BLOCK_LABEL, ProductChecklist, SOURCE_LABEL, type ListDetail, type ListProvider } from './shared';

interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  status: 'pending' | 'subscribed' | 'unsubscribed';
  source: string;
  consented_at: string | null;
  subscribed_at: string | null;
  unsubscribed_at: string | null;
  confirmation_sent_at: string | null;
  created_at: string;
  blocked_reason: string | null;
}

interface ConsentRecord {
  id: string;
  action: 'requested' | 'subscribed' | 'unsubscribed';
  source: string;
  ip: string | null;
  user_agent: string | null;
  actor: string | null;
  email: string;
  created_at: string;
}

const ACTION_LABEL: Record<ConsentRecord['action'], string> = { requested: 'Asked to join (confirmation sent)', subscribed: 'Subscribed', unsubscribed: 'Unsubscribed' };
const MEMBER_TONE: Record<MemberRow['status'], Tone> = { subscribed: 'success', pending: 'info', unsubscribed: 'neutral' };

function HistoryDialog({ listId, member, onClose }: { listId: string; member: MemberRow; onClose: () => void }) {
  const history = useQuery({ queryKey: ['list-member-history', listId, member.user_id], queryFn: () => api.get<{ data: ConsentRecord[] }>(`/api/admin/lists/${listId}/members/${member.user_id}/history`) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Consent record: ${member.name || member.email}`} description="Every request, subscription and unsubscription for this list, newest first, with where it came from." size="lg">
      {history.isLoading ? (
        <PageSkeleton />
      ) : history.error ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : (
        <ol className="space-y-2">
          {(history.data?.data ?? []).map((h) => (
            <li key={h.id} className="rounded-ui-sm border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{ACTION_LABEL[h.action]}</span>
                <span className="text-xs text-muted-foreground">{dateTime(h.created_at)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {SOURCE_LABEL[h.source] ?? h.source} · {h.email}
                {h.ip && ` · IP ${h.ip}`}
              </p>
              {h.user_agent && <p className="truncate text-xs text-muted-foreground">{h.user_agent}</p>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function AddMembersDialog({ list, onClose }: { list: ListDetail; onClose: () => void }) {
  const toast = useToast();
  const [user, setUser] = useState<PickedUser | null>(null);
  const [confirmByEmail, setConfirmByEmail] = useState(list.double_opt_in);
  const add = useAction(() => api.post<{ results: { userId: string; status?: string; error?: string }[]; added: number }>(`/api/admin/lists/${list.id}/members`, { userIds: [user!.id], confirm: confirmByEmail }), {
    invalidate: [['list-members', list.id], ['mailing-list', list.id], ['mailing-lists']],
    onSuccess: (r) => {
      const result = r.results[0];
      if (result?.error) toast.error('Not added', result.error);
      else toast.success(result?.status === 'pending' ? 'Confirmation email sent' : 'Added to the list');
      setUser(null);
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Add to ${list.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!user}>
            {confirmByEmail ? 'Send confirmation' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Customer" htmlFor="am-user">
          <UserPicker id="am-user" value={user} onChange={setUser} />
        </Field>
        <Checkbox
          checked={confirmByEmail}
          disabled={list.double_opt_in}
          onChange={(e) => setConfirmByEmail(e.target.checked)}
          label="Ask them to confirm by email"
          description={list.double_opt_in ? 'This list uses double opt-in, so everyone confirms.' : 'Their click is recorded as consent. Without it, people you add only receive list email if they consented to marketing.'}
        />
        <p className="text-xs text-muted-foreground">People who unsubscribed from this list can only join again themselves.</p>
      </div>
    </Modal>
  );
}

const MEMBER_DEFAULTS = { status: 'subscribed', source: '' };

function MembersTab({ list }: { list: ListDetail }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('marketing.lists.manage');
  const [filters, setFilters] = useState(MEMBER_DEFAULTS);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<MemberRow | null>(null);
  const members = useQuery({
    queryKey: ['list-members', list.id, filters, q, page],
    queryFn: () => api.get<Page<MemberRow>>(`/api/admin/lists/${list.id}/members`, { ...filters, q, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const remove = useAction((userId: string) => api.delete(`/api/admin/lists/${list.id}/members/${userId}`), {
    success: 'Unsubscribed from the list',
    invalidate: [['list-members', list.id], ['mailing-list', list.id], ['mailing-lists']],
  });
  const setFilter = (patch: Partial<typeof MEMBER_DEFAULTS>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  return (
    <Card
      padded={false}
      actions={
        manage && (
          <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            Add people
          </Button>
        )
      }
      title="Members"
      description="Whether list email reaches each person depends on their consent and opt-outs, checked again for every email."
    >
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or email…" className="w-full sm:w-64" />
        <Select
          aria-label="Status"
          className="w-auto"
          value={filters.status}
          onChange={(e) => setFilter({ status: e.target.value })}
          placeholder="Any status"
          options={[
            { value: 'subscribed', label: 'Subscribed' },
            { value: 'pending', label: 'Waiting for confirmation' },
            { value: 'unsubscribed', label: 'Unsubscribed' },
          ]}
        />
        <Select aria-label="How they joined" className="w-auto" value={filters.source} onChange={(e) => setFilter({ source: e.target.value })} placeholder="Any source" options={Object.entries(SOURCE_LABEL).filter(([k]) => k !== 'unsubscribe_link').map(([value, label]) => ({ value, label }))} />
      </Toolbar>
      {members.error ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <DataTable
          caption="List members"
          rows={members.data?.data}
          loading={members.isLoading}
          fetching={members.isFetching && !members.isLoading}
          rowKey={(m) => m.user_id}
          empty={<EmptyState icon={<Users />} title="Nobody here" description={filters.status === 'subscribed' ? 'Add people, let customers join from your app, or set a product rule.' : undefined} />}
          columns={[
            {
              key: 'person',
              header: 'Person',
              cell: (m) => (
                <Link to={`/customers/users/${m.user_id}`} className="flex min-w-0 items-center gap-2.5 hover:underline">
                  <Avatar name={m.name} email={m.email} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate">{m.name || m.email}</span>
                    {m.name && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                  </span>
                </Link>
              ),
            },
            { key: 'status', header: 'Status', cell: (m) => <Badge tone={MEMBER_TONE[m.status]} dot>{m.status}</Badge> },
            { key: 'source', header: 'Joined by', cell: (m) => SOURCE_LABEL[m.source] ?? m.source },
            {
              key: 'consent',
              header: 'Consent',
              priority: 'low',
              cell: (m) => (m.consented_at ? <span title={dateTime(m.consented_at)}>Opted in <When value={m.consented_at} /></span> : <span className="text-muted-foreground">General marketing consent only</span>),
            },
            {
              key: 'reach',
              header: 'List email',
              cell: (m) => (m.status !== 'subscribed' ? <span className="text-muted-foreground">—</span> : m.blocked_reason ? <Badge tone="warning">{BLOCK_LABEL[m.blocked_reason] ?? m.blocked_reason}</Badge> : <Badge tone="success">Receives it</Badge>),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (m) => (
                <span className="inline-flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Consent record for ${m.email}`} onClick={() => setHistory(m)}>
                    <History className="size-4" />
                  </Button>
                  {manage && m.status !== 'unsubscribed' && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Unsubscribe ${m.email}`}
                      onClick={async () => {
                        const r = await confirm({ title: `Unsubscribe ${m.email}?`, description: 'This is recorded. A product rule will not add them back; only they can join again.', tone: 'danger', confirmLabel: 'Unsubscribe' });
                        if (r.confirmed) remove.mutate(m.user_id);
                      }}
                    >
                      <UserMinus className="size-4" />
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
      {members.data && <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPage={setPage} />}
      {adding && <AddMembersDialog list={list} onClose={() => setAdding(false)} />}
      {history && <HistoryDialog listId={list.id} member={history} onClose={() => setHistory(null)} />}
    </Card>
  );
}

function SettingsTab({ list }: { list: ListDetail }) {
  const { can } = useAuth();
  const editable = can('marketing.lists.manage');
  const providers = useQuery({ queryKey: ['list-providers'], queryFn: () => api.get<{ data: ListProvider[] }>('/api/admin/lists/providers'), staleTime: 60_000 });
  const [form, setForm] = useState({
    name: list.name,
    key: list.key,
    description: list.description,
    visibility: list.visibility as string,
    doubleOptIn: list.double_opt_in,
    autoProductIds: list.auto_product_ids,
    externalProvider: list.external_provider ?? '',
    externalRef: list.external_ref ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch(`/api/admin/lists/${list.id}`, {
        ...form,
        externalProvider: form.externalProvider || null,
        externalRef: form.externalProvider ? form.externalRef || null : null,
      }),
    {
      success: 'List saved',
      invalidate: [['mailing-list', list.id], ['mailing-lists']],
      onSuccess: () => {
        setErrors({});
        setError(null);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const connected = (providers.data?.data ?? []).filter((p) => p.connected || p.id === list.external_provider);
  return (
    <form
      className="grid gap-4 lg:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card
        title="List"
        actions={
          editable && (
            <Button type="submit" size="sm" loading={save.isPending}>
              Save changes
            </Button>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FormError message={error} />
          </div>
          <Field label="Name" htmlFor="ls-name" error={errors.name} required>
            <Input id="ls-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!editable} maxLength={120} required />
          </Field>
          <Field label="Key" htmlFor="ls-key" error={errors.key} hint="Used by your application; changing it breaks code that uses the old key">
            <Input id="ls-key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} disabled={!editable} maxLength={64} className="font-mono" />
          </Field>
          <Field label="Description" htmlFor="ls-desc" className="sm:col-span-2">
            <Textarea id="ls-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!editable} maxLength={1000} />
          </Field>
          <Field label="Visibility" htmlFor="ls-visibility">
            <Select id="ls-visibility" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} disabled={!editable} options={[{ value: 'public', label: 'Public: customers can join' }, { value: 'hidden', label: 'Hidden: managed by you' }]} />
          </Field>
          <div className="flex items-end pb-1">
            <Checkbox checked={form.doubleOptIn} disabled={!editable} onChange={(e) => setForm({ ...form, doubleOptIn: e.target.checked })} label="Double opt-in" description="New subscribers confirm by email first" />
          </div>
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Product rule" description="People who have any of these products (directly or through their organization) join automatically and leave when access ends. People who unsubscribed are never added back.">
          <Field error={errors.autoProductIds}>
            <ProductChecklist value={form.autoProductIds} onChange={(ids) => setForm({ ...form, autoProductIds: ids })} disabled={!editable} label="Products that put people on this list" />
          </Field>
        </Card>
        <Card title="External newsletter service">
          {connected.length === 0 ? (
            <Callout title="Not connected">No plugin provides a newsletter service (Mailchimp and others), so this list is not synced anywhere.</Callout>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service" htmlFor="ls-provider" error={errors.externalProvider}>
                <Select id="ls-provider" value={form.externalProvider} onChange={(e) => setForm({ ...form, externalProvider: e.target.value })} disabled={!editable} placeholder="Not synced" options={connected.map((p) => ({ value: p.id, label: p.connected ? p.name : `${p.name} (not connected)` }))} />
              </Field>
              {form.externalProvider && (
                <Field label="List or audience ID there" htmlFor="ls-ref" error={errors.externalRef}>
                  <Input id="ls-ref" value={form.externalRef} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} disabled={!editable} maxLength={200} />
                </Field>
              )}
            </div>
          )}
        </Card>
      </div>
    </form>
  );
}

export default function MailingListDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState('members');
  const q = useQuery({ queryKey: ['mailing-list', id], queryFn: () => api.get<ListDetail>(`/api/admin/lists/${id}`) });
  const sync = useAction(() => api.post(`/api/admin/lists/${id}/sync`), { success: 'Sync started; members update in a moment', invalidate: [['mailing-list', id], ['list-members', id]] });
  const remove = useAction(() => api.delete(`/api/admin/lists/${id}`), { success: 'List deleted', invalidate: [['mailing-lists']], onSuccess: () => navigate('/growth/lists') });
  if (q.isLoading) return <PageSkeleton />;
  if (q.error instanceof ApiError && q.error.status === 404) return <EmptyState title="List not found" description="It may have been deleted." action={<ButtonLink to="/growth/lists">All lists</ButtonLink>} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const list = q.data;
  const manage = can('marketing.lists.manage');
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Mailing lists', to: '/growth/lists' }, { label: list.name }]}
        title={list.name}
        description={list.description || undefined}
        meta={
          <>
            <span className="font-mono text-xs text-muted-foreground">{list.key}</span>
            <Badge tone={list.visibility === 'public' ? 'success' : 'neutral'}>{list.visibility}</Badge>
            <Badge tone={list.double_opt_in ? 'info' : 'neutral'}>{list.double_opt_in ? 'double opt-in' : 'single opt-in'}</Badge>
            {list.products.length > 0 && <Badge tone="primary">rule: {list.products.map((p) => p.name).join(', ')}</Badge>}
            {list.external && <Badge tone={list.external.connected ? 'success' : 'warning'}>{list.external.connected ? `synced with ${list.external.name}` : `${list.external.provider}: not connected`}</Badge>}
          </>
        }
        actions={
          <>
            {can('marketing.campaigns.manage') && (
              <ButtonLink to={`/growth/campaigns?new=1&list=${list.id}`} variant="outline" icon={<Megaphone className="size-4" />}>
                New campaign
              </ButtonLink>
            )}
            {manage && list.auto_product_ids.length > 0 && (
              <Button variant="outline" icon={<RefreshCw className="size-4" />} loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync rule now
              </Button>
            )}
            {manage && (
              <Button
                variant="outline"
                icon={<Trash2 className="size-4" />}
                onClick={async () => {
                  const r = await confirm({ title: `Delete “${list.name}”?`, description: 'Members and their consent records are deleted too. Lists used by a campaign cannot be deleted.', tone: 'danger', confirmLabel: 'Delete list', typeToConfirm: list.key });
                  if (r.confirmed) remove.mutate();
                }}
              >
                Delete
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Subscribed" value={list.counts.subscribed} display={num(list.counts.subscribed)} />
        <KpiTile label="Receive list email" value={list.counts.reachable} display={num(list.counts.reachable)} hint="Consented and not opted out" />
        <KpiTile label="Waiting for confirmation" value={list.counts.pending} display={num(list.counts.pending)} />
        <KpiTile label="Unsubscribed" value={list.counts.unsubscribed} display={num(list.counts.unsubscribed)} />
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'members', label: 'Members', content: <MembersTab list={list} /> },
          { value: 'settings', label: 'Settings', content: tab === 'settings' && <SettingsTab key={list.updated_at} list={list} /> },
          {
            value: 'campaigns',
            label: 'Campaigns',
            count: list.campaigns.length,
            content: (
              <Card padded={false}>
                {list.campaigns.length === 0 ? (
                  <EmptyState icon={<Megaphone />} title="No campaigns to this list yet" />
                ) : (
                  <ul className="divide-y">
                    {list.campaigns.map((c) => (
                      <li key={c.id}>
                        <Link to={`/growth/campaigns/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40">
                          <span className="truncate text-sm">{c.name}</span>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            {c.completed_at && <When value={c.completed_at} />}
                            <StatusBadge status={c.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ),
          },
        ]}
      />
    </>
  );
}
