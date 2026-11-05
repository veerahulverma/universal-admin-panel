import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Archive, Download, FileText, Image as ImageIcon, Link2, Pencil, Plus, RotateCcw, ShieldAlert, Trash2, UserPlus, type LucideIcon } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { bytes, dateTime, num, pct, titleCase } from '../../lib/format';
import { Badge, Button, Callout, Card, CodeBlock, CopyButton, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, Money, Pagination, SearchInput, Select, Skeleton, Tip, Toolbar, When, useConfirm, type Column } from '../../components/ui';
import { MoneyList, PeriodPicker, StatusPill, UserPicker, amountsFromMap } from './shared';
import { GroupDialog, MATERIAL_TYPES, MaterialDialog, type GroupRow, type MaterialRow, type MaterialType, type TierOption } from './affiliate-forms';

// ---- Types -------------------------------------------------------------------------------

export interface AffiliateRow {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  code: string;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  status_reason: string | null;
  website: string | null;
  promotion_method: string | null;
  created_at: string;
  group_id: string | null;
  group_name: string | null;
  parent_id: string | null;
  parent_name: string | null;
  parent_code: string | null;
  recruits: number;
  clicks: number;
  referrals: number;
  conversions: number;
  flagged_referrals: number;
  earnings: Record<string, number>;
}

export interface FraudFlag {
  type: string;
  detail: string;
  at: string;
}

interface ReferralRow {
  id: string;
  affiliate_id: string;
  user_id: string;
  attribution: string;
  status: 'pending' | 'converted' | 'rejected';
  fraud_flags: FraudFlag[];
  sub_id: string | null;
  reviewed_at: string | null;
  converted_at: string | null;
  created_at: string;
  affiliate_name: string;
  affiliate_code: string;
  user_email: string;
}

interface CommissionRow {
  id: string;
  affiliate_id: string;
  kind: 'sale' | 'upline' | 'adjustment' | 'clawback';
  /** 1 for the referring affiliate, 2 and up for their upline. */
  level: number;
  sub_id: string | null;
  source_affiliate_id: string | null;
  source_affiliate_name: string | null;
  invoice_id: string | null;
  base_amount: number | null;
  rate_bps: number | null;
  amount: number;
  reversed_amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'paid' | 'reversed' | 'rejected';
  flagged: boolean;
  hold_until: string | null;
  payout_id: string | null;
  reason: string | null;
  created_at: string;
  affiliate_name: string;
  affiliate_code: string;
  invoice_number: string | null;
}

interface PayoutRow {
  id: string;
  affiliate_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'canceled';
  method: string | null;
  reference: string | null;
  approval_id: string | null;
  created_at: string;
  paid_at: string | null;
  affiliate_name: string;
  affiliate_code: string;
}

export const FRAUD_LABELS: Record<string, string> = {
  self_referral: 'Self-referral',
  same_email_domain: 'Same email domain',
  same_ip_as_affiliate: 'Same network as affiliate',
  signup_velocity: 'Signup burst',
  conversion_velocity: 'Conversion burst',
};

const ATTRIBUTION_LABELS: Record<string, string> = { first_click: 'First click', last_click: 'Last click', code: 'Referral code', coupon: 'Coupon', manual: 'Manual' };

function affiliateCell(row: { affiliate_id: string; affiliate_name: string; affiliate_code: string }) {
  return (
    <Link to={`/growth/affiliates/${row.affiliate_id}`} className="hover:underline">
      {row.affiliate_name} <span className="font-mono text-xs text-muted-foreground">{row.affiliate_code}</span>
    </Link>
  );
}

/** Affiliate groups, for filters and targeting (cached across tabs). */
export function useAffiliateGroups() {
  return useQuery({ queryKey: ['affiliate-groups'], queryFn: () => api.get<{ data: GroupRow[] }>('/api/admin/affiliate-groups'), staleTime: 60_000 });
}

// ---- Affiliates ---------------------------------------------------------------------------------

const AFFILIATE_DEFAULTS = { q: '', status: '', group: '', page: 1, pageSize: 25 };

