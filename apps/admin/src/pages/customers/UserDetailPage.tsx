import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Activity, Archive, ArchiveRestore, Ban, CircleCheck, CircleX, Download, Eye, KeyRound, LogOut, MailCheck, Merge, MoreHorizontal, Pencil, Pin, PinOff, Plus, RotateCcw, Send, ShieldAlert, Trash2, UserX } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, money, num } from '../../lib/format';
import { UsageMeters, type MeterUsage } from '../../components/UsagePanel';
import { EntitlementsPanel } from '../../components/EntitlementsPanel';
import { ProductInvoiceDialog } from '../revenue/ProductInvoiceDialog';
import { MergeUsersDialog } from '../user-management/MergeUsersDialog';
import { AgreementsCard, IpAddressesCard, SocialIdentitiesCard } from '../user-management/UserPanels';
import { UserAccessPanel } from '../content/UserAccessPanel';
import { UserMailingPanel } from '../lists/UserMailingPanel';
import { SendNotificationDialog } from '../push/SendNotificationDialog';
import { UserNotificationsPanel } from '../push/UserNotificationsPanel';
import { useBootstrap } from '../../components/layout/AppShell';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
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
  Switch,
  Tabs,
  Textarea,
  When,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import type { UserRow } from './UsersPage';

interface UserDetail extends UserRow {
  phone: string | null;
  locale: string | null;
  timezone: string | null;
  utm: Record<string, string> | null;
  referral_code: string | null;
  custom_fields: Record<string, unknown>;
  metadata: Record<string, unknown>;
  marketing_consent: boolean;
  suspended_until: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  anonymized_at: string | null;
  organizations: { id: string; name: string; slug: string; role: string; status: string; created_at: string }[];
  notesCount: number;
  activeSessions: number;
  activeImpersonation: { id: string; admin_id: string; expires_at: string; read_only: boolean } | null;
  mergedInto: { id: string; email: string; name: string | null } | null;
  mergedFrom: { id: string; source_id: string; email: string; name: string | null; created_at: string }[];
  panels: {
    billing?: {
      subscriptions: { id: string; status: string; quantity: number; currency: string; current_period_end: string | null; cancel_at_period_end: boolean; product_name: string; unit_amount: number; interval: string | null }[];
      invoices: { id: string; number: string | null; status: string; total: number; amount_due: number; amount_paid: number; currency: string; created_at: string }[];
      payments: { id: string; status: string; amount: number; amount_refunded: number; currency: string; method_type: string | null; method_details: Record<string, string> | null; created_at: string }[];
      revenueByCurrency: { currency: string; net: number }[];
    };
    usage?: MeterUsage[];
    credits?: { type: string; balance: number; updatedAt: string }[];
    support?: { tickets: { id: string; number: string; subject: string; status: string; priority: string; csat_rating: number | null; created_at: string }[]; open: number };
    email?: { recent: { id: string; template_key: string | null; subject: string; status: string; suppression_reason: string | null; created_at: string; opened_at: string | null }[]; suppression: { reason: string; scope: string; created_at: string } | null };
    affiliates?: {
      referredBy: { id: string; attribution: string; status: string; converted_at: string | null; created_at: string; affiliate_id: string; affiliate_name: string; affiliate_code: string; fraud_flags: string[] } | null;
      affiliate: { id: string; code: string; status: string } | null;
    };
  };
}

