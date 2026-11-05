import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { fromMinor, money, num, pct, toMinor } from '../../lib/format';
import { useBootstrap } from '../../components/layout/AppShell';
import {
  Button,
  Callout,
  Card,
  ChartCard,
  Checkbox,
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
  Select,
  Switch,
  Tabs,
  Textarea,
  useConfirm,
} from '../../components/ui';
import { AffiliatesTable, CommissionsTable, GroupsPanel, MaterialsPanel, PayoutsTable, ReferralsTable, type AffiliateRow } from './affiliate-lists';
import { CommissionOverrideFields, UplineRatesField, commissionOverrideBody } from './affiliate-forms';
import { MoneyList, PeriodPicker, UserPicker, dayKey, useBaseCurrency, useSaveSettings, useSettingsSection, useTabParam } from './shared';

// ---- Overview (performance report) ------------------------------------------------------------

interface Report {
  from: string;
  to: string;
  totals: { clicks: number; signups: number; conversions: number };
  affiliates: { id: string; name: string; code: string; clicks: number; signups: number; conversions: number; conversionRate: number | null; money: { currency: string; revenue: number; commissions: number }[] }[];
  daily: { day: string; clicks: number; signups: number; conversions: number }[];
}

const METRICS = [
  { key: 'clicks', label: 'Clicks' },
  { key: 'signups', label: 'Signups' },
  { key: 'conversions', label: 'Conversions' },
] as const;
type Metric = (typeof METRICS)[number]['key'];

const OVERVIEW_DEFAULTS = { days: 30, metric: 'signups' };

