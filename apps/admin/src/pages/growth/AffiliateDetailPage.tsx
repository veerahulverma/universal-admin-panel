import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CircleCheck, KeyRound, MoreHorizontal, Pencil, PlusCircle, RotateCcw, Wallet, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, fromMinor, money, num, toMinor } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  KpiTile,
  Menu,
  Modal,
  Mono,
  PageHeader,
  Select,
  PageSkeleton,
  Tabs,
  Textarea,
  When,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { AffiliateMaterialsList, CommissionsTable, PayoutsTable, RecruitsTable, ReferralsTable, SubIdReport, useAffiliateGroups } from './affiliate-lists';
import { AffiliatePicker, CommissionOverrideFields, commissionOverrideBody, type AffiliateOption } from './affiliate-forms';
import { StatusPill, useTabParam } from './shared';

interface AffiliateDetail {
  id: string;
  userId: string | null;
  email: string;
  name: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  statusReason: string | null;
  commissionType: 'percent' | 'fixed' | null;
  ratePercent: number | null;
  fixedAmount: number | null;
  recurring: boolean | null;
  recurringMonths: number | null;
  tierId: string | null;
  groupId: string | null;
  parentId: string | null;
  parentSource: 'referral' | 'admin' | null;
  website: string | null;
  promotionMethod: string | null;
  payoutMethod: string | null;
  notes: string | null;
  termsAcceptedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  stats: { clicks: number; uniqueVisitors: number; signups: number; conversions: number; flagged: number; earnings: { currency: string; pending: number; approved: number; paid: number }[] };
  terms: { type: 'percent' | 'fixed'; rateBps: number; ratePercent: number; fixedAmount: number; fixedCurrency: string; recurring: boolean; recurringMonths: number; tierId: string | null };
  tier: { id: string; name: string; rate_bps: number } | null;
  group: { id: string; name: string } | null;
  /** Recruiter first (level 2); ratePercent is null where multi-level commissions do not pay. */
  upline: { level: number; id: string; name: string; code: string; status: string; ratePercent: number | null }[];
  network: { recruits: number; earnings: { level: number; currency: string; amount: number }[] };
  payable: { currency: string; payable: number }[];
  sensitive: { name: string; last4: string | null; updatedAt: string }[];
}

type PayoutResult = { status: 'created'; payout: { id: string; amount: number; currency: string } } | { status: 'requires_approval'; approvalId: string };

