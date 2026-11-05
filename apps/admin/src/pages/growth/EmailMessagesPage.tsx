import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MousePointerClick, MailOpen, Plus, ShieldBan, X } from 'lucide-react';
import clsx from 'clsx';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { num, pct, titleCase } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  ChartCard,
  ColumnChart,
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
  Tabs,
  Tip,
  Toolbar,
  When,
  useConfirm,
  type Column,
} from '../../components/ui';
import { PeriodPicker, StatusPill, dayKey, reasonLabel, useTabParam } from './shared';

interface MessageRow {
  id: string;
  to_email: string;
  user_id: string | null;
  template_key: string | null;
  locale: string | null;
  category: string;
  subject: string;
  status: string;
  suppression_reason: string | null;
  attempts: number;
  provider_type: string | null;
  last_error: string | null;
  campaign_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  created_at: string;
}

interface Suppression {
  email: string;
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';
  scope: 'all' | 'marketing';
  source: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface Stats {
  since: string;
  daily: { day: string; status: string; count: number }[];
  totals: Record<string, number>;
  engagement: { opened: number; clicked: number; delivered: number };
  bounceRate: number;
  complaintRate: number;
}

const STATUSES = ['queued', 'sending', 'sent', 'failed', 'suppressed', 'bounced', 'complained'];
const CATEGORIES = ['transactional', 'security', 'billing', 'marketing'];

// ---- Log ------------------------------------------------------------------------------------

const LOG_DEFAULTS = { status: '', category: '', to: '', templateKey: '', campaignId: '', userId: '', from: '', until: '', page: 1, pageSize: 25 };

function MessageLog() {
  const [state, setState, reset] = useUrlState(LOG_DEFAULTS);
  const [to, setTo] = useState(String(state.to ?? ''));
  const [templateKey, setTemplateKey] = useState(String(state.templateKey ?? ''));
  const toQ = useDebounced(to.trim(), 400);
  const tplQ = useDebounced(templateKey.trim(), 400);
  // Push the debounced text fields into the URL.
  useEffect(() => {
    if (toQ !== String(state.to ?? '') || tplQ !== String(state.templateKey ?? '')) setState({ to: toQ, templateKey: tplQ });
  }, [toQ, tplQ]);

  const query = useMemo(
    () => ({
      status: String(state.status),
      category: String(state.category),
      to: String(state.to),
      templateKey: String(state.templateKey),
      campaignId: String(state.campaignId),
      userId: String(state.userId),
      // Whole days in the viewer's time zone.
      from: state.from ? new Date(`${state.from}T00:00:00`).toISOString() : '',
      until: state.until ? new Date(`${state.until}T23:59:59.999`).toISOString() : '',
      page: state.page,
      pageSize: state.pageSize,
    }),
    [state],
  );
  const list = useQuery({
    queryKey: ['email-messages', query],
    queryFn: ({ signal }) => api.get<Page<MessageRow>>('/api/admin/email/messages', query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(state.status || state.category || state.to || state.templateKey || state.campaignId || state.userId || state.from || state.until);

  const columns: Column<MessageRow>[] = [
    {
      key: 'subject',
      header: 'Email',
      cell: (m) => (
        <span className="min-w-0">
          <span className="block max-w-md truncate">{m.subject}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {m.to_email}
            {m.template_key && <span className="font-mono"> · {m.template_key}</span>}
          </span>
        </span>
      ),
    },
    { key: 'category', header: 'Category', cell: (m) => <Badge tone={m.category === 'marketing' ? 'primary' : 'neutral'}>{m.category}</Badge> },
    {
      key: 'status',
      header: 'Status',
      cell: (m) => (
        <span className="inline-flex flex-col gap-0.5">
          <StatusPill status={m.status} />
          {m.suppression_reason && <span className="text-xs text-muted-foreground">{reasonLabel(m.suppression_reason)}</span>}
          {m.status === 'failed' && m.last_error && <span className="max-w-56 truncate text-xs text-danger">{m.last_error}</span>}
        </span>
      ),
    },
    {
      key: 'engagement',
      header: 'Engagement',
      priority: 'low',
      cell: (m) => (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          {m.opened_at ? (
            <Tip content="Opened">
              <MailOpen className="size-4 text-success" aria-label="Opened" />
            </Tip>
          ) : null}
          {m.clicked_at ? (
            <Tip content="Clicked a link">
              <MousePointerClick className="size-4 text-success" aria-label="Clicked" />
            </Tip>
          ) : null}
          {!m.opened_at && !m.clicked_at && '—'}
        </span>
      ),
    },
    { key: 'created_at', header: 'Created', cell: (m) => <When value={m.created_at} /> },
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={to} onChange={setTo} placeholder="Recipient address (exact)" className="w-full sm:w-64" />
        <Select aria-label="Status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        <Select aria-label="Category" className="w-auto" value={String(state.category)} onChange={(e) => setState({ category: e.target.value })} placeholder="Any category" options={CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        <Input aria-label="Template key" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} placeholder="Template key" className="w-40 font-mono text-xs" />
        <Input aria-label="From date" type="date" value={String(state.from)} onChange={(e) => setState({ from: e.target.value })} className="w-auto" />
        <Input aria-label="Until date" type="date" value={String(state.until)} onChange={(e) => setState({ until: e.target.value })} className="w-auto" />
        {(state.campaignId || state.userId) && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-primary">
            {state.campaignId ? (
              <Link to={`/growth/campaigns/${state.campaignId}`} className="hover:underline">
                Campaign
              </Link>
            ) : (
              <Link to={`/customers/users/${state.userId}`} className="hover:underline">
                Customer
              </Link>
            )}
            <button type="button" aria-label="Remove filter" className="rounded-full p-0.5 hover:bg-primary/10" onClick={() => setState({ campaignId: '', userId: '' })}>
              <X className="size-3.5" />
            </button>
          </span>
        )}
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setTo('');
              setTemplateKey('');
              reset();
            }}
          >
            Clear
          </Button>
        )}
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Email log"
          columns={columns}
          rows={list.data?.data}
          rowKey={(m) => m.id}
          rowHref={(m) => `/growth/email/messages/${m.id}`}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title={filtered ? 'No emails match these filters' : 'No emails yet'} description={filtered ? undefined : 'Every email the platform sends or skips is logged here.'} />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

// ---- Suppressions -----------------------------------------------------------------------------

const SUP_DEFAULTS = { q: '', reason: '', page: 1, pageSize: 25 };
const SUP_REASONS: Record<Suppression['reason'], string> = { hard_bounce: 'Hard bounce', complaint: 'Spam complaint', unsubscribe: 'Unsubscribed', manual: 'Added manually' };

function AddSuppressionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ email: '', scope: 'all', note: '' });
  const [error, setError] = useState<string | null>(null);
  const add = useAction(() => api.post('/api/admin/email/suppressions', { email: form.email, scope: form.scope, note: form.note || undefined }), {
    success: 'Address suppressed',
    invalidate: [['email-suppressions']],
    onSuccess: () => {
      setForm({ email: '', scope: 'all', note: '' });
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Suppress an address"
      description="Stop sending to an address, for example at the person’s request or for a known bad address."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-suppression" loading={add.isPending}>
            Suppress
          </Button>
        </>
      }
    >
      <form
        id="add-suppression"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          add.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Email address" htmlFor="sup-email" required>
          <Input id="sup-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoFocus />
        </Field>
        <Field label="Scope" htmlFor="sup-scope" hint="Account, security and billing emails stop only with “All email”">
          <Select id="sup-scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} options={[{ value: 'all', label: 'All email' }, { value: 'marketing', label: 'Marketing only' }]} />
        </Field>
        <Field label="Note" htmlFor="sup-note">
          <Input id="sup-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
        </Field>
      </form>
    </Modal>
  );
}