function ProgramOverview({ onOpenApplications, pending }: { onOpenApplications: () => void; pending: number }) {
  const [state, setState] = useUrlState(OVERVIEW_DEFAULTS);
  const days = Number(state.days) || 30;
  const metric = (METRICS.some((m) => m.key === state.metric) ? state.metric : 'signups') as Metric;
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
  }, [days]);
  const report = useQuery({
    queryKey: ['affiliate-report', days],
    queryFn: ({ signal }) => api.get<Report>('/api/admin/affiliate-report', range, signal),
    placeholderData: keepPreviousData,
  });

  if (report.isLoading) return <PageSkeleton />;
  if (report.error || !report.data) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const r = report.data;
  const fetching = report.isFetching && !report.isLoading;
  const label = METRICS.find((m) => m.key === metric)!.label;
  const series = r.daily.map((d) => ({ date: dayKey(d.day), value: d[metric] }));
  const active = r.affiliates.filter((a) => a.clicks || a.signups || a.conversions || a.money.length);

  return (
    <div className="space-y-4">
      {pending > 0 && (
        <Callout
          tone="info"
          title={`${pending} application${pending === 1 ? '' : 's'} waiting for review`}
          action={
            <Button size="sm" variant="outline" onClick={onOpenApplications}>
              Review
            </Button>
          }
        />
      )}
      <div className="flex justify-end">
        <PeriodPicker days={days} onChange={(d) => setState({ days: d })} />
      </div>
      <div className={clsx('grid grid-cols-1 gap-3 transition-opacity min-[420px]:grid-cols-2 lg:grid-cols-4', fetching && 'opacity-60')}>
        <KpiTile label="Link clicks" value={r.totals.clicks} display={num(r.totals.clicks)} />
        <KpiTile label="Referred signups" value={r.totals.signups} display={num(r.totals.signups)} />
        <KpiTile label="Paying customers" value={r.totals.conversions} display={num(r.totals.conversions)} />
        <KpiTile label="Click to customer" value={r.totals.clicks ? r.totals.conversions / r.totals.clicks : 0} display={r.totals.clicks ? pct(r.totals.conversions / r.totals.clicks) : '—'} />
      </div>
      <ChartCard
        title={`${label} per day`}
        description="Across all affiliates"
        data={series}
        format={(v) => num(v)}
        fetching={fetching}
        actions={
          <div role="radiogroup" aria-label="Metric" className="mr-1 inline-flex rounded-ui-sm border p-0.5">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={metric === m.key}
                onClick={() => setState({ metric: m.key }, { resetPage: false })}
                className={clsx('rounded-[calc(var(--radius)-3px)] px-2 py-0.5 text-xs font-medium', metric === m.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      >
        <ColumnChart data={series} format={(v) => num(v)} label={`${label} per day`} />
      </ChartCard>
      <Card title="Affiliate performance" description="For the selected period" padded={false}>
        <DataTable
          caption="Affiliate performance"
          rows={active}
          rowKey={(a) => a.id}
          rowHref={(a) => `/growth/affiliates/${a.id}`}
          fetching={fetching}
          empty={<EmptyState title="No affiliate activity in this period" />}
          columns={[
            { key: 'name', header: 'Affiliate', cell: (a) => <>{a.name} <span className="font-mono text-xs font-normal text-muted-foreground">{a.code}</span></> },
            { key: 'clicks', header: 'Clicks', align: 'right', cell: (a) => <span className="tabular">{num(a.clicks)}</span> },
            { key: 'signups', header: 'Signups', align: 'right', cell: (a) => <span className="tabular">{num(a.signups)}</span> },
            { key: 'conversions', header: 'Customers', align: 'right', cell: (a) => <span className="tabular">{num(a.conversions)}</span> },
            { key: 'rate', header: 'Conversion', align: 'right', priority: 'low', cell: (a) => (a.conversionRate === null ? '—' : pct(a.conversionRate)) },
            { key: 'revenue', header: 'Revenue', align: 'right', cell: (a) => <MoneyList items={a.money.map((m) => ({ currency: m.currency, amount: m.revenue }))} /> },
            { key: 'commissions', header: 'Commissions', align: 'right', cell: (a) => <MoneyList items={a.money.map((m) => ({ currency: m.currency, amount: m.commissions }))} /> },
          ]}
        />
      </Card>
    </div>
  );
}

// ---- Tiers --------------------------------------------------------------------------------------

interface Tier {
  id: string;
  name: string;
  metric: 'revenue' | 'conversions';
  threshold: number;
  rate_bps: number;
}

function TierDialog({ tier, open, onOpenChange, currency }: { tier: Tier | null; open: boolean; onOpenChange: (o: boolean) => void; currency: string }) {
  const [form, setForm] = useState(() => ({
    name: tier?.name ?? '',
    metric: tier?.metric ?? 'conversions',
    threshold: tier ? (tier.metric === 'revenue' ? fromMinor(tier.threshold, currency) : String(tier.threshold)) : '',
    rate: tier ? String(tier.rate_bps / 100) : '',
  }));
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      const threshold = form.metric === 'revenue' ? toMinor(form.threshold, currency) : Math.round(Number(form.threshold));
      const body = { name: form.name, metric: form.metric, threshold: threshold ?? 0, ratePercent: Number(form.rate) };
      return tier ? api.patch(`/api/admin/affiliate-tiers/${tier.id}`, body) : api.post('/api/admin/affiliate-tiers', body);
    },
    { success: tier ? 'Tier updated' : 'Tier created', invalidate: [['affiliate-tiers']], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={tier ? 'Edit tier' : 'New tier'}
      description="Affiliates move up automatically once their lifetime results reach the threshold."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="tier-form" loading={save.isPending}>
            {tier ? 'Save tier' : 'Create tier'}
          </Button>
        </>
      }
    >
      <form
        id="tier-form"
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
        <Field label="Name" htmlFor="tier-name" className="sm:col-span-2">
          <Input id="tier-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Gold" required maxLength={80} />
        </Field>
        <Field label="Based on" htmlFor="tier-metric">
          <Select id="tier-metric" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as Tier['metric'], threshold: '' })} options={[{ value: 'conversions', label: 'Paying customers referred' }, { value: 'revenue', label: `Referred revenue (${currency})` }]} />
        </Field>
        <Field label="Threshold" htmlFor="tier-threshold" hint={form.metric === 'revenue' ? `Lifetime referred revenue in ${currency}` : 'Lifetime referred paying customers'}>
          <Input id="tier-threshold" type="number" min={0} step={form.metric === 'revenue' ? '0.01' : '1'} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} required />
        </Field>
        <Field label="Commission rate (%)" htmlFor="tier-rate" hint="Replaces the default percentage for affiliates in this tier">
          <Input id="tier-rate" type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} required />
        </Field>
      </form>
    </Modal>
  );
}