function EditAffiliateDialog({ aff, open, onOpenChange }: { aff: AffiliateDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const currency = aff.terms.fixedCurrency;
  const groups = useAffiliateGroups();
  const recruiter = aff.upline.find((u) => u.level === 2);
  const [form, setForm] = useState({
    name: aff.name,
    code: aff.code,
    website: aff.website ?? '',
    payoutMethod: aff.payoutMethod ?? '',
    notes: aff.notes ?? '',
    groupId: aff.groupId ?? '',
    commissionType: aff.commissionType ?? '',
    rate: aff.ratePercent === null ? '' : String(aff.ratePercent),
    fixed: aff.fixedAmount === null ? '' : fromMinor(aff.fixedAmount, currency),
    recurring: aff.recurring === null ? '' : aff.recurring ? 'yes' : 'no',
    recurringMonths: aff.recurringMonths === null ? '' : String(aff.recurringMonths),
  });
  const [upline, setUpline] = useState<AffiliateOption | null>(recruiter ? { id: recruiter.id, name: recruiter.name, code: recruiter.code } : null);
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      api.patch(`/api/admin/affiliates/${aff.id}`, {
        name: form.name,
        code: form.code,
        website: form.website || null,
        payoutMethod: form.payoutMethod || null,
        notes: form.notes || null,
        groupId: form.groupId || null,
        parentId: upline?.id ?? null,
        ...commissionOverrideBody(form, currency),
      }),
    { success: 'Affiliate updated', invalidate: [['affiliate'], ['affiliates']], onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
  );
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit affiliate"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-affiliate" loading={save.isPending}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        id="edit-affiliate"
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
        <Field label="Name" htmlFor="ea-name">
          <Input id="ea-name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} />
        </Field>
        <Field label="Referral code" htmlFor="ea-code" hint="Changing it breaks links already shared">
          <Input id="ea-code" value={form.code} onChange={(e) => set('code', e.target.value)} required maxLength={32} className="font-mono" />
        </Field>
        <Field label="Website" htmlFor="ea-web">
          <Input id="ea-web" value={form.website} onChange={(e) => set('website', e.target.value)} maxLength={500} />
        </Field>
        <Field label="Payout method" htmlFor="ea-method">
          <Input id="ea-method" value={form.payoutMethod} onChange={(e) => set('payoutMethod', e.target.value)} maxLength={50} />
        </Field>
        <Field label="Group" htmlFor="ea-group" hint="Decides which marketing materials they see">
          <Select id="ea-group" value={form.groupId} onChange={(e) => set('groupId', e.target.value)} placeholder="No group" options={(groups.data?.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
        </Field>
        <Field label="Recruited by" htmlFor="ea-upline" hint="Earns multi-level commissions on this affiliate’s sales">
          <AffiliatePicker id="ea-upline" value={upline} onChange={setUpline} exclude={aff.id} />
        </Field>
        <Field label="Internal notes" htmlFor="ea-notes" className="sm:col-span-2">
          <Textarea id="ea-notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} />
        </Field>
        <CommissionOverrideFields form={form} set={set} currency={currency} />
      </form>
    </Modal>
  );
}

function AdjustmentDialog({ aff, open, onOpenChange }: { aff: AffiliateDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ direction: 'credit', amount: '', currency: aff.payable[0]?.currency ?? aff.terms.fixedCurrency, reason: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => {
      const minor = toMinor(form.amount, form.currency) ?? 0;
      return api.post(`/api/admin/affiliates/${aff.id}/adjustments`, { amount: form.direction === 'credit' ? minor : -minor, currency: form.currency, reason: form.reason });
    },
    {
      success: 'Adjustment recorded and approved',
      invalidate: [['affiliate', aff.id], ['affiliate-commissions'], ['affiliates']],
      onSuccess: () => onOpenChange(false),
      onError: (e) => setError(errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Manual adjustment"
      description="A bonus or a correction. It is approved immediately and recorded in the audit log."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="adjust-form" loading={save.isPending}>
            Record adjustment
          </Button>
        </>
      }
    >
      <form
        id="adjust-form"
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div className="sm:col-span-3">
          <FormError message={error} />
        </div>
        <Field label="Type" htmlFor="adj-dir">
          <Select id="adj-dir" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} options={[{ value: 'credit', label: 'Add (bonus)' }, { value: 'debit', label: 'Subtract (correction)' }]} />
        </Field>
        <Field label="Amount" htmlFor="adj-amount">
          <Input id="adj-amount" type="number" min={0.01} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
        </Field>
        <Field label="Currency" htmlFor="adj-cur">
          <Input id="adj-cur" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase().slice(0, 3) })} maxLength={3} required />
        </Field>
        <Field label="Reason" htmlFor="adj-reason" className="sm:col-span-3" hint="Visible in the commission list">
          <Input id="adj-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} minLength={3} maxLength={500} required />
        </Field>
      </form>
    </Modal>
  );
}