function Suppressions() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(SUP_DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['email-suppressions', state],
    queryFn: ({ signal }) => api.get<Page<Suppression>>('/api/admin/email/suppressions', { q: String(state.q), reason: String(state.reason), page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const remove = useAction((email: string) => api.delete(`/api/admin/email/suppressions/${encodeURIComponent(email)}`), { success: 'Suppression removed', invalidate: [['email-suppressions']] });
  const manage = can('email.suppressions.manage');

  return (
    <div className="space-y-4">
      <Callout title="Why addresses are suppressed">
        Hard bounces and spam complaints block every email to protect your sender reputation. Unsubscribes block marketing only. Marketing also requires recorded consent, so it never reaches people who did not opt in.
      </Callout>
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={search} onChange={setSearch} placeholder="Search addresses…" className="w-full sm:w-72" />
          <Select aria-label="Reason" className="w-auto" value={String(state.reason)} onChange={(e) => setState({ reason: e.target.value })} placeholder="Any reason" options={Object.entries(SUP_REASONS).map(([value, label]) => ({ value, label }))} />
          {manage && (
            <Button variant="outline" className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Suppress address
            </Button>
          )}
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Suppressed addresses"
            rows={list.data?.data}
            rowKey={(s) => s.email}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={<EmptyState icon={<ShieldBan />} title="No suppressed addresses" />}
            columns={[
              { key: 'email', header: 'Address', cell: (s) => <span className="font-medium">{s.email}</span> },
              { key: 'reason', header: 'Reason', cell: (s) => <Badge tone={s.reason === 'hard_bounce' || s.reason === 'complaint' ? 'danger' : 'neutral'}>{SUP_REASONS[s.reason] ?? s.reason}</Badge> },
              { key: 'scope', header: 'Blocks', cell: (s) => (s.scope === 'all' ? 'All email' : 'Marketing only') },
              { key: 'source', header: 'Source', priority: 'low', cell: (s) => <span className="text-sm text-muted-foreground">{s.source ?? '—'}</span> },
              { key: 'created', header: 'Since', cell: (s) => <When value={s.created_at} /> },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: '',
                      align: 'right' as const,
                      cell: (s: Suppression) => (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const r = await confirm({
                              title: `Remove the suppression for ${s.email}?`,
                              description: s.reason === 'hard_bounce' || s.reason === 'complaint' ? 'Only do this if the address is known to work again or the person asked to receive email. Sending to bad addresses hurts deliverability for everyone.' : 'Email to this address resumes. Marketing still requires consent.',
                              tone: 'danger',
                              confirmLabel: 'Remove suppression',
                            });
                            if (r.confirmed) remove.mutate(s.email);
                          }}
                        >
                          Remove
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      <AddSuppressionDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

// ---- Delivery stats ----------------------------------------------------------------------------

const STATS_DEFAULTS = { days: 30 };
const ATTEMPTED = ['sent', 'bounced', 'complained'];

function DeliveryStats() {
  const [state, setState] = useUrlState(STATS_DEFAULTS);
  const days = Number(state.days) || 30;
  const stats = useQuery({ queryKey: ['email-stats', days], queryFn: () => api.get<Stats>('/api/admin/email/stats', { days }), placeholderData: keepPreviousData });

  const series = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const d of stats.data?.daily ?? []) if (ATTEMPTED.includes(d.status)) byDay.set(dayKey(d.day), (byDay.get(dayKey(d.day)) ?? 0) + d.count);
    const out: { date: string; value: number }[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, value: byDay.get(key) ?? 0 });
    }
    return out;
  }, [stats.data, days]);

  if (stats.isLoading) return <PageSkeleton />;
  if (stats.error || !stats.data) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  const t = (k: string) => s.totals[k] ?? 0;
  const attempted = t('sent') + t('bounced') + t('complained');
  const fetching = stats.isFetching && !stats.isLoading;
  const risky = s.bounceRate >= 0.02 || s.complaintRate >= 0.001;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <PeriodPicker days={days} onChange={(d) => setState({ days: d })} />
      </div>
      {risky && (
        <Callout tone="warning" title="Deliverability at risk">
          Mailbox providers start filtering senders above roughly 2% bounces or 0.1% spam complaints. Review recent bounces and make sure marketing only goes to people who opted in.
        </Callout>
      )}
      <div className={clsx('grid grid-cols-1 gap-3 transition-opacity min-[420px]:grid-cols-2 lg:grid-cols-4', fetching && 'opacity-60')}>
        <KpiTile label="Sent" value={attempted} display={num(attempted)} hint={s.engagement.delivered ? `${num(s.engagement.delivered)} confirmed delivered` : 'Delivery confirmations need provider webhooks'} />
        <KpiTile label="Opened" value={s.engagement.opened} display={attempted ? pct(s.engagement.opened / attempted) : '—'} hint={`${num(s.engagement.opened)} emails · ${num(s.engagement.clicked)} clicked`} />
        <KpiTile label="Bounce rate" value={s.bounceRate} display={pct(s.bounceRate)} hint={`${num(t('bounced'))} bounced`} />
        <KpiTile label="Complaint rate" value={s.complaintRate} display={pct(s.complaintRate, 2)} hint={`${num(t('complained'))} marked as spam`} />
      </div>
      <ChartCard title="Emails sent per day" description="Handed to a provider, including ones that later bounced" data={series} format={(v) => num(v)} fetching={fetching}>
        <ColumnChart data={series} format={(v) => num(v)} label="Emails sent per day" />
      </ChartCard>
      <Card title="Not sent" description="For the selected period">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {[
            ['suppressed', 'Skipped (consent or suppression)'],
            ['failed', 'Failed after retries'],
            ['queued', 'Waiting in the queue'],
            ['sending', 'Being sent'],
          ].map(([k, label]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-base font-semibold tabular">
                <Link to={`/growth/email/messages?status=${k}`} className="hover:underline">
                  {num(t(k))}
                </Link>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

export default function EmailMessagesPage() {
  const { can } = useAuth();
  const [tab, setTab] = useTabParam('log');
  return (
    <>
      <PageHeader title="Email log" description="Every email sent, skipped or failed, with delivery events, suppressions and deliverability." />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'log', label: 'Messages', content: <MessageLog /> },
          { value: 'suppressions', label: 'Suppressions', content: <Suppressions /> },
          { value: 'stats', label: 'Deliverability', hidden: !can('email.messages.view'), content: <DeliveryStats /> },
        ]}
      />
    </>
  );
}