/** The affiliate directory; `applications` shows pending applications with quick approve/reject. */
export function AffiliatesTable({ applications = false }: { applications?: boolean }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(AFFILIATE_DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search, 300);
  // Push the debounced search text into the URL (only when the text itself changes).
  useEffect(() => {
    if (q !== String(state.q ?? '')) setState({ q });
  }, [q]);
  const status = applications ? 'pending' : String(state.status);
  const groupId = applications ? '' : String(state.group);
  const groups = useAffiliateGroups();
  const list = useQuery({
    queryKey: ['affiliates', { ...state, status, group: groupId }],
    queryFn: ({ signal }) => api.get<Page<AffiliateRow>>('/api/admin/affiliates', { q: String(state.q || ''), status, groupId, page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const setStatus = useAction((v: { id: string; action: 'approve' | 'reject'; reason?: string }) => api.post(`/api/admin/affiliates/${v.id}/status`, { action: v.action, reason: v.reason }), {
    success: (_r, v) => (v.action === 'approve' ? 'Affiliate approved; a welcome email is on its way' : 'Application rejected'),
    invalidate: [['affiliates'], ['affiliate']],
  });

  const columns: Column<AffiliateRow>[] = [
    {
      key: 'name',
      header: 'Affiliate',
      cell: (a) => (
        <span className="min-w-0">
          <span className="block truncate">{a.name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{a.email}</span>
        </span>
      ),
    },
    { key: 'code', header: 'Code', cell: (a) => <span className="font-mono text-xs">{a.code}</span> },
    { key: 'status', header: 'Status', cell: (a) => <StatusPill status={a.status} /> },
    ...(applications
      ? [
          { key: 'website', header: 'Website', cell: (a: AffiliateRow) => (a.website ? <span className="block max-w-56 truncate">{a.website}</span> : <span className="text-muted-foreground">—</span>) },
          { key: 'promotion', header: 'How they promote', priority: 'low' as const, cell: (a: AffiliateRow) => <span className="line-clamp-2 max-w-xs text-sm">{a.promotion_method ?? '—'}</span> },
        ]
      : [
          { key: 'group', header: 'Group', priority: 'low' as const, cell: (a: AffiliateRow) => (a.group_name ? <Badge>{a.group_name}</Badge> : <span className="text-muted-foreground">—</span>) },
          { key: 'referrals', header: 'Referrals', align: 'right' as const, cell: (a: AffiliateRow) => <span className="tabular">{a.conversions} / {a.referrals}</span> },
          { key: 'earnings', header: 'Earned', align: 'right' as const, cell: (a: AffiliateRow) => <MoneyList items={amountsFromMap(a.earnings)} /> },
          {
            key: 'flags',
            header: 'Review',
            cell: (a: AffiliateRow) =>
              a.flagged_referrals > 0 ? (
                <Badge tone="warning">
                  <ShieldAlert className="size-3" aria-hidden="true" /> {a.flagged_referrals} flagged
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]),
    { key: 'created_at', header: applications ? 'Applied' : 'Joined', cell: (a) => <When value={a.created_at} /> },
    ...(applications && can('affiliates.program.manage')
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            cell: (a: AffiliateRow) => (
              <span className="inline-flex gap-1.5">
                <Button size="sm" onClick={() => setStatus.mutate({ id: a.id, action: 'approve' })} loading={setStatus.isPending && setStatus.variables?.id === a.id && setStatus.variables.action === 'approve'}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const r = await confirm({ title: `Reject ${a.name}?`, description: 'They will not be able to earn commissions. You can approve them later.', tone: 'danger', confirmLabel: 'Reject', reason: { label: 'Reason (recorded in the audit log)', required: true } });
                    if (r.confirmed) setStatus.mutate({ id: a.id, action: 'reject', reason: r.reason });
                  }}
                >
                  Reject
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, email or code…" className="w-full sm:w-72" />
        {!applications && (
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Any status"
            options={[
              { value: 'approved', label: 'Approved' },
              { value: 'pending', label: 'Pending review' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'rejected', label: 'Rejected' },
            ]}
          />
        )}
        {!applications && (groups.data?.data.length ?? 0) > 0 && (
          <Select aria-label="Group" className="w-auto" value={groupId} onChange={(e) => setState({ group: e.target.value })} placeholder="Any group" options={(groups.data?.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
        )}
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption={applications ? 'Affiliate applications' : 'Affiliates'}
          columns={columns}
          rows={list.data?.data}
          rowKey={(a) => a.id}
          rowHref={(a) => `/growth/affiliates/${a.id}`}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={
            applications ? (
              <EmptyState title="No applications waiting" description="Customers apply from your app through the affiliate portal (SDK). New applications appear here for review." />
            ) : (
              <EmptyState title={state.q || state.status || groupId ? 'No affiliates match' : 'No affiliates yet'} description={state.q || state.status || groupId ? undefined : 'Add a partner manually, or let customers apply from your app.'} />
            )
          }
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

// ---- Referrals -------------------------------------------------------------------------------

const REFERRAL_DEFAULTS = { status: '', flagged: '', page: 1, pageSize: 25 };

function CreditReferralDialog({ open, onOpenChange, affiliateId }: { open: boolean; onOpenChange: (o: boolean) => void; affiliateId?: string }) {
  const [user, setUser] = useState<{ id: string; email: string; name?: string | null } | null>(null);
  const [affiliate, setAffiliate] = useState(affiliateId ?? '');
  const [error, setError] = useState<string | null>(null);
  const approved = useQuery({
    queryKey: ['affiliates', { status: 'approved', picker: true }],
    queryFn: () => api.get<Page<AffiliateRow>>('/api/admin/affiliates', { status: 'approved', pageSize: 200 }),
    enabled: open && !affiliateId,
  });
  const credit = useAction(() => api.post('/api/admin/referrals', { userId: user!.id, affiliateId: affiliate }), {
    success: 'Customer credited to the affiliate',
    invalidate: [['affiliate-referrals'], ['affiliates'], ['affiliate']],
    onSuccess: () => {
      onOpenChange(false);
      setUser(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Credit a customer to an affiliate"
      description="For referrals the tracking link missed (for example a partner who introduced a customer by phone). A customer can only ever be referred once."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => credit.mutate()} disabled={!user || !affiliate} loading={credit.isPending}>
            Credit referral
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <Field label="Customer">
          <UserPicker value={user} onChange={setUser} />
        </Field>
        {!affiliateId && (
          <Field label="Affiliate" htmlFor="credit-affiliate">
            <Select id="credit-affiliate" value={affiliate} onChange={(e) => setAffiliate(e.target.value)} placeholder="Choose an approved affiliate" options={(approved.data?.data ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.code})` }))} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function ReferralsTable({ affiliateId }: { affiliateId?: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(REFERRAL_DEFAULTS);
  const [crediting, setCrediting] = useState(false);
  const list = useQuery({
    queryKey: ['affiliate-referrals', affiliateId ?? null, state],
    queryFn: ({ signal }) => api.get<Page<ReferralRow>>('/api/admin/referrals', { affiliateId, status: String(state.status), flagged: String(state.flagged), page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const review = useAction((v: { id: string; action: 'clear-flags' | 'reject'; note?: string }) => api.post(`/api/admin/referrals/${v.id}/${v.action}`, { note: v.note }), {
    success: (_r, v) => (v.action === 'reject' ? 'Referral rejected; its unpaid commissions were rejected too' : 'Marked as reviewed; held commissions continue normally'),
    invalidate: [['affiliate-referrals'], ['affiliate-commissions'], ['affiliates'], ['affiliate']],
  });
  const manage = can('affiliates.program.manage');

  const columns: Column<ReferralRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) => (
        <Link to={`/customers/users/${r.user_id}`} className="hover:underline">
          {r.user_email}
        </Link>
      ),
    },
    ...(affiliateId ? [] : [{ key: 'affiliate', header: 'Affiliate', cell: affiliateCell }]),
    {
      key: 'attribution',
      header: 'Attribution',
      cell: (r) => (
        <span className="inline-flex flex-col">
          {ATTRIBUTION_LABELS[r.attribution] ?? r.attribution}
          {r.sub_id && <span className="font-mono text-xs text-muted-foreground">sub {r.sub_id}</span>}
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill status={r.status} /> },
    {
      key: 'signals',
      header: 'Fraud signals',
      cell: (r) =>
        r.fraud_flags?.length ? (
          <span className="flex flex-wrap gap-1">
            {r.fraud_flags.map((f, i) => (
              <Tip key={`${f.type}-${i}`} content={f.detail}>
                <span tabIndex={0}>
                  <Badge tone={r.reviewed_at ? 'neutral' : 'warning'}>{FRAUD_LABELS[f.type] ?? f.type}</Badge>
                </span>
              </Tip>
            ))}
            {r.reviewed_at && <Badge tone="success">reviewed</Badge>}
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    { key: 'created_at', header: 'Referred', cell: (r) => <When value={r.created_at} /> },
    { key: 'converted_at', header: 'Converted', priority: 'low', cell: (r) => <When value={r.converted_at} /> },
    ...(manage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            cell: (r: ReferralRow) => (
              <span className="inline-flex gap-1.5">
                {r.fraud_flags?.length > 0 && !r.reviewed_at && r.status !== 'rejected' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const res = await confirm({ title: 'Mark this referral as reviewed?', description: 'The signals stay on record and its held commissions follow the normal hold period.', confirmLabel: 'Mark reviewed', reason: { label: 'Note (optional)' } });
                      if (res.confirmed) review.mutate({ id: r.id, action: 'clear-flags', note: res.reason });
                    }}
                  >
                    Mark reviewed
                  </Button>
                )}
                {r.status !== 'rejected' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={async () => {
                      const res = await confirm({ title: `Reject the referral of ${r.user_email}?`, description: 'Its pending and approved commissions that are not yet paid out are rejected as well.', tone: 'danger', confirmLabel: 'Reject referral', reason: { label: 'Reason', required: true } });
                      if (res.confirmed) review.mutate({ id: r.id, action: 'reject', note: res.reason });
                    }}
                  >
                    Reject
                  </Button>
                )}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Referral status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={[{ value: 'pending', label: 'Not converted yet' }, { value: 'converted', label: 'Converted' }, { value: 'rejected', label: 'Rejected' }]} />
        <Select aria-label="Fraud review" className="w-auto" value={String(state.flagged)} onChange={(e) => setState({ flagged: e.target.value })} placeholder="All referrals" options={[{ value: 'true', label: 'Needs review' }, { value: 'false', label: 'No open signals' }]} />
        {manage && (
          <Button variant="outline" className="ml-auto" icon={<UserPlus className="size-4" />} onClick={() => setCrediting(true)}>
            Credit a customer
          </Button>
        )}
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Referrals"
          columns={columns}
          rows={list.data?.data}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title="No referrals" description="Customers appear here once they sign up through an affiliate link or code." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      <CreditReferralDialog open={crediting} onOpenChange={setCrediting} affiliateId={affiliateId} />
    </Card>
  );
}

// ---- Commissions ---------------------------------------------------------------------------------

const COMMISSION_DEFAULTS = { status: '', flagged: '', kind: '', page: 1, pageSize: 25 };

const KIND_LABELS: Record<CommissionRow['kind'], string> = { sale: 'Sale', upline: 'Upline', adjustment: 'Adjustment', clawback: 'Clawback' };

export function CommissionsTable({ affiliateId }: { affiliateId?: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(COMMISSION_DEFAULTS);
  const list = useQuery({
    queryKey: ['affiliate-commissions', affiliateId ?? null, state],
    queryFn: ({ signal }) =>
      api.get<Page<CommissionRow>>('/api/admin/affiliate-commissions', { affiliateId, status: String(state.status), flagged: String(state.flagged), kind: String(state.kind), page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const decide = useAction((v: { id: string; action: 'approve' | 'reject'; reason?: string }) => api.post(`/api/admin/affiliate-commissions/${v.id}/${v.action}`, { reason: v.reason }), {
    success: (_r, v) => (v.action === 'approve' ? 'Commission approved and payable' : 'Commission rejected'),
    invalidate: [['affiliate-commissions'], ['affiliate'], ['affiliates']],
  });
  const manage = can('affiliates.program.manage');

  const columns: Column<CommissionRow>[] = [
    ...(affiliateId ? [] : [{ key: 'affiliate', header: 'Affiliate', cell: affiliateCell }]),
    {
      key: 'kind',
      header: 'Type',
      cell: (c) => (
        <Badge tone={c.kind === 'sale' ? 'neutral' : c.kind === 'upline' ? 'primary' : c.kind === 'clawback' ? 'warning' : 'info'}>
          {KIND_LABELS[c.kind] ?? titleCase(c.kind)}
          {c.level > 1 && ` · level ${c.level}`}
        </Badge>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (c) => (
        <span className="inline-flex flex-col items-end">
          <Money amount={c.amount - c.reversed_amount} currency={c.currency} className="font-medium" />
          {c.reversed_amount > 0 && (
            <span className="text-xs text-muted-foreground">
              <Money amount={c.reversed_amount} currency={c.currency} /> reversed
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (c) =>
        c.invoice_id ? (
          <span className="inline-flex flex-col">
            <Link to={`/revenue/invoices/${c.invoice_id}`} className="hover:underline">
              {c.invoice_number ?? c.invoice_id}
            </Link>
            {c.base_amount !== null && c.rate_bps !== null && (
              <span className="text-xs text-muted-foreground">
                {c.rate_bps / 100}% of <Money amount={c.base_amount} currency={c.currency} />
              </span>
            )}
            {c.kind === 'upline' && c.source_affiliate_id && (
              <span className="text-xs text-muted-foreground">
                sale by{' '}
                <Link to={`/growth/affiliates/${c.source_affiliate_id}`} className="hover:underline">
                  {c.source_affiliate_name}
                </Link>
              </span>
            )}
            {c.sub_id && <span className="font-mono text-xs text-muted-foreground">sub {c.sub_id}</span>}
          </span>
        ) : (
          <span className="line-clamp-2 max-w-56 text-sm">{c.reason ?? '—'}</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusPill status={c.status} />
          {c.flagged && <Badge tone="warning">held for review</Badge>}
          {c.status === 'pending' && c.hold_until && !c.flagged && (
            <span className="text-xs text-muted-foreground" title={dateTime(c.hold_until)}>
              until <When value={c.hold_until} relative={false} />
            </span>
          )}
        </span>
      ),
    },
    { key: 'created_at', header: 'Earned', cell: (c) => <When value={c.created_at} /> },
    ...(manage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            cell: (c: CommissionRow) =>
              c.payout_id || c.status === 'paid' ? (
                <span className="text-xs text-muted-foreground">in payout</span>
              ) : (
                <span className="inline-flex gap-1.5">
                  {c.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const r = await confirm({
                          title: c.flagged ? 'Approve a flagged commission?' : 'Approve before the hold period ends?',
                          description: c.flagged ? 'Its referral has fraud signals. Approve only after checking the referral.' : 'It becomes payable immediately instead of after the refund window.',
                          confirmLabel: 'Approve',
                          reason: { label: 'Note (optional)' },
                        });
                        if (r.confirmed) decide.mutate({ id: c.id, action: 'approve', reason: r.reason });
                      }}
                    >
                      Approve
                    </Button>
                  )}
                  {(c.status === 'pending' || c.status === 'approved') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={async () => {
                        const r = await confirm({ title: 'Reject this commission?', description: 'It will not be paid out.', tone: 'danger', confirmLabel: 'Reject', reason: { label: 'Reason', required: true } });
                        if (r.confirmed) decide.mutate({ id: c.id, action: 'reject', reason: r.reason });
                      }}
                    >
                      Reject
                    </Button>
                  )}
                </span>
              ),
          },
        ]
      : []),
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select
          aria-label="Commission status"
          className="w-auto"
          value={String(state.status)}
          onChange={(e) => setState({ status: e.target.value })}
          placeholder="Any status"
          options={[
            { value: 'pending', label: 'Pending (in hold)' },
            { value: 'approved', label: 'Approved (payable)' },
            { value: 'paid', label: 'Paid' },
            { value: 'reversed', label: 'Reversed' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <Select aria-label="Review" className="w-auto" value={String(state.flagged)} onChange={(e) => setState({ flagged: e.target.value })} placeholder="All commissions" options={[{ value: 'true', label: 'Held for review' }, { value: 'false', label: 'Not flagged' }]} />
        <Select aria-label="Commission type" className="w-auto" value={String(state.kind)} onChange={(e) => setState({ kind: e.target.value })} placeholder="Any type" options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} />
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Commissions"
          columns={columns}
          rows={list.data?.data}
          rowKey={(c) => c.id}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title="No commissions" description="Commissions are earned automatically when referred customers pay invoices." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
    </Card>
  );
}

// ---- Payouts ---------------------------------------------------------------------------------------

const PAYOUT_DEFAULTS = { status: '', page: 1, pageSize: 25 };

function MarkPaidDialog({ payout, onClose }: { payout: PayoutRow | null; onClose: () => void }) {
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState('');
  const [error, setError] = useState<string | null>(null);
  const markPaid = useAction(() => api.post(`/api/admin/affiliate-payouts/${payout!.id}/mark-paid`, { reference: reference || undefined, method: method || undefined }), {
    success: 'Payout recorded as paid; the affiliate is notified by email',
    invalidate: [['affiliate-payouts'], ['affiliate-commissions'], ['affiliate'], ['affiliates']],
    onSuccess: () => {
      setReference('');
      setMethod('');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={Boolean(payout)}
      onOpenChange={(o) => !o && onClose()}
      title="Record payout as paid"
      description={payout ? <>Send the transfer of <Money amount={payout.amount} currency={payout.currency} /> to {payout.affiliate_name} first, then record it here.</> : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => markPaid.mutate()} loading={markPaid.isPending}>
            Mark as paid
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={error} />
        <Field label="Transfer reference" htmlFor="po-ref" hint="Bank or PayPal transaction ID, for reconciliation">
          <Input id="po-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Method" htmlFor="po-method" hint={payout?.method ? `Affiliate's preferred method: ${payout.method}` : undefined}>
          <Input id="po-method" value={method} onChange={(e) => setMethod(e.target.value)} placeholder={payout?.method ?? 'bank_transfer, paypal, wise…'} maxLength={50} />
        </Field>
      </div>
    </Modal>
  );
}

export function PayoutsTable({ affiliateId }: { affiliateId?: string }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(PAYOUT_DEFAULTS);
  const [paying, setPaying] = useState<PayoutRow | null>(null);
  const list = useQuery({
    queryKey: ['affiliate-payouts', affiliateId ?? null, state],
    queryFn: ({ signal }) => api.get<Page<PayoutRow>>('/api/admin/affiliate-payouts', { affiliateId, status: String(state.status), page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const cancel = useAction((id: string) => api.post(`/api/admin/affiliate-payouts/${id}/cancel`), {
    success: 'Payout canceled; its commissions are payable again',
    invalidate: [['affiliate-payouts'], ['affiliate-commissions'], ['affiliate']],
  });
  const manage = can('affiliates.payouts.manage');

  const columns: Column<PayoutRow>[] = [
    ...(affiliateId ? [] : [{ key: 'affiliate', header: 'Affiliate', cell: affiliateCell }]),
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <Money amount={p.amount} currency={p.currency} className="font-medium" /> },
    { key: 'status', header: 'Status', cell: (p) => <StatusPill status={p.status} /> },
    { key: 'method', header: 'Method', cell: (p) => p.method ?? <span className="text-muted-foreground">—</span> },
    { key: 'reference', header: 'Reference', priority: 'low', cell: (p) => (p.reference ? <span className="font-mono text-xs">{p.reference}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'created_at', header: 'Created', cell: (p) => <When value={p.created_at} /> },
    { key: 'paid_at', header: 'Paid', cell: (p) => <When value={p.paid_at} /> },
    ...(manage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            cell: (p: PayoutRow) =>
              p.status === 'pending' ? (
                <span className="inline-flex gap-1.5">
                  <Button size="sm" onClick={() => setPaying(p)}>
                    Mark paid
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if ((await confirm({ title: 'Cancel this payout?', description: 'Its commissions return to the payable balance.', tone: 'danger', confirmLabel: 'Cancel payout' })).confirmed) cancel.mutate(p.id);
                    }}
                  >
                    Cancel
                  </Button>
                </span>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <Card padded={false}>
      <Toolbar>
        <Select aria-label="Payout status" className="w-auto" value={String(state.status)} onChange={(e) => setState({ status: e.target.value })} placeholder="Any status" options={[{ value: 'pending', label: 'Pending transfer' }, { value: 'paid', label: 'Paid' }, { value: 'canceled', label: 'Canceled' }]} />
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Payouts"
          columns={columns}
          rows={list.data?.data}
          rowKey={(p) => p.id}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          empty={<EmptyState title="No payouts" description="Create a payout from an affiliate's page once their approved balance reaches the minimum." />}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      <MarkPaidDialog payout={paying} onClose={() => setPaying(null)} />
    </Card>
  );
}

// ---- Marketing materials ----------------------------------------------------------------------------

const MATERIAL_ICONS: Record<MaterialType, LucideIcon> = { banner: ImageIcon, text_link: Link2, file: FileText };

/** A material that affiliates cannot see yet because its image or file is missing. */
const incomplete = (m: MaterialRow) => (m.type === 'banner' && !m.previewUrl) || (m.type === 'file' && !m.file);

function audience(m: MaterialRow, groups: Map<string, string>, tiers: Map<string, string>): string {
  const names = [...m.groupIds.map((id) => groups.get(id) ?? 'Deleted group'), ...m.tierIds.map((id) => `${tiers.get(id) ?? 'Deleted'} tier`)];
  return names.length ? names.join(', ') : 'All affiliates';
}

const MATERIAL_DEFAULTS = { mtype: '', mstatus: 'active' };

export function MaterialsPanel() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(MATERIAL_DEFAULTS);
  const [editing, setEditing] = useState<MaterialRow | 'new' | null>(null);
  const status = String(state.mstatus);
  const list = useQuery({
    queryKey: ['affiliate-materials', state.mtype, status],
    queryFn: ({ signal }) => api.get<{ data: MaterialRow[] }>('/api/admin/affiliate-materials', { type: String(state.mtype), status: status === 'all' ? undefined : status }, signal),
    placeholderData: keepPreviousData,
  });
  const groups = useAffiliateGroups();
  const tiers = useQuery({ queryKey: ['affiliate-tiers'], queryFn: () => api.get<{ data: TierOption[] }>('/api/admin/affiliate-tiers') });
  const groupNames = useMemo(() => new Map((groups.data?.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const tierNames = useMemo(() => new Map((tiers.data?.data ?? []).map((t) => [t.id, t.name])), [tiers.data]);
  const setStatus = useAction((v: { id: string; status: 'active' | 'archived' }) => api.patch(`/api/admin/affiliate-materials/${v.id}`, { status: v.status }), {
    success: (_r, v) => (v.status === 'archived' ? 'Archived: affiliates no longer see it; embedded banners keep working' : 'Restored for affiliates'),
    invalidate: [['affiliate-materials']],
  });
  const remove = useAction((id: string) => api.delete(`/api/admin/affiliate-materials/${id}`), { success: 'Material deleted', invalidate: [['affiliate-materials']] });
  const getFile = useAction((m: MaterialRow) => download(`/api/admin/affiliate-materials/${m.id}/file`, undefined, m.file?.filename ?? 'file'));
  const manage = can('affiliates.materials.manage');

  const columns: Column<MaterialRow>[] = [
    {
      key: 'name',
      header: 'Material',
      cell: (m) => {
        const Icon = MATERIAL_ICONS[m.type];
        return (
          <span className="flex min-w-0 items-center gap-3">
            {m.type === 'banner' && m.previewUrl ? (
              <img src={m.previewUrl} alt="" className="h-10 w-16 shrink-0 rounded-ui-sm border bg-muted/40 object-contain" loading="lazy" />
            ) : (
              <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded-ui-sm border bg-muted/40 text-muted-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate">{m.name}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {MATERIAL_TYPES.find((t) => t.value === m.type)?.label}
                {m.type === 'banner' && m.width && m.height ? ` · ${m.width}×${m.height}` : ''}
                {m.file ? ` · ${m.file.filename} (${bytes(m.file.size)})` : ''}
              </span>
            </span>
          </span>
        );
      },
    },
    { key: 'audience', header: 'Audience', cell: (m) => <span className="line-clamp-2 max-w-56 text-sm">{audience(m, groupNames, tierNames)}</span> },
    { key: 'landing', header: 'Lands on', priority: 'low', cell: (m) => <span className="font-mono text-xs">{m.landingPath ?? 'Landing page'}</span> },
    { key: 'clicks', header: 'Clicks (30 days)', align: 'right', cell: (m) => <span className="tabular">{num(m.clicks30d)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (m) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusPill status={m.status} />
          {incomplete(m) && <Badge tone="warning">{m.type === 'banner' ? 'needs an image' : 'needs a file'}</Badge>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (m) => (
        <span className="inline-flex gap-1">
          {m.file && (
            <Button size="icon-sm" variant="ghost" aria-label={`Download ${m.file.filename}`} onClick={() => getFile.mutate(m)}>
              <Download className="size-4" />
            </Button>
          )}
          {manage && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label={`Edit ${m.name}`} onClick={() => setEditing(m)}>
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={m.status === 'active' ? `Archive ${m.name}` : `Restore ${m.name}`}
                onClick={() => setStatus.mutate({ id: m.id, status: m.status === 'active' ? 'archived' : 'active' })}
              >
                {m.status === 'active' ? <Archive className="size-4" /> : <RotateCcw className="size-4" />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${m.name}`}
                onClick={async () => {
                  const r = await confirm({
                    title: `Delete ${m.name}?`,
                    description: m.type === 'banner' ? 'Banners affiliates already embedded stop showing the image. Archive it instead to keep them working.' : 'Affiliates can no longer use it.',
                    tone: 'danger',
                    confirmLabel: 'Delete material',
                  });
                  if (r.confirmed) remove.mutate(m.id);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Callout title="How affiliates use materials">
        Each affiliate sees the materials meant for them in your app’s affiliate area, with their own tracking link and ready-to-paste embed code. Clicks record which material they came from.
      </Callout>
      <Card padded={false}>
        <Toolbar>
          <Select aria-label="Material type" className="w-auto" value={String(state.mtype)} onChange={(e) => setState({ mtype: e.target.value })} placeholder="Any type" options={MATERIAL_TYPES} />
          <Select
            aria-label="Material status"
            className="w-auto"
            value={status}
            onChange={(e) => setState({ mstatus: e.target.value })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
              { value: 'all', label: 'All' },
            ]}
          />
          {manage && (
            <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New material
            </Button>
          )}
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Marketing materials"
            columns={columns}
            rows={list.data?.data}
            rowKey={(m) => m.id}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={<EmptyState title="No marketing materials" description="Add banners, text links and files (brand kits, guides) for affiliates to promote you with." />}
          />
        )}
      </Card>
      {editing && (
        <MaterialDialog
          key={editing === 'new' ? 'new' : editing.id}
          material={editing === 'new' ? null : editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          groups={groups.data?.data ?? []}
          tiers={tiers.data?.data ?? []}
        />
      )}
    </div>
  );
}

// ---- Groups ----------------------------------------------------------------------------------------

export function GroupsPanel({ onShowMembers }: { onShowMembers: (groupId: string) => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null);
  const groups = useAffiliateGroups();
  const remove = useAction((id: string) => api.delete(`/api/admin/affiliate-groups/${id}`), { success: 'Group deleted', invalidate: [['affiliate-groups'], ['affiliates']] });
  const manage = can('affiliates.program.manage');
  return (
    <div className="space-y-4">
      <Callout title="What groups are for">Put affiliates in a group (influencers, agencies, resellers…) from their page, then limit marketing materials to it.</Callout>
      <Card
        title="Affiliate groups"
        padded={false}
        actions={
          manage && (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New group
            </Button>
          )
        }
      >
        {groups.error ? (
          <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
        ) : (
          <DataTable
            caption="Affiliate groups"
            rows={groups.data?.data}
            loading={groups.isLoading}
            rowKey={(g) => g.id}
            empty={<EmptyState title="No groups" description="Groups let you offer materials to some affiliates only." />}
            columns={[
              {
                key: 'name',
                header: 'Group',
                cell: (g) => (
                  <span className="min-w-0">
                    <span className="block font-medium">{g.name}</span>
                    {g.description && <span className="block text-xs text-muted-foreground">{g.description}</span>}
                  </span>
                ),
              },
              {
                key: 'affiliates',
                header: 'Affiliates',
                align: 'right',
                cell: (g) => (
                  <button type="button" className="tabular text-primary hover:underline" onClick={() => onShowMembers(g.id)}>
                    {num(g.affiliates)}
                  </button>
                ),
              },
              { key: 'materials', header: 'Materials', align: 'right', cell: (g) => <span className="tabular">{num(g.materials)}</span> },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: '',
                      align: 'right' as const,
                      cell: (g: GroupRow) => (
                        <span className="inline-flex gap-1">
                          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Delete ${g.name}`}
                            onClick={async () => {
                              const r = await confirm({ title: `Delete the ${g.name} group?`, description: 'Its affiliates simply leave the group. Groups that materials are limited to cannot be deleted.', tone: 'danger', confirmLabel: 'Delete group' });
                              if (r.confirmed) remove.mutate(g.id);
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
      {editing && <GroupDialog key={editing === 'new' ? 'new' : editing.id} group={editing === 'new' ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
    </div>
  );
}

// ---- One affiliate: sub-IDs, recruits, materials ---------------------------------------------------

interface SubIdRow {
  subId: string | null;
  clicks: number;
  signups: number;
  conversions: number;
  conversionRate: number | null;
  commissions: { currency: string; amount: number }[];
}

export function SubIdReport({ affiliateId }: { affiliateId: string }) {
  const [days, setDays] = useState(30);
  const report = useQuery({
    queryKey: ['affiliate', affiliateId, 'sub-ids', days],
    queryFn: ({ signal }) => {
      const to = new Date();
      return api.get<{ data: SubIdRow[] }>(`/api/admin/affiliates/${affiliateId}/sub-ids`, { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() }, signal);
    },
    placeholderData: keepPreviousData,
  });
  return (
    <Card title="Results by sub-ID" description="Sub-IDs are the affiliate’s own campaign labels, added to their links as ?sub=spring-campaign." padded={false} actions={<PeriodPicker days={days} onChange={setDays} />}>
      {report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <DataTable
          caption="Results by sub-ID"
          rows={report.data?.data}
          loading={report.isLoading}
          fetching={report.isFetching && !report.isLoading}
          rowKey={(r) => r.subId ?? '(none)'}
          empty={<EmptyState title="No activity in this period" />}
          columns={[
            { key: 'sub', header: 'Sub-ID', cell: (r) => (r.subId ? <span className="font-mono text-xs">{r.subId}</span> : <span className="text-muted-foreground">No sub-ID</span>) },
            { key: 'clicks', header: 'Clicks', align: 'right', cell: (r) => <span className="tabular">{num(r.clicks)}</span> },
            { key: 'signups', header: 'Signups', align: 'right', cell: (r) => <span className="tabular">{num(r.signups)}</span> },
            { key: 'conversions', header: 'Customers', align: 'right', cell: (r) => <span className="tabular">{num(r.conversions)}</span> },
            { key: 'rate', header: 'Conversion', align: 'right', priority: 'low', cell: (r) => (r.conversionRate === null ? '—' : pct(r.conversionRate)) },
            { key: 'commissions', header: 'Commissions', align: 'right', cell: (r) => <MoneyList items={r.commissions.map((c) => ({ currency: c.currency, amount: c.amount }))} /> },
          ]}
        />
      )}
    </Card>
  );
}

export function RecruitsTable({ affiliateId }: { affiliateId: string }) {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['affiliates', { parentId: affiliateId, page }],
    queryFn: ({ signal }) => api.get<Page<AffiliateRow>>('/api/admin/affiliates', { parentId: affiliateId, page, pageSize: 25 }, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <Card padded={false}>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Recruited affiliates"
          rows={list.data?.data}
          loading={list.isLoading}
          fetching={list.isFetching && !list.isLoading}
          rowKey={(a) => a.id}
          rowHref={(a) => `/growth/affiliates/${a.id}`}
          empty={<EmptyState title="No recruits" description="Affiliates who join through this affiliate’s link, or are assigned to them, appear here." />}
          columns={[
            {
              key: 'name',
              header: 'Affiliate',
              cell: (a) => (
                <span className="min-w-0">
                  <span className="block truncate">{a.name}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{a.email}</span>
                </span>
              ),
            },
            { key: 'code', header: 'Code', cell: (a) => <span className="font-mono text-xs">{a.code}</span> },
            { key: 'status', header: 'Status', cell: (a) => <StatusPill status={a.status} /> },
            { key: 'referrals', header: 'Referrals', align: 'right', cell: (a) => <span className="tabular">{a.conversions} / {a.referrals}</span> },
            { key: 'recruits', header: 'Their recruits', align: 'right', priority: 'low', cell: (a) => <span className="tabular">{num(a.recruits)}</span> },
            { key: 'created_at', header: 'Joined', cell: (a) => <When value={a.created_at} /> },
          ]}
        />
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
    </Card>
  );
}

interface MaterialView {
  id: string;
  type: MaterialType;
  name: string;
  description: string | null;
  trackingLink: string;
  imageUrl: string | null;
  embedHtml: string | null;
  file: { filename: string; contentType: string; size: number } | null;
}

/** What the affiliate sees in their affiliate area, with their own links (for support conversations). */
export function AffiliateMaterialsList({ affiliateId, approved }: { affiliateId: string; approved: boolean }) {
  const list = useQuery({ queryKey: ['affiliate', affiliateId, 'materials'], queryFn: () => api.get<{ data: MaterialView[] }>(`/api/admin/affiliates/${affiliateId}/materials`) });
  if (list.isLoading) return <Skeleton className="h-40" />;
  if (list.error || !list.data) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <div className="space-y-3">
      {!approved && <Callout tone="warning">This affiliate is not approved, so their affiliate area shows no materials yet. This is what they will see.</Callout>}
      {list.data.data.length === 0 && (
        <Card>
          <EmptyState title="No materials for this affiliate" description="Add materials under Affiliates → Materials, or check their group and tier." />
        </Card>
      )}
      {list.data.data.map((m) => {
        const Icon = MATERIAL_ICONS[m.type];
        return (
          <Card key={m.id}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="font-medium">{m.name}</span>
                <Badge>{MATERIAL_TYPES.find((t) => t.value === m.type)?.label}</Badge>
              </div>
              {m.description && <p className="text-sm text-muted-foreground">{m.description}</p>}
              {m.type === 'banner' && m.imageUrl && <img src={m.imageUrl} alt={m.name} className="max-h-32 max-w-full rounded-ui-sm border object-contain" loading="lazy" />}
              <div className="flex min-w-0 items-center gap-2 rounded-ui-sm border px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">{m.trackingLink}</code>
                <CopyButton value={m.trackingLink} label="Copy tracking link" />
              </div>
              {m.embedHtml && <CodeBlock code={m.embedHtml} className="break-all" />}
              {m.file && (
                <p className="text-sm text-muted-foreground">
                  {m.file.filename} · {bytes(m.file.size)}
                </p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