function PayoutDetailsDialog({ aff, open, onOpenChange }: { aff: AffiliateDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [payoutDetails, setPayoutDetails] = useState('');
  const [taxInfo, setTaxInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () => api.put(`/api/admin/affiliates/${aff.id}/payout-details`, { payoutDetails: payoutDetails || undefined, taxInfo: taxInfo || undefined }),
    {
      success: 'Payout details replaced',
      invalidate: [['affiliate', aff.id]],
      onSuccess: () => {
        setPayoutDetails('');
        setTaxInfo('');
        onOpenChange(false);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Replace payout details"
      description="Stored encrypted and never shown again; only the last four characters are displayed. Leave a field empty to keep the current value."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!payoutDetails && !taxInfo} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={error} />
        <Field label="Payout details" htmlFor="pd-payout" hint="IBAN, account number or PayPal address">
          <Textarea id="pd-payout" rows={2} value={payoutDetails} onChange={(e) => setPayoutDetails(e.target.value)} autoComplete="off" maxLength={2000} />
        </Field>
        <Field label="Tax information" htmlFor="pd-tax" hint="VAT or tax ID">
          <Textarea id="pd-tax" rows={2} value={taxInfo} onChange={(e) => setTaxInfo(e.target.value)} autoComplete="off" maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

const SENSITIVE_LABELS: Record<string, string> = { payout_details: 'Payout details', tax_info: 'Tax information' };

/** Multi-level commissions from this affiliate's point of view: their recruiter, their paid upline and their recruits. */
function NetworkCard({ aff, onShowRecruits }: { aff: AffiliateDetail; onShowRecruits: () => void }) {
  const recruiter = aff.upline.find((u) => u.level === 2);
  const paid = aff.upline.filter((u) => u.ratePercent !== null);
  const link = (u: { id: string; name: string }) => (
    <Link to={`/growth/affiliates/${u.id}`} className="text-primary hover:underline">
      {u.name}
    </Link>
  );
  return (
    <Card title="Network" description="Who recruited this affiliate, who earns on their sales and whom they recruited">
      <KeyValue
        columns={1}
        items={[
          {
            label: 'Recruited by',
            value: recruiter ? (
              <>
                {link(recruiter)}
                <span className="block text-xs text-muted-foreground">{aff.parentSource === 'referral' ? 'Joined through their referral' : 'Assigned by an administrator'}</span>
              </>
            ) : (
              'Nobody'
            ),
          },
          {
            label: 'Upline paid on their sales',
            value: paid.length ? (
              <ul className="space-y-0.5">
                {paid.map((u) => (
                  <li key={u.id}>
                    Level {u.level}: {link(u)} ({u.ratePercent}%)
                    {u.status !== 'approved' && <span className="text-xs text-muted-foreground"> · {u.status}, not paid</span>}
                  </li>
                ))}
              </ul>
            ) : recruiter ? (
              'Nobody: multi-level commissions are off'
            ) : null,
          },
          {
            label: 'Recruits',
            value: aff.network.recruits ? (
              <button type="button" className="text-primary hover:underline" onClick={onShowRecruits}>
                {num(aff.network.recruits)} affiliate{aff.network.recruits === 1 ? '' : 's'}
              </button>
            ) : (
              'None yet'
            ),
          },
          {
            label: 'Earned from their network',
            value: aff.network.earnings.length ? (
              <ul className="space-y-0.5">
                {aff.network.earnings.map((e) => (
                  <li key={`${e.level}-${e.currency}`} className="tabular">
                    Level {e.level}: {money(e.amount, e.currency)}
                  </li>
                ))}
              </ul>
            ) : null,
          },
        ]}
      />
    </Card>
  );
}

export default function AffiliateDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [tab, setTab] = useTabParam('referrals');
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [details, setDetails] = useState(false);
  const q = useQuery({ queryKey: ['affiliate', id], queryFn: () => api.get<AffiliateDetail>(`/api/admin/affiliates/${id}`) });
  const setStatus = useAction((v: { action: 'approve' | 'reject' | 'suspend' | 'reactivate'; reason?: string }) => api.post(`/api/admin/affiliates/${id}/status`, v), {
    success: (_r, v) => ({ approve: 'Affiliate approved; a welcome email is on its way', reject: 'Application rejected', suspend: 'Affiliate suspended', reactivate: 'Affiliate reactivated' })[v.action],
    invalidate: [['affiliate', id], ['affiliates']],
  });
  const payout = useAction((currency: string) => api.post<PayoutResult>(`/api/admin/affiliates/${id}/payouts`, { currency }), {
    invalidate: [['affiliate', id], ['affiliate-payouts'], ['affiliate-commissions']],
    onSuccess: (r) => {
      if (r.status === 'requires_approval') toast.info('Sent for a second approval', 'Large payouts need another administrator. Track it under Administration → Approvals.');
      else toast.success('Payout created', 'Send the transfer, then mark the payout as paid under Payouts.');
    },
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data;
  const manage = can('affiliates.program.manage');
  const link = `${window.location.origin}/r/${a.code}`;

  const ask = async (action: 'reject' | 'suspend', title: string, description: string) => {
    const r = await confirm({ title, description, tone: 'danger', confirmLabel: action === 'reject' ? 'Reject' : 'Suspend', reason: { label: 'Reason (recorded in the audit log)', required: true } });
    if (r.confirmed) setStatus.mutate({ action, reason: r.reason });
  };

  const actions: MenuItem[] = [
    { label: 'Edit details and terms', icon: <Pencil className="size-4" />, onSelect: () => setEditing(true), hidden: !manage },
    { label: 'Manual adjustment', icon: <PlusCircle className="size-4" />, onSelect: () => setAdjusting(true), hidden: !manage },
    { label: 'Replace payout details', icon: <KeyRound className="size-4" />, onSelect: () => setDetails(true), hidden: !manage },
    { separator: true, label: '', hidden: !manage },
    { label: 'Approve', icon: <CircleCheck className="size-4" />, hidden: !manage || !['pending', 'rejected'].includes(a.status), onSelect: () => setStatus.mutate({ action: 'approve' }) },
    { label: 'Reject application', icon: <XCircle className="size-4" />, danger: true, hidden: !manage || a.status !== 'pending', onSelect: () => void ask('reject', `Reject ${a.name}?`, 'They will not be able to earn commissions. You can approve them later.') },
    { label: 'Suspend', icon: <Ban className="size-4" />, danger: true, hidden: !manage || a.status !== 'approved', onSelect: () => void ask('suspend', `Suspend ${a.name}?`, 'Their links stop tracking and no new commissions are earned. Existing balances are kept.') },
    { label: 'Reactivate', icon: <RotateCcw className="size-4" />, hidden: !manage || a.status !== 'suspended', onSelect: () => setStatus.mutate({ action: 'reactivate' }) },
  ];

  const t = a.terms;
  const overridden = a.commissionType !== null || a.ratePercent !== null || a.fixedAmount !== null || a.recurring !== null || a.recurringMonths !== null;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Affiliates', to: '/growth/affiliates?tab=affiliates' }, { label: a.name }]}
        documentTitle={a.name}
        title={a.name}
        description={a.email}
        meta={
          <>
            <StatusPill status={a.status} />
            {a.tier && <Badge tone="primary">{a.tier.name} tier</Badge>}
            {a.group && <Badge>{a.group.name}</Badge>}
            {a.stats.flagged > 0 && <Badge tone="warning">{a.stats.flagged} referral{a.stats.flagged === 1 ? '' : 's'} to review</Badge>}
            {a.statusReason && a.status !== 'approved' && <span className="text-xs text-muted-foreground">Reason: {a.statusReason}</span>}
          </>
        }
        actions={
          <>
            {manage && a.status === 'pending' && (
              <Button onClick={() => setStatus.mutate({ action: 'approve' })} loading={setStatus.isPending && setStatus.variables?.action === 'approve'}>
                Approve
              </Button>
            )}
            {manage && (
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={actions} />
          </>
        }
      />

      {a.status === 'approved' ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-ui border bg-surface px-4 py-3 text-sm shadow-ui">
          <span className="text-muted-foreground">Tracking link</span>
          <code className="min-w-0 break-all font-mono text-xs">{link}</code>
          <CopyButton value={link} label="Copy tracking link" />
        </div>
      ) : (
        <div className="mb-4">
          <Callout tone={a.status === 'pending' ? 'info' : 'warning'} title={a.status === 'pending' ? 'Waiting for review' : `This affiliate is ${a.status}`}>
            Tracking links only record clicks for approved affiliates.
          </Callout>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Link clicks" value={a.stats.clicks} display={num(a.stats.clicks)} hint={`${num(a.stats.uniqueVisitors)} unique visitors`} />
        <KpiTile label="Referred signups" value={a.stats.signups} display={num(a.stats.signups)} />
        <KpiTile label="Paying customers" value={a.stats.conversions} display={num(a.stats.conversions)} hint={a.stats.clicks ? `${((a.stats.conversions / a.stats.clicks) * 100).toFixed(1)}% of clicks` : undefined} />
        <KpiTile label="Referrals to review" value={a.stats.flagged} display={num(a.stats.flagged)} upIsGood={false} />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Earnings" description="Pending commissions wait out the hold period before they become payable" padded={false}>
            {a.stats.earnings.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No commissions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Currency</th>
                      <th className="px-4 py-2 text-right font-medium">Pending</th>
                      <th className="px-4 py-2 text-right font-medium">Payable</th>
                      <th className="px-4 py-2 text-right font-medium">Paid</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {a.stats.earnings.map((e) => {
                      const payable = a.payable.find((p) => p.currency === e.currency)?.payable ?? 0;
                      return (
                        <tr key={e.currency} className="border-b last:border-0">
                          <td className="px-4 py-2.5 font-medium">{e.currency}</td>
                          <td className="px-4 py-2.5 text-right tabular">{money(e.pending, e.currency)}</td>
                          <td className="px-4 py-2.5 text-right font-medium tabular">{money(payable, e.currency)}</td>
                          <td className="px-4 py-2.5 text-right tabular">{money(e.paid, e.currency)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {can('affiliates.payouts.manage') && payable > 0 && a.status === 'approved' && (
                              <Button
                                size="sm"
                                variant="outline"
                                icon={<Wallet className="size-3.5" />}
                                loading={payout.isPending && payout.variables === e.currency}
                                onClick={async () => {
                                  const r = await confirm({ title: `Pay out ${money(payable, e.currency)} to ${a.name}?`, description: 'This bundles every payable commission in this currency into one payout. Large payouts may need a second administrator.', confirmLabel: 'Create payout' });
                                  if (r.confirmed) payout.mutate(e.currency);
                                }}
                              >
                                Pay out
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Profile">
            <KeyValue
              items={[
                { label: 'Referral code', value: <Mono copy>{a.code}</Mono> },
                { label: 'Customer account', value: a.userId ? <Link to={`/customers/users/${a.userId}`} className="text-primary hover:underline">View customer</Link> : 'Not linked' },
                { label: 'Group', value: a.group?.name ?? 'None' },
                { label: 'Website', value: a.website },
                { label: 'Payout method', value: a.payoutMethod },
                { label: 'How they promote', value: a.promotionMethod },
                { label: 'Terms accepted', value: a.termsAcceptedAt ? dateTime(a.termsAcceptedAt) : 'Added by an administrator' },
                { label: 'Applied', value: dateTime(a.createdAt) },
                { label: 'Approved', value: a.approvedAt ? dateTime(a.approvedAt) : null },
                { label: 'Internal notes', value: a.notes },
              ]}
            />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Commission terms" description={overridden ? 'Custom terms for this affiliate' : a.tier ? `From the ${a.tier.name} tier` : 'Program defaults'}>
            <KeyValue
              columns={1}
              items={[
                { label: 'Commission', value: t.type === 'percent' ? `${t.ratePercent}% of each payment` : `${money(t.fixedAmount, t.fixedCurrency)} per paid invoice` },
                { label: 'Recurring', value: t.recurring ? (t.recurringMonths ? `Renewals for ${t.recurringMonths} months` : 'Renewals for the customer’s lifetime') : 'First payment only' },
                { label: 'Tier', value: a.tier ? `${a.tier.name} (${a.tier.rate_bps / 100}%)` : 'None' },
              ]}
            />
          </Card>

          <NetworkCard aff={a} onShowRecruits={() => setTab('recruits')} />

          <Card title="Payout and tax details" description="Encrypted; only the last characters are ever shown" actions={manage && <Button size="sm" variant="outline" onClick={() => setDetails(true)}>Replace</Button>}>
            {a.sensitive.length === 0 ? (
              <p className="text-sm text-muted-foreground">None on file.</p>
            ) : (
              <ul className="space-y-2">
                {a.sensitive.map((s) => (
                  <li key={s.name} className="flex items-center justify-between gap-2 text-sm">
                    <span>{SENSITIVE_LABELS[s.name] ?? s.name}</span>
                    <span className="text-right">
                      <span className="font-mono text-xs">•••• {s.last4 ?? ''}</span>
                      <span className="block text-xs text-muted-foreground">
                        updated <When value={s.updatedAt} />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'referrals', label: 'Referrals', count: a.stats.signups, content: <ReferralsTable affiliateId={a.id} /> },
            { value: 'commissions', label: 'Commissions', content: <CommissionsTable affiliateId={a.id} /> },
            { value: 'payouts', label: 'Payouts', content: <PayoutsTable affiliateId={a.id} /> },
            { value: 'sub-ids', label: 'Sub-IDs', content: <SubIdReport affiliateId={a.id} /> },
            { value: 'recruits', label: 'Recruits', count: a.network.recruits, content: <RecruitsTable affiliateId={a.id} /> },
            { value: 'materials', label: 'Materials', content: <AffiliateMaterialsList affiliateId={a.id} approved={a.status === 'approved'} /> },
          ]}
        />
      </div>

      {editing && <EditAffiliateDialog aff={a} open={editing} onOpenChange={setEditing} />}
      {adjusting && <AdjustmentDialog aff={a} open={adjusting} onOpenChange={setAdjusting} />}
      <PayoutDetailsDialog aff={a} open={details} onOpenChange={setDetails} />
    </>
  );
}