function TiersPanel({ currency }: { currency: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Tier | 'new' | null>(null);
  const tiers = useQuery({ queryKey: ['affiliate-tiers'], queryFn: () => api.get<{ data: Tier[] }>('/api/admin/affiliate-tiers') });
  const remove = useAction((id: string) => api.delete(`/api/admin/affiliate-tiers/${id}`), { success: 'Tier deleted', invalidate: [['affiliate-tiers']] });
  const manage = can('affiliates.program.manage');
  return (
    <div className="space-y-4">
      <Callout title="How rates are chosen">An affiliate's own commission override wins; otherwise the best tier they qualify for; otherwise the program default.</Callout>
      <Card
        title="Commission tiers"
        padded={false}
        actions={
          manage && (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New tier
            </Button>
          )
        }
      >
        {tiers.error ? (
          <ErrorState error={tiers.error} onRetry={() => void tiers.refetch()} />
        ) : (
          <DataTable
            caption="Commission tiers"
            rows={tiers.data?.data}
            loading={tiers.isLoading}
            rowKey={(t) => t.id}
            empty={<EmptyState title="No tiers" description="Reward your best partners with higher rates once they reach a threshold." />}
            columns={[
              { key: 'name', header: 'Tier', cell: (t) => <span className="font-medium">{t.name}</span> },
              { key: 'threshold', header: 'Reached at', cell: (t) => (t.metric === 'revenue' ? `${money(t.threshold, currency)} referred revenue` : `${num(t.threshold)} paying customers`) },
              { key: 'rate', header: 'Rate', align: 'right', cell: (t) => <span className="tabular">{t.rate_bps / 100}%</span> },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: '',
                      align: 'right' as const,
                      cell: (t: Tier) => (
                        <span className="inline-flex gap-1">
                          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete ${t.name}`}
                            onClick={async () => {
                              if ((await confirm({ title: `Delete the ${t.name} tier?`, description: 'Affiliates in it fall back to the next tier they qualify for, or the default rate.', tone: 'danger', confirmLabel: 'Delete tier' })).confirmed) remove.mutate(t.id);
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Card>
      {editing && <TierDialog key={editing === 'new' ? 'new' : editing.id} tier={editing === 'new' ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} currency={currency} />}
    </div>
  );
}

// ---- Program settings ---------------------------------------------------------------------------

interface ProgramSettingsValue {
  autoApprove: boolean;
  cookieDays: number;
  attribution: 'first_click' | 'last_click';
  commissionType: 'percent' | 'fixed';
  defaultRateBps: number;
  defaultFixedAmount: number;
  fixedCurrency: string;
  recurring: boolean;
  recurringMonths: number;
  holdDays: number;
  minPayout: number;
  payoutApprovalThreshold: number;
  landingUrl: string;
  allowedRedirectHosts: string[];
  signupVelocityThreshold: number;
  conversionVelocityPerHour: number;
  clickRetentionDays: number;
  termsUrl: string;
  /** Upline shares by level (level 2 first), in basis points of the sale. */
  uplineRatesBps: number[];
  /** Commissions on an affiliate's own purchases: held for review, or never created. */
  ownPurchases: 'review' | 'never';
}

function ProgramSettingsForm({ initial, canEdit }: { initial: ProgramSettingsValue; canEdit: boolean }) {
  const toForm = (v: ProgramSettingsValue) => ({
    ...v,
    rate: String(v.defaultRateBps / 100),
    fixed: fromMinor(v.defaultFixedAmount, v.fixedCurrency),
    min: fromMinor(v.minPayout, v.fixedCurrency),
    threshold: fromMinor(v.payoutApprovalThreshold, v.fixedCurrency),
    hosts: v.allowedRedirectHosts.join('\n'),
    upline: (v.uplineRatesBps ?? []).map((bps) => String(bps / 100)),
    ownPurchases: v.ownPurchases ?? 'review',
  });
  const [form, setForm] = useState(() => toForm(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useSaveSettings('affiliates', {
    onSuccess: () => setErrors({}),
    onError: (e) => {
      setError(errorMessage(e));
      if (e instanceof ApiError) setErrors(e.fieldErrors());
    },
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const currency = form.fixedCurrency.toUpperCase();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const value: ProgramSettingsValue = {
      autoApprove: form.autoApprove,
      cookieDays: Number(form.cookieDays),
      attribution: form.attribution,
      commissionType: form.commissionType,
      defaultRateBps: Math.round(Number(form.rate) * 100),
      defaultFixedAmount: toMinor(form.fixed, currency) ?? 0,
      fixedCurrency: currency,
      recurring: form.recurring,
      recurringMonths: Number(form.recurringMonths),
      holdDays: Number(form.holdDays),
      minPayout: toMinor(form.min, currency) ?? 0,
      payoutApprovalThreshold: toMinor(form.threshold, currency) ?? 0,
      landingUrl: form.landingUrl.trim(),
      allowedRedirectHosts: form.hosts.split(/\n|,/).map((h) => h.trim()).filter(Boolean),
      signupVelocityThreshold: Number(form.signupVelocityThreshold),
      conversionVelocityPerHour: Number(form.conversionVelocityPerHour),
      clickRetentionDays: Number(form.clickRetentionDays),
      termsUrl: form.termsUrl.trim(),
      uplineRatesBps: form.upline.map((rate) => Math.round(Number(rate) * 100)),
      ownPurchases: form.ownPurchases,
    };
    save.mutate(value as unknown as Record<string, unknown>);
  };

  const numberField = (key: 'cookieDays' | 'recurringMonths' | 'holdDays' | 'signupVelocityThreshold' | 'conversionVelocityPerHour' | 'clickRetentionDays', label: string, hint?: string, min = 0) => (
    <Field label={label} hint={hint} error={errors[key]} htmlFor={`ps-${key}`}>
      <Input id={`ps-${key}`} type="number" min={min} step={1} value={String(form[key])} onChange={(e) => set(key, Number(e.target.value))} disabled={!canEdit} invalid={Boolean(errors[key])} />
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {!canEdit && <Callout>You can view these settings. Changing them needs the “manage affiliates” permission.</Callout>}
      <FormError message={error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Applications">
          <div className="space-y-4">
            <Switch checked={form.autoApprove} onCheckedChange={(v) => set('autoApprove', v)} disabled={!canEdit} label="Approve applications automatically" description="Off: every application waits for review here." />
            <Field label="Program terms URL" hint="Shown to applicants, who must accept the terms" error={errors.termsUrl} htmlFor="ps-terms">
              <Input id="ps-terms" type="url" value={form.termsUrl} onChange={(e) => set('termsUrl', e.target.value)} disabled={!canEdit} placeholder="https://example.com/affiliate-terms" />
            </Field>
          </div>
        </Card>
        <Card title="Attribution">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" htmlFor="ps-attr" hint="Which affiliate wins when a visitor clicked several links">
              <Select id="ps-attr" value={form.attribution} onChange={(e) => set('attribution', e.target.value as ProgramSettingsValue['attribution'])} disabled={!canEdit} options={[{ value: 'last_click', label: 'Last click' }, { value: 'first_click', label: 'First click' }]} />
            </Field>
            {numberField('cookieDays', 'Attribution window (days)', 'How long a click can still earn a referral', 1)}
            <Field label="Landing URL" hint="Where tracking links send visitors (defaults to your app URL)" error={errors.landingUrl} htmlFor="ps-landing" className="sm:col-span-2">
              <Input id="ps-landing" type="url" value={form.landingUrl} onChange={(e) => set('landingUrl', e.target.value)} disabled={!canEdit} placeholder="https://www.example.com" />
            </Field>
            <Field label="Allowed redirect hosts" hint="Other hosts a link may send visitors to with ?to=, one per line. Everything else stays on your site." error={errors.allowedRedirectHosts} htmlFor="ps-hosts" className="sm:col-span-2">
              <Textarea id="ps-hosts" rows={3} value={form.hosts} onChange={(e) => set('hosts', e.target.value)} disabled={!canEdit} placeholder="www.example.com" />
            </Field>
          </div>
        </Card>
        <Card title="Commission terms" description="Defaults; tiers and per-affiliate overrides can change them">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Commission" htmlFor="ps-type">
              <Select id="ps-type" value={form.commissionType} onChange={(e) => set('commissionType', e.target.value as ProgramSettingsValue['commissionType'])} disabled={!canEdit} options={[{ value: 'percent', label: 'Percentage of each payment' }, { value: 'fixed', label: 'Fixed amount per paid invoice' }]} />
            </Field>
            {form.commissionType === 'percent' ? (
              <Field label="Rate (%)" error={errors.defaultRateBps} htmlFor="ps-rate">
                <Input id="ps-rate" type="number" min={0} max={100} step="0.01" value={form.rate} onChange={(e) => set('rate', e.target.value)} disabled={!canEdit} />
              </Field>
            ) : (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label="Amount" error={errors.defaultFixedAmount} htmlFor="ps-fixed">
                  <Input id="ps-fixed" type="number" min={0} step="0.01" value={form.fixed} onChange={(e) => set('fixed', e.target.value)} disabled={!canEdit} />
                </Field>
                <Field label="Currency" error={errors.fixedCurrency} htmlFor="ps-cur">
                  <Input id="ps-cur" value={form.fixedCurrency} onChange={(e) => set('fixedCurrency', e.target.value.toUpperCase().slice(0, 3))} disabled={!canEdit} maxLength={3} />
                </Field>
              </div>
            )}
            <div className="sm:col-span-2">
              <Switch checked={form.recurring} onCheckedChange={(v) => set('recurring', v)} disabled={!canEdit} label="Recurring commissions" description="Also pay on renewals, not only the first payment." />
            </div>
            {form.recurring && numberField('recurringMonths', 'For how many months', '0 = for the customer’s lifetime')}
          </div>
        </Card>
        <Card title="Payouts">
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField('holdDays', 'Hold period (days)', 'Commissions become payable after the refund window')}
            <Field label={`Minimum payout (${currency})`} hint="Smallest balance that can be paid out" error={errors.minPayout} htmlFor="ps-min">
              <Input id="ps-min" type="number" min={0} step="0.01" value={form.min} onChange={(e) => set('min', e.target.value)} disabled={!canEdit} />
            </Field>
            <Field label={`Second approval from (${currency})`} hint="Payouts at or above this need another administrator; 0 turns it off" error={errors.payoutApprovalThreshold} htmlFor="ps-threshold" className="sm:col-span-2">
              <Input id="ps-threshold" type="number" min={0} step="0.01" value={form.threshold} onChange={(e) => set('threshold', e.target.value)} disabled={!canEdit} />
            </Field>
          </div>
        </Card>
        <Card title="Multi-level commissions" description="Recruiters earn a share of every sale their recruits make, on top of the referring affiliate’s commission">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Level 2 is the affiliate who recruited the one who made the sale, level 3 their recruiter, and so on. Each rate is a share of the same sale, with the same hold period and review; refunds and chargebacks reverse every level. Own purchases follow the rule under Fraud signals at every level.
            </p>
            <FormError message={Object.entries(errors).find(([key]) => key.startsWith('uplineRatesBps'))?.[1]} />
            <UplineRatesField rates={form.upline} onChange={(rates) => set('upline', rates)} disabled={!canEdit} />
          </div>
        </Card>
        <Card title="Fraud signals" description="Suspicious referrals are flagged and their commissions held for review, never silently blocked">
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField('signupVelocityThreshold', 'Signups from one network', 'Within an hour, before referrals are flagged', 2)}
            {numberField('conversionVelocityPerHour', 'Conversions per hour', 'Per affiliate, before conversions are flagged', 2)}
            {numberField('clickRetentionDays', 'Keep click data (days)', 'Older clicks are deleted', 30)}
            <Field label="Affiliates’ own purchases" hint="When an affiliate buys through their own link or code" error={errors.ownPurchases} htmlFor="ps-own">
              <Select
                id="ps-own"
                value={form.ownPurchases}
                onChange={(e) => set('ownPurchases', e.target.value as ProgramSettingsValue['ownPurchases'])}
                disabled={!canEdit}
                options={[{ value: 'review', label: 'Hold their commission for review' }, { value: 'never', label: 'Pay no commission' }]}
              />
            </Field>
          </div>
        </Card>
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save program settings
          </Button>
        </div>
      )}
    </form>
  );
}

function ProgramSettings() {
  const { can } = useAuth();
  const settings = useSettingsSection('affiliates');
  if (!settings.allowed) return <Callout title="Settings access needed">Viewing program settings requires permission to view system settings.</Callout>;
  if (settings.isLoading) return <PageSkeleton />;
  if (settings.error || !settings.section) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  return <ProgramSettingsForm key={JSON.stringify(settings.section.value)} initial={settings.section.value as unknown as ProgramSettingsValue} canEdit={can('affiliates.program.manage')} />;
}

// ---- Add affiliate ------------------------------------------------------------------------------

function AddAffiliateDialog({ open, onOpenChange, currency }: { open: boolean; onOpenChange: (o: boolean) => void; currency: string }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', name: '', code: '', website: '', payoutMethod: '', notes: '', commissionType: '', rate: '', fixed: '', recurring: '', recurringMonths: '' });
  const [user, setUser] = useState<{ id: string; email: string; name?: string | null } | null>(null);
  const [linkUser, setLinkUser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<{ id: string }>('/api/admin/affiliates', {
        email: form.email,
        name: form.name,
        userId: linkUser ? user?.id : undefined,
        code: form.code || undefined,
        website: form.website || undefined,
        payoutMethod: form.payoutMethod || undefined,
        notes: form.notes || undefined,
        ...commissionOverrideBody(form, currency),
      }),
    {
      success: 'Affiliate added and approved',
      invalidate: [['affiliates']],
      onSuccess: (a) => {
        onOpenChange(false);
        navigate(`/growth/affiliates/${a.id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add an affiliate"
      description="Partners you add here are approved immediately. Customers can also apply from your app."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-affiliate" loading={create.isPending}>
            Add affiliate
          </Button>
        </>
      }
    >
      <form
        id="add-affiliate"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
        <Field label="Name" htmlFor="af-name" required>
          <Input id="af-name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} autoFocus />
        </Field>
        <Field label="Email" htmlFor="af-email" required>
          <Input id="af-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
        </Field>
        <Field label="Referral code" htmlFor="af-code" hint="3-32 letters, numbers, dashes; generated when empty">
          <Input id="af-code" value={form.code} onChange={(e) => set('code', e.target.value)} maxLength={32} className="font-mono" />
        </Field>
        <Field label="Website" htmlFor="af-web">
          <Input id="af-web" value={form.website} onChange={(e) => set('website', e.target.value)} maxLength={500} placeholder="https://" />
        </Field>
        <Field label="Payout method" htmlFor="af-method" hint="How you pay them (bank transfer, PayPal…)">
          <Input id="af-method" value={form.payoutMethod} onChange={(e) => set('payoutMethod', e.target.value)} maxLength={50} />
        </Field>
        <Field label="Internal notes" htmlFor="af-notes">
          <Input id="af-notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox checked={linkUser} onChange={(e) => setLinkUser(e.target.checked)} label="Link to an existing customer account" description="Lets them see their stats in your app’s affiliate portal." />
          {linkUser && <UserPicker value={user} onChange={setUser} />}
        </div>
        <CommissionOverrideFields form={form} set={set} currency={currency} />
      </form>
    </Modal>
  );
}

// ---- Page --------------------------------------------------------------------------------------

export default function AffiliatesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const boot = useBootstrap();
  const [tab, setTab] = useTabParam('overview');
  const [adding, setAdding] = useState(false);
  const program = useSettingsSection('affiliates');
  const baseCurrency = useBaseCurrency();
  const fixedCurrency = String(program.section?.value.fixedCurrency ?? boot.data?.locale.currency ?? 'USD');
  const pending = useQuery({
    queryKey: ['affiliates', { status: 'pending', count: true }],
    queryFn: () => api.get<Page<AffiliateRow>>('/api/admin/affiliates', { status: 'pending', pageSize: 1 }),
    refetchInterval: 60_000,
  });
  const pendingCount = pending.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Affiliates"
        description="Partners who refer customers: applications, referrals, commissions and payouts."
        actions={
          can('affiliates.program.manage') && (
            <Button icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
              Add affiliate
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview', content: <ProgramOverview pending={pendingCount} onOpenApplications={() => setTab('applications')} /> },
          { value: 'affiliates', label: 'Affiliates', content: <AffiliatesTable /> },
          { value: 'applications', label: 'Applications', count: pendingCount, content: <AffiliatesTable applications /> },
          { value: 'referrals', label: 'Referrals', content: <ReferralsTable /> },
          { value: 'commissions', label: 'Commissions', content: <CommissionsTable /> },
          { value: 'payouts', label: 'Payouts', content: <PayoutsTable /> },
          { value: 'materials', label: 'Materials', content: <MaterialsPanel /> },
          { value: 'tiers', label: 'Tiers', content: <TiersPanel currency={baseCurrency} /> },
          { value: 'groups', label: 'Groups', content: <GroupsPanel onShowMembers={(groupId) => navigate(`/growth/affiliates?tab=affiliates&group=${groupId}`)} /> },
          { value: 'settings', label: 'Program settings', hidden: !can('system.settings.view'), content: <ProgramSettings /> },
        ]}
      />
      {adding && <AddAffiliateDialog open={adding} onOpenChange={setAdding} currency={fixedCurrency} />}
      <p className="mt-6 text-xs text-muted-foreground">
        Tracking links look like <code className="rounded bg-muted px-1 font-mono">{window.location.origin}/r/CODE</code>. Customers attributed through them are listed under{' '}
        <Link to="/growth/affiliates?tab=referrals" className="text-primary hover:underline">
          Referrals
        </Link>
        .
      </p>
    </>
  );
}