interface TimelineItem {
  kind: 'event' | 'admin_action' | 'login' | 'note';
  id: string;
  title: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface Note {
  id: string;
  body: string;
  pinned: boolean;
  admin_name: string | null;
  created_at: string;
}

interface SessionRow {
  id: string;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  impersonator_admin_id: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface LoginEvent {
  id: string;
  success: boolean;
  failure_reason: string | null;
  method: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: string;
}

// ---- Dialogs ------------------------------------------------------------------------------

function EditUserDialog({ user, open, onOpenChange }: { user: UserDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ name: user.name ?? '', email: user.email, phone: user.phone ?? '', country: user.country ?? '', locale: user.locale ?? '', timezone: user.timezone ?? '', externalId: user.external_id ?? '', tags: user.tags.join(', '), marketingConsent: user.marketing_consent });
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch(`/api/admin/users/${user.id}`, {
        name: form.name,
        email: form.email,
        phone: form.phone || undefined,
        country: form.country || undefined,
        locale: form.locale || undefined,
        timezone: form.timezone || undefined,
        externalId: form.externalId || undefined,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        marketingConsent: form.marketingConsent,
      }),
    { success: 'Profile updated', invalidate: [['user', user.id], ['users']], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit profile"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-user" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-user"
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
        <Field label="Name" htmlFor="eu-name">
          <Input id="eu-name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Email" htmlFor="eu-email">
          <Input id="eu-email" type="email" value={form.email} onChange={set('email')} required />
        </Field>
        <Field label="Phone" htmlFor="eu-phone">
          <Input id="eu-phone" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="External ID" htmlFor="eu-ext">
          <Input id="eu-ext" value={form.externalId} onChange={set('externalId')} />
        </Field>
        <Field label="Country" htmlFor="eu-country">
          <Input id="eu-country" value={form.country} onChange={set('country')} maxLength={2} />
        </Field>
        <Field label="Locale" htmlFor="eu-locale">
          <Input id="eu-locale" value={form.locale} onChange={set('locale')} placeholder="en-US" />
        </Field>
        <Field label="Time zone" htmlFor="eu-tz">
          <Input id="eu-tz" value={form.timezone} onChange={set('timezone')} placeholder="Europe/Berlin" />
        </Field>
        <Field label="Tags" htmlFor="eu-tags" hint="Comma separated">
          <Input id="eu-tags" value={form.tags} onChange={set('tags')} />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox checked={form.marketingConsent} onChange={(e) => setForm((f) => ({ ...f, marketingConsent: e.target.checked }))} label="Consented to marketing email" description="Change only on the customer's request." />
        </div>
      </form>
    </Modal>
  );
}

function ImpersonateDialog({ user, open, onOpenChange }: { user: UserDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [result, setResult] = useState<{ id: string; token: string; url: string | null; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useAction(() => api.post<{ id: string; token: string; url: string | null; expiresAt: string }>(`/api/admin/users/${user.id}/impersonate`, { reason, readOnly }), {
    invalidate: [['user', user.id]],
    onSuccess: setResult,
    onError: (e) => setError(errorMessage(e)),
  });
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setResult(null);
      setReason('');
      setError(null);
    }
  };
  return (
    <Modal open={open} onOpenChange={close} title={`Impersonate ${user.name || user.email}`} description="Sign in to your application as this customer for support. The session is time-limited, recorded in the audit log, and the customer-facing app shows an impersonation banner.">
      {result ? (
        <div className="space-y-3">
          <Callout tone="success" title="Impersonation session started">
            Expires {dateTime(result.expiresAt)}. {readOnly ? 'Read-only: changes are blocked.' : 'Full access: actions are attributed to you.'}
          </Callout>
          {result.url ? (
            <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-ui-sm bg-primary px-3.5 text-sm font-medium text-primary-foreground">
              <Eye className="size-4" /> Open the app as this user
            </a>
          ) : (
            <Field label="One-time token" hint="Exchange it in your application with the SDK (verifyImpersonation). Configure an impersonation URL in Settings → Customers to get a direct link.">
              <CodeBlock code={result.token} />
            </Field>
          )}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start.mutate();
          }}
        >
          <FormError message={error} />
          <Field label="Reason" htmlFor="imp-reason" hint="Required. For example the support ticket number and what you need to check." required>
            <Textarea id="imp-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required />
          </Field>
          <Switch checked={readOnly} onCheckedChange={setReadOnly} label="Read-only" description="Recommended. Blocks changes while impersonating." />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={start.isPending} disabled={reason.trim().length < 10}>
              Start impersonation
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function CreditsDialog({ user, open, onOpenChange }: { user: UserDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ action: 'grant', creditType: user.panels.credits?.[0]?.type ?? 'credits', amount: '', reason: '', expiresAt: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = useAction(
    () =>
      api.post(`/api/admin/credits/${form.action}`, {
        userId: user.id,
        creditType: form.creditType,
        amount: Number(form.amount),
        reason: form.reason,
        expiresAt: form.action === 'grant' && form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
      }),
    { success: form.action === 'grant' ? 'Credits granted' : 'Credits deducted', invalidate: [['user', user.id]], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust credits"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="credits-form" loading={submit.isPending}>
            {form.action === 'grant' ? 'Grant credits' : 'Deduct credits'}
          </Button>
        </>
      }
    >
      <form
        id="credits-form"
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
        <Field label="Action" htmlFor="cr-action">
          <Select id="cr-action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} options={[{ value: 'grant', label: 'Grant (complimentary)' }, { value: 'deduct', label: 'Deduct' }]} />
        </Field>
        <Field label="Credit type" htmlFor="cr-type">
          <Input id="cr-type" value={form.creditType} onChange={(e) => setForm({ ...form, creditType: e.target.value })} required />
        </Field>
        <Field label="Amount" htmlFor="cr-amount">
          <Input id="cr-amount" type="number" min={1} step={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
        </Field>
        {form.action === 'grant' && (
          <Field label="Expires" htmlFor="cr-exp" hint="Optional">
            <Input id="cr-exp" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
        )}
        <Field label="Reason" htmlFor="cr-reason" className="sm:col-span-2" hint="Recorded in the credit ledger and audit log">
          <Input id="cr-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} required />
        </Field>
      </form>
    </Modal>
  );
}

// ---- Tabs ---------------------------------------------------------------------------------

function OverviewTab({ user }: { user: UserDetail }) {
  const { can } = useAuth();
  const utm = user.utm && Object.keys(user.utm).length ? Object.entries(user.utm).map(([k, v]) => `${k}=${v}`).join(' · ') : null;
  const custom = Object.entries(user.custom_fields ?? {});
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Profile" className="lg:col-span-2">
        <KeyValue
          items={[
            { label: 'Email', value: <span className="inline-flex flex-wrap items-center gap-1.5">{user.email}{user.email_verified_at ? <Badge tone="success">verified</Badge> : <Badge>unverified</Badge>}</span> },
            { label: 'Name', value: user.name },
            { label: 'External ID', value: <Mono copy>{user.external_id}</Mono> },
            { label: 'User ID', value: <Mono copy>{user.id}</Mono> },
            { label: 'Phone', value: user.phone },
            { label: 'Country', value: user.country },
            { label: 'Locale / time zone', value: [user.locale, user.timezone].filter(Boolean).join(' · ') || null },
            { label: 'Registration source', value: user.registration_source },
            { label: 'Referral code', value: user.referral_code },
            { label: 'Campaign (UTM)', value: utm },
            { label: 'Marketing consent', value: user.marketing_consent ? 'Yes' : 'No' },
            { label: 'Signed up', value: dateTime(user.created_at) },
            { label: 'Last active', value: user.last_active_at ? dateTime(user.last_active_at) : null },
            { label: 'Last sign-in', value: user.last_login_at ? `${dateTime(user.last_login_at)}${user.last_login_ip ? ` from ${user.last_login_ip}` : ''}` : null },
          ]}
        />
      </Card>
      <div className="space-y-4">
        <Card title="Organizations" padded={false}>
          {user.organizations.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Not a member of any organization.</p>
          ) : (
            <ul className="divide-y">
              {user.organizations.map((o) => (
                <li key={o.id}>
                  <Link to={`/customers/organizations/${o.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/40">
                    <span className="truncate text-sm font-medium">{o.name}</span>
                    <span className="flex items-center gap-1.5">
                      <Badge>{o.role}</Badge>
                      {o.status !== 'active' && <StatusBadge status={o.status} />}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Tags">
          {user.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {user.tags.map((t) => (
                <Link key={t} to={`/customers/users?tag=${encodeURIComponent(t)}`}>
                  <Badge tone="primary">{t}</Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tags.</p>
          )}
        </Card>
        {custom.length > 0 && (
          <Card title="Custom fields">
            <KeyValue columns={1} items={custom.map(([k, v]) => ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }))} />
          </Card>
        )}
        {can('customers.agreements.view') && <AgreementsCard userId={user.id} />}
        {user.mergedFrom.length > 0 && (
          <Card title="Merged accounts" padded={false}>
            <ul className="divide-y">
              {user.mergedFrom.map((m) => (
                <li key={m.id}>
                  <Link to={`/customers/users/${m.source_id}`} className="block px-4 py-2.5 hover:bg-muted/40">
                    <span className="block truncate text-sm font-medium">{m.name || m.email}</span>
                    <span className="text-xs text-muted-foreground">Merged {dateTime(m.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {Object.keys(user.metadata ?? {}).length > 0 && (
          <Card title="Metadata">
            <JsonView value={user.metadata} />
          </Card>
        )}
      </div>
    </div>
  );
}

function BillingTab({ user }: { user: UserDetail }) {
  const { can } = useAuth();
  const [invoicing, setInvoicing] = useState(false);
  const b = user.panels.billing!;
  const canInvoice = can('billing.invoices.manage') && !user.deleted_at;
  return (
    <div className="space-y-4">
      {b.revenueByCurrency.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {b.revenueByCurrency.map((r) => (
            <div key={r.currency} className="rounded-ui border bg-surface px-4 py-3 shadow-ui">
              <p className="text-xs text-muted-foreground">Net revenue ({r.currency})</p>
              <p className="text-lg font-semibold tabular">{money(r.net, r.currency)}</p>
            </div>
          ))}
        </div>
      )}
      <Card title="Subscriptions" padded={false}>
        <DataTable
          rows={b.subscriptions}
          rowKey={(s) => s.id}
          rowHref={(s) => `/revenue/subscriptions/${s.id}`}
          empty={<EmptyState title="No subscriptions" />}
          columns={[
            { key: 'product', header: 'Plan', cell: (s) => s.product_name },
            { key: 'status', header: 'Status', cell: (s) => <span className="flex flex-wrap gap-1"><StatusBadge status={s.status} />{s.cancel_at_period_end && <Badge tone="warning">cancels at period end</Badge>}</span> },
            { key: 'price', header: 'Price', align: 'right', cell: (s) => `${money(s.unit_amount * s.quantity, s.currency)}${s.interval ? ` / ${s.interval}` : ''}` },
            { key: 'renews', header: 'Current period ends', cell: (s) => dateTime(s.current_period_end) },
          ]}
        />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Invoices"
          padded={false}
          actions={
            canInvoice && (
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setInvoicing(true)}>
                Add invoice
              </Button>
            )
          }
        >
          <DataTable
            rows={b.invoices}
            rowKey={(i) => i.id}
            rowHref={(i) => `/revenue/invoices/${i.id}`}
            empty={<EmptyState title="No invoices" />}
            columns={[
              { key: 'number', header: 'Number', cell: (i) => i.number ?? <span className="text-muted-foreground">Draft</span> },
              { key: 'status', header: 'Status', cell: (i) => <StatusBadge status={i.status} /> },
              { key: 'total', header: 'Total', align: 'right', cell: (i) => money(i.total, i.currency) },
              { key: 'date', header: 'Date', cell: (i) => <When value={i.created_at} /> },
            ]}
          />
        </Card>
        <Card title="Payments" padded={false}>
          <DataTable
            rows={b.payments}
            rowKey={(p) => p.id}
            rowHref={(p) => `/revenue/payments/${p.id}`}
            empty={<EmptyState title="No payments" />}
            columns={[
              { key: 'amount', header: 'Amount', cell: (p) => money(p.amount, p.currency) },
              { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.status} /> },
              { key: 'method', header: 'Method', cell: (p) => (p.method_details?.brand ? `${p.method_details.brand} •••• ${p.method_details.last4 ?? ''}` : p.method_type ?? '—') },
              { key: 'date', header: 'Date', cell: (p) => <When value={p.created_at} /> },
            ]}
          />
        </Card>
      </div>
      {invoicing && (
        <ProductInvoiceDialog
          open={invoicing}
          onOpenChange={setInvoicing}
          customer={{ type: 'user', id: user.id, label: user.name || user.email, sublabel: user.name ? user.email : null }}
          refresh={[['user', user.id]]}
        />
      )}
    </div>
  );
}

function UsageTab({ user }: { user: UserDetail }) {
  const { can } = useAuth();
  const [adjusting, setAdjusting] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Quotas and usage" description="Current period, enforced on the server" className="lg:col-span-2">
        <UsageMeters meters={user.panels.usage ?? []} />
      </Card>
      <Card title="Credit balances" actions={can('usage.credits.manage') && <Button size="sm" variant="outline" onClick={() => setAdjusting(true)}>Adjust</Button>}>
        {(user.panels.credits ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No credits.</p>
        ) : (
          <ul className="divide-y">
            {user.panels.credits!.map((c) => (
              <li key={c.type} className="flex items-center justify-between py-2 text-sm">
                <span>{c.type}</span>
                <span className="font-semibold tabular">{num(c.balance)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adjusting && <CreditsDialog user={user} open={adjusting} onOpenChange={setAdjusting} />}
    </div>
  );
}

const KIND_LABEL: Record<TimelineItem['kind'], string> = { event: 'Event', admin_action: 'Admin', login: 'Sign-in', note: 'Note' };

function TimelineTab({ userId }: { userId: string }) {
  const q = useInfiniteQuery({
    queryKey: ['user-timeline', userId],
    queryFn: ({ pageParam }) => api.get<{ data: TimelineItem[] }>(`/api/admin/users/${userId}/timeline`, { before: pageParam, limit: 40 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.data.length === 40 ? last.data[last.data.length - 1].created_at : undefined),
  });
  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data?.pages.flatMap((p) => p.data) ?? [];
  if (!items.length) return <EmptyState icon={<Activity />} title="No activity recorded yet" />;
  return (
    <Card padded={false}>
      <ol className="divide-y">
        {items.map((t) => {
          const d = (t.detail ?? {}) as Record<string, any>;
          const summary = t.kind === 'note' ? d.body : t.kind === 'login' ? [d.ip, d.country, d.reason].filter(Boolean).join(' · ') : t.kind === 'admin_action' ? `by ${d.actor ?? 'system'}` : null;
          return (
            <li key={`${t.kind}:${t.id}`} className="flex gap-3 px-4 py-3">
              <Badge tone={t.kind === 'admin_action' ? 'warning' : t.kind === 'login' ? (t.title.endsWith('failed') ? 'danger' : 'info') : t.kind === 'note' ? 'primary' : 'neutral'} className="mt-0.5 w-16 justify-center">
                {KIND_LABEL[t.kind]}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title.replace(/_/g, ' ')}</p>
                {summary && <p className="line-clamp-2 text-xs text-muted-foreground">{summary}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                <When value={t.created_at} />
              </span>
            </li>
          );
        })}
      </ol>
      {q.hasNextPage && (
        <div className="border-t p-3 text-center">
          <Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load older activity
          </Button>
        </div>
      )}
    </Card>
  );
}

function NotesTab({ userId }: { userId: string }) {
  const { can } = useAuth();
  const [body, setBody] = useState('');
  const notes = useQuery({ queryKey: ['user-notes', userId], queryFn: () => api.get<{ data: Note[] }>(`/api/admin/users/${userId}/notes`) });
  const add = useAction(() => api.post(`/api/admin/users/${userId}/notes`, { body }), { success: 'Note added', invalidate: [['user-notes', userId], ['user', userId]], onSuccess: () => setBody('') });
  const pin = useAction((n: Note) => api.patch(`/api/admin/notes/${n.id}`, { pinned: !n.pinned }), { invalidate: [['user-notes', userId]] });
  const remove = useAction((id: string) => api.delete(`/api/admin/notes/${id}`), { success: 'Note deleted', invalidate: [['user-notes', userId], ['user', userId]] });
  const confirm = useConfirm();
  const list = [...(notes.data?.data ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        {notes.isLoading ? (
          <PageSkeleton />
        ) : list.length === 0 ? (
          <EmptyState title="No notes" description="Internal notes are visible to administrators only." />
        ) : (
          list.map((n) => (
            <Card key={n.id} className={n.pinned ? 'border-primary/40' : undefined}>
              <div className="flex items-start gap-3">
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">{n.body}</p>
                {can('customers.notes.manage') && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={n.pinned ? 'Unpin note' : 'Pin note'} onClick={() => pin.mutate(n)}>
                      {n.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete note"
                      onClick={async () => {
                        if ((await confirm({ title: 'Delete this note?', tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate(n.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {n.pinned && <Badge tone="primary" className="mr-1.5">pinned</Badge>}
                {n.admin_name ?? 'Administrator'} · <When value={n.created_at} />
              </p>
            </Card>
          ))
        )}
      </div>
      {can('customers.notes.manage') && (
        <Card title="Add a note">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Context for your team: calls, promises, special terms…" aria-label="Note" required />
            <Button type="submit" loading={add.isPending} disabled={!body.trim()}>
              Add note
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function SecurityTab({ user }: { user: UserDetail }) {
  const { can } = useAuth();
  const boot = useBootstrap();
  const identityEnabled = Boolean(boot.data?.modules.find((m) => m.id === 'identity')?.enabled);
  const [page, setPage] = useState(1);
  const sessions = useQuery({ queryKey: ['user-sessions', user.id], queryFn: () => api.get<{ data: SessionRow[] }>(`/api/admin/users/${user.id}/sessions`), enabled: can('customers.sessions.view') });
  const logins = useQuery({ queryKey: ['user-logins', user.id, page], queryFn: () => api.get<Page<LoginEvent>>(`/api/admin/users/${user.id}/login-events`, { page, pageSize: 20 }) });
  const endImp = useAction((id: string) => api.post(`/api/admin/impersonations/${id}/end`), { success: 'Impersonation ended', invalidate: [['user', user.id], ['user-sessions', user.id]] });
  return (
    <div className="space-y-4">
      {user.activeImpersonation && (
        <Callout
          tone="warning"
          title="An impersonation session is active"
          action={
            can('customers.users.impersonate') && (
              <Button size="sm" variant="outline" onClick={() => endImp.mutate(user.activeImpersonation!.id)} loading={endImp.isPending}>
                End now
              </Button>
            )
          }
        >
          {user.activeImpersonation.read_only ? 'Read-only' : 'Full access'} · expires {dateTime(user.activeImpersonation.expires_at)}
        </Callout>
      )}
      {can('customers.sessions.view') && (
        <Card title="Sessions" description="Sessions your application created for this user" padded={false}>
          <DataTable
            rows={sessions.data?.data}
            loading={sessions.isLoading}
            rowKey={(s) => s.id}
            empty={<EmptyState title="No sessions" />}
            columns={[
              { key: 'device', header: 'Device', cell: (s) => <span className="block max-w-xs truncate">{s.user_agent ?? 'Unknown'}</span> },
              { key: 'ip', header: 'IP', cell: (s) => <span className="font-mono text-xs">{s.ip ?? '—'}{s.country ? ` · ${s.country}` : ''}</span> },
              { key: 'state', header: 'State', cell: (s) => (s.revoked_at ? <Badge>{s.revoked_reason ?? 'revoked'}</Badge> : s.impersonator_admin_id ? <Badge tone="warning">impersonation</Badge> : <Badge tone="success">active</Badge>) },
              { key: 'seen', header: 'Last seen', cell: (s) => <When value={s.last_seen_at ?? s.created_at} /> },
            ]}
          />
        </Card>
      )}
      <Card title="Sign-in history" description="IP addresses can be shared or change (mobile networks, VPNs); treat them as a signal, not proof of identity." padded={false}>
        <DataTable
          rows={logins.data?.data}
          loading={logins.isLoading}
          fetching={logins.isFetching && !logins.isLoading}
          rowKey={(l) => l.id}
          empty={<EmptyState title="No sign-ins recorded" />}
          columns={[
            { key: 'result', header: 'Result', cell: (l) => (l.success ? <span className="inline-flex items-center gap-1 text-success"><CircleCheck className="size-4" /> Success</span> : <span className="inline-flex items-center gap-1 text-danger"><CircleX className="size-4" /> {l.failure_reason ?? 'Failed'}</span>) },
            { key: 'method', header: 'Method', cell: (l) => l.method ?? 'password' },
            { key: 'ip', header: 'IP', cell: (l) => <span className="font-mono text-xs">{l.ip ?? '—'}{l.country ? ` · ${l.country}` : ''}</span> },
            { key: 'agent', header: 'Device', priority: 'low', cell: (l) => <span className="block max-w-xs truncate">{l.user_agent ?? '—'}</span> },
            { key: 'when', header: 'When', cell: (l) => <When value={l.created_at} /> },
          ]}
        />
        {logins.data && <Pagination page={logins.data.page} pageSize={logins.data.pageSize} total={logins.data.total} onPage={setPage} />}
      </Card>
      {can('security.sharing.view') && <IpAddressesCard userId={user.id} />}
      {identityEnabled && can('identity.providers.view') && <SocialIdentitiesCard userId={user.id} />}
    </div>
  );
}

function SupportTab({ user }: { user: UserDetail }) {
  const s = user.panels.support!;
  return (
    <Card title="Support tickets" description={`${s.open} open`} padded={false}>
      <DataTable
        rows={s.tickets}
        rowKey={(t) => t.id}
        rowHref={(t) => `/customers/support/${t.id}`}
        empty={<EmptyState title="No tickets" />}
        columns={[
          { key: 'subject', header: 'Ticket', cell: (t) => `${t.number} · ${t.subject}` },
          { key: 'status', header: 'Status', cell: (t) => <StatusBadge status={t.status} /> },
          { key: 'priority', header: 'Priority', cell: (t) => <Badge tone={t.priority === 'urgent' ? 'danger' : t.priority === 'high' ? 'warning' : 'neutral'}>{t.priority}</Badge> },
          { key: 'csat', header: 'CSAT', cell: (t) => (t.csat_rating ? `${t.csat_rating}/5` : '—') },
          { key: 'created', header: 'Opened', cell: (t) => <When value={t.created_at} /> },
        ]}
      />
    </Card>
  );
}

function EmailTab({ user }: { user: UserDetail }) {
  const e = user.panels.email!;
  return (
    <div className="space-y-4">
      {e.suppression && (
        <Callout tone="warning" title="Email to this address is suppressed">
          Reason: {e.suppression.reason} ({e.suppression.scope}) since {dateTime(e.suppression.created_at)}. Manage suppressions under Growth → Email.
        </Callout>
      )}
      <Card title="Recent email" padded={false}>
        <DataTable
          rows={e.recent}
          rowKey={(m) => m.id}
          rowHref={(m) => `/growth/email/messages/${m.id}`}
          empty={<EmptyState title="No email sent" />}
          columns={[
            { key: 'subject', header: 'Subject', cell: (m) => m.subject },
            { key: 'template', header: 'Template', cell: (m) => <span className="font-mono text-xs">{m.template_key ?? '—'}</span> },
            { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
            { key: 'opened', header: 'Opened', cell: (m) => (m.opened_at ? <When value={m.opened_at} /> : '—') },
            { key: 'sent', header: 'Sent', cell: (m) => <When value={m.created_at} /> },
          ]}
        />
      </Card>
    </div>
  );
}

function AffiliateTab({ user }: { user: UserDetail }) {
  const a = user.panels.affiliates!;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Referred by">
        {a.referredBy ? (
          <KeyValue
            items={[
              { label: 'Affiliate', value: <Link className="text-primary hover:underline" to={`/growth/affiliates/${a.referredBy.affiliate_id}`}>{a.referredBy.affiliate_name} ({a.referredBy.affiliate_code})</Link> },
              { label: 'Status', value: <StatusBadge status={a.referredBy.status} /> },
              { label: 'Attribution', value: a.referredBy.attribution },
              { label: 'Converted', value: a.referredBy.converted_at ? dateTime(a.referredBy.converted_at) : 'Not yet' },
              { label: 'Fraud flags', value: a.referredBy.fraud_flags?.length ? a.referredBy.fraud_flags.join(', ') : 'None', hidden: !a.referredBy.fraud_flags },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not referred by an affiliate.</p>
        )}
      </Card>
      <Card title="Affiliate account">
        {a.affiliate ? (
          <p className="text-sm">
            <Link className="text-primary hover:underline" to={`/growth/affiliates/${a.affiliate.id}`}>
              {a.affiliate.code}
            </Link>{' '}
            <StatusBadge status={a.affiliate.status} />
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">This user is not an affiliate.</p>
        )}
      </Card>
    </div>
  );
}

// ---- Page -----------------------------------------------------------------------------------

export default function UserDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const [merging, setMerging] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [tab, setTab] = useState('overview');
  const boot = useBootstrap();
  const moduleOn = (id: string) => Boolean(boot.data?.modules.find((m) => m.id === id)?.enabled);
  const accessEnabled = moduleOn('access');
  const mailingVisible = (moduleOn('marketing') && can('marketing.lists.view')) || (moduleOn('email') && can('email.autoresponders.view'));
  const notificationsOn = moduleOn('notifications');
  const q = useQuery({ queryKey: ['user', id], queryFn: () => api.get<UserDetail>(`/api/admin/users/${id}`) });
  const invalidate = [['user', id], ['users']];
  const archive = useAction((archived: boolean) => api.post(`/api/admin/users/${id}/${archived ? 'archive' : 'unarchive'}`, {}), {
    success: (_r, archived) => (archived ? 'User archived' : 'User restored from the archive'),
    invalidate,
  });

  const setStatus = useAction((body: { action: 'suspend' | 'ban' | 'reactivate'; reason?: string; until?: string }) => api.post(`/api/admin/users/${id}/status`, body), {
    success: (_r, v) => (v.action === 'reactivate' ? 'User reactivated' : v.action === 'ban' ? 'User banned' : 'User suspended'),
    invalidate,
  });
  const verify = useAction(() => api.post(`/api/admin/users/${id}/verify-email`), { success: 'Email marked as verified', invalidate });
  const reset = useAction(() => api.post<{ mode: 'email' | 'webhook' }>(`/api/admin/users/${id}/password-reset`), {
    success: (r) => (r.mode === 'email' ? 'Password reset email sent' : 'Your application was notified to send a reset (webhook)'),
  });
  const revokeAll = useAction(() => api.post<{ revoked: number }>(`/api/admin/users/${id}/revoke-sessions`), { success: (r) => `${r.revoked} session(s) signed out`, invalidate: [...invalidate, ['user-sessions', id]] });
  const remove = useAction(() => api.delete(`/api/admin/users/${id}`), { success: 'User deleted. You can restore it from this page.', invalidate });
  const restore = useAction(() => api.post(`/api/admin/users/${id}/restore`), { success: 'User restored', invalidate });
  const anonymize = useAction(() => api.post(`/api/admin/users/${id}/anonymize`, { confirm: 'ERASE' }), { success: 'Personal data erased', invalidate });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const u = q.data;
  const deleted = Boolean(u.deleted_at);
  const archived = Boolean(u.archived_at) && !deleted;
  const p = u.panels;

  const actions: MenuItem[] = [
    { label: 'Edit profile', icon: <Pencil className="size-4" />, onSelect: () => setEditing(true), hidden: !can('customers.users.edit') || deleted },
    { label: 'Merge a duplicate into this account…', icon: <Merge className="size-4" />, onSelect: () => setMerging(true), hidden: !can('customers.users.merge') || deleted },
    { label: 'Impersonate', icon: <Eye className="size-4" />, onSelect: () => setImpersonating(true), hidden: !can('customers.users.impersonate') || deleted || u.status !== 'active' },
    { label: 'Mark email verified', icon: <MailCheck className="size-4" />, onSelect: () => verify.mutate(), hidden: !can('customers.users.edit') || Boolean(u.email_verified_at) || deleted },
    { label: 'Send password reset', icon: <KeyRound className="size-4" />, onSelect: () => reset.mutate(), hidden: !can('customers.users.edit') || deleted },
    {
      label: 'Sign out everywhere',
      icon: <LogOut className="size-4" />,
      hidden: !can('customers.sessions.revoke') || deleted,
      onSelect: async () => {
        if ((await confirm({ title: 'Sign this user out of every session?', confirmLabel: 'Sign out' })).confirmed) revokeAll.mutate();
      },
    },
    {
      label: 'Export personal data',
      icon: <Download className="size-4" />,
      hidden: !can('customers.users.export'),
      onSelect: () => download(`/api/admin/users/${id}/export`, undefined, `user-${id}.json`).catch((err) => toast.error('Export failed', errorMessage(err))),
    },
    { separator: true, label: '' },
    {
      label: 'Archive',
      icon: <Archive className="size-4" />,
      hidden: !can('customers.users.edit') || deleted || archived,
      onSelect: async () => {
        if ((await confirm({ title: `Archive ${u.email}?`, description: 'The customer is hidden from the default user list. Nothing else changes: they can still sign in, which restores them.', confirmLabel: 'Archive' })).confirmed) archive.mutate(true);
      },
    },
    { label: 'Restore from archive', icon: <ArchiveRestore className="size-4" />, hidden: !can('customers.users.edit') || !archived, onSelect: () => archive.mutate(false) },
    {
      label: 'Suspend',
      icon: <ShieldAlert className="size-4" />,
      hidden: !can('customers.users.suspend') || u.status !== 'active' || deleted,
      onSelect: async () => {
        const r = await confirm({ title: `Suspend ${u.email}?`, description: 'The user cannot sign in or use the API until reactivated.', confirmLabel: 'Suspend', reason: { label: 'Reason (shown in the audit log)', required: true } });
        if (r.confirmed) setStatus.mutate({ action: 'suspend', reason: r.reason });
      },
    },
    {
      label: 'Ban',
      icon: <Ban className="size-4" />,
      danger: true,
      hidden: !can('customers.users.ban') || u.status === 'banned' || deleted,
      onSelect: async () => {
        const r = await confirm({ title: `Ban ${u.email}?`, description: 'Banning blocks access permanently and signs the user out.', tone: 'danger', confirmLabel: 'Ban user', reason: { label: 'Reason', required: true } });
        if (r.confirmed) setStatus.mutate({ action: 'ban', reason: r.reason });
      },
    },
    { label: 'Reactivate', icon: <RotateCcw className="size-4" />, hidden: !can('customers.users.suspend') || (u.status !== 'suspended' && u.status !== 'banned') || deleted, onSelect: () => setStatus.mutate({ action: 'reactivate' }) },
    {
      label: 'Delete',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !can('customers.users.delete') || deleted,
      onSelect: async () => {
        if ((await confirm({ title: `Delete ${u.email}?`, description: 'The account is deactivated and hidden from lists. You can restore it later, or erase its personal data permanently.', tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate();
      },
    },
    { label: 'Restore', icon: <RotateCcw className="size-4" />, hidden: !can('customers.users.delete') || !deleted || Boolean(u.anonymized_at) || Boolean(u.merged_into_id), onSelect: () => restore.mutate() },
    {
      label: 'Erase personal data…',
      icon: <UserX className="size-4" />,
      danger: true,
      hidden: !can('customers.users.delete') || Boolean(u.anonymized_at),
      onSelect: async () => {
        const r = await confirm({ title: 'Permanently erase personal data?', description: 'Name, email and profile data are irreversibly anonymized (GDPR erasure). Financial records are kept as required by law.', tone: 'danger', confirmLabel: 'Erase', typeToConfirm: 'ERASE' });
        if (r.confirmed) anonymize.mutate();
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Users', to: '/customers/users' }, { label: u.name || u.email }]}
        documentTitle={u.name || u.email}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={u.name} email={u.email} src={u.avatar_url} size="lg" />
            <span className="min-w-0">
              <span className="block truncate">{u.name || u.email}</span>
              {u.name && <span className="flex items-center gap-1 text-md font-normal text-muted-foreground"><span className="truncate">{u.email}</span><CopyButton value={u.email} label="Copy email" /></span>}
            </span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={u.merged_into_id ? 'merged' : deleted ? 'deleted' : u.status} />
            {archived && <StatusBadge status="archived" />}
            {u.plan && <Badge tone="primary">{u.plan.name}</Badge>}
            {u.activeImpersonation && <Badge tone="warning">being impersonated</Badge>}
            {u.status_reason && u.status !== 'active' && <span className="text-xs text-muted-foreground">Reason: {u.status_reason}</span>}
          </>
        }
        actions={
          <>
            {notificationsOn && can('notifications.messages.send') && !deleted && (
              <Button variant="outline" icon={<Send className="size-4" />} onClick={() => setNotifying(true)}>
                Send notification
              </Button>
            )}
            {can('customers.users.edit') && !deleted && (
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={actions} />
          </>
        }
      />
      {deleted && u.merged_into_id ? (
        <div className="mb-4">
          <Callout tone="info" title="This account was merged into another">
            Merged {dateTime(u.merged_at)} into{' '}
            <Link className="text-primary hover:underline" to={`/customers/users/${u.merged_into_id}`}>
              {u.mergedInto ? u.mergedInto.name || u.mergedInto.email : 'the kept account'}
            </Link>
            , which now holds its subscriptions, billing, history and sessions.
          </Callout>
        </div>
      ) : deleted ? (
        <div className="mb-4">
          <Callout tone="danger" title={u.anonymized_at ? 'Personal data erased' : 'This user is deleted'}>
            {u.anonymized_at ? `Anonymized ${dateTime(u.anonymized_at)}.` : `Deleted ${dateTime(u.deleted_at)}. Restore it from the actions menu.`}
          </Callout>
        </div>
      ) : null}
      {archived && (
        <div className="mb-4">
          <Callout
            tone="info"
            title="Archived"
            action={
              can('customers.users.edit') && (
                <Button size="sm" variant="outline" loading={archive.isPending} onClick={() => archive.mutate(false)}>
                  Restore
                </Button>
              )
            }
          >
            {u.archived_reason === 'inactive' ? 'Archived automatically after a long period without activity' : 'Archived by an administrator'} on {dateTime(u.archived_at)}. Hidden from the default user list; signing in restores the account.
          </Callout>
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview', content: <OverviewTab user={u} /> },
          { value: 'billing', label: 'Billing', hidden: !p.billing, content: p.billing && <BillingTab user={u} /> },
          { value: 'usage', label: 'Usage & credits', hidden: !p.usage, content: p.usage && <UsageTab user={u} /> },
          { value: 'access', label: 'Plan & access', hidden: !can('catalog.entitlements.view') || deleted, content: tab === 'access' && <EntitlementsPanel subject={{ userId: u.id }} /> },
          {
            value: 'groups-content',
            label: 'Groups & content',
            hidden: deleted || !accessEnabled || !(can('customers.groups.view') || can('access.resources.view')),
            content: tab === 'groups-content' && <UserAccessPanel userId={u.id} />,
          },          { value: 'activity', label: 'Activity', content: tab === 'activity' && <TimelineTab userId={u.id} /> },
          { value: 'notes', label: 'Notes', hidden: !can('customers.notes.view'), count: u.notesCount, content: tab === 'notes' && <NotesTab userId={u.id} /> },
          { value: 'security', label: 'Sessions & sign-ins', content: tab === 'security' && <SecurityTab user={u} /> },
          { value: 'support', label: 'Support', hidden: !p.support, count: p.support?.open || undefined, content: p.support && <SupportTab user={u} /> },
          { value: 'email', label: 'Email', hidden: !p.email, content: p.email && <EmailTab user={u} /> },
          { value: 'mailing', label: 'Lists & autoresponders', hidden: deleted || !mailingVisible, content: tab === 'mailing' && <UserMailingPanel userId={u.id} /> },
          {
            value: 'notifications',
            label: 'Notifications',
            hidden: deleted || !notificationsOn || !can('notifications.messages.view'),
            content: tab === 'notifications' && <UserNotificationsPanel userId={u.id} canSend={can('notifications.messages.send')} onSend={() => setNotifying(true)} />,
          },
          { value: 'affiliate', label: 'Referral', hidden: !p.affiliates, content: p.affiliates && <AffiliateTab user={u} /> },
        ]}
      />
      {editing && <EditUserDialog user={u} open={editing} onOpenChange={setEditing} />}
      <ImpersonateDialog user={u} open={impersonating} onOpenChange={setImpersonating} />
      {notifying && <SendNotificationDialog user={{ id: u.id, email: u.email, name: u.name }} open={notifying} onOpenChange={setNotifying} />}
      {merging && <MergeUsersDialog user={{ id: u.id, email: u.email, name: u.name, createdAt: u.created_at }} open={merging} onOpenChange={setMerging} />}
    </>
  );
}
