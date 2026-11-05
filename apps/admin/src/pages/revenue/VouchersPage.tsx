import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, Download, Gift, Layers, MoreHorizontal, Plus } from 'lucide-react';
import { api, download, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced, useUrlState } from '../../lib/hooks';
import { dateTime, money, num, toMinor } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  CopyButton,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  Menu,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Toolbar,
  When,
  useConfirm,
  useToast,
  type Column,
  type Tone,
} from '../../components/ui';
import { useProductList } from '../catalog/shared';
import { AmountInput, CustomerLink, cleanQuery, useCurrencies } from './shared';

interface Voucher {
  id: string;
  code: string;
  name: string;
  batch_id: string | null;
  batch_name: string | null;
  kind: 'product' | 'credit';
  product_id: string | null;
  product_name: string | null;
  quantity: number;
  access_days: number | null;
  credit_amount: number | null;
  currency: string | null;
  expires_at: string | null;
  status: 'active' | 'redeemed' | 'disabled';
  redeemed_at: string | null;
  subject_type: 'user' | 'organization' | null;
  subject_id: string | null;
  redeemed_by: string | null;
  created_at: string;
}

interface VoucherBatch {
  id: string;
  name: string;
  prefix: string;
  count: number;
  created_at: string;
  codes: number;
  redeemed: number;
  disabled: number;
  kind: Voucher['kind'];
  product_name: string | null;
  access_days: number | null;
  credit_amount: number | null;
  currency: string | null;
  expires_at: string | null;
}

interface Issued {
  batch: { id: string; name: string } | null;
  count: number;
  vouchers: Voucher[];
}

type Gives = Pick<Voucher, 'kind' | 'product_name' | 'access_days' | 'credit_amount' | 'currency'>;

/** "Pro for 30 days", "US$25.00 account credit". */
function givesText(v: Gives): string {
  if (v.kind === 'credit') return `${money(v.credit_amount, v.currency ?? 'USD')} account credit`;
  return `${v.product_name ?? 'Product'}${v.access_days ? ` for ${num(v.access_days)} days` : ', for good'}`;
}

/** What a customer would find right now: an active voucher past its expiry cannot be redeemed. */
function voucherState(v: Pick<Voucher, 'status' | 'expires_at'>): 'active' | 'redeemed' | 'disabled' | 'expired' {
  if (v.status === 'active' && v.expires_at && new Date(v.expires_at).getTime() <= Date.now()) return 'expired';
  return v.status;
}

const STATE_TONE: Record<ReturnType<typeof voucherState>, Tone> = { active: 'success', redeemed: 'primary', disabled: 'neutral', expired: 'warning' };

function VoucherState({ voucher }: { voucher: Pick<Voucher, 'status' | 'expires_at'> }) {
  const s = voucherState(voucher);
  return (
    <Badge tone={STATE_TONE[s]} dot>
      {s}
    </Badge>
  );
}

function IssueDialog({ open, onOpenChange, onIssued }: { open: boolean; onOpenChange: (o: boolean) => void; onIssued: (r: Issued) => void }) {
  const { base, list } = useCurrencies();
  const products = useProductList();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Voucher['kind']>('product');
  const [productId, setProductId] = useState('');
  const [accessDays, setAccessDays] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(base);
  const [expiresAt, setExpiresAt] = useState('');
  const [batch, setBatch] = useState(false);
  const [count, setCount] = useState('50');
  const [prefix, setPrefix] = useState('GIFT');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const grantable = (products.data?.data ?? []).filter((p) => p.status === 'active' && p.kind !== 'credit_pack');

  const issue = useAction(
    async () => {
      const creditAmount = kind === 'credit' ? toMinor(amount, currency) : null;
      if (kind === 'credit' && !creditAmount) throw new Error('Enter the credit amount, for example 25.00');
      return api.post<Issued>('/api/admin/vouchers', {
        name: name.trim(),
        kind,
        productId: kind === 'product' ? productId || undefined : undefined,
        accessDays: kind === 'product' && accessDays.trim() ? Number(accessDays) : undefined,
        creditAmount: creditAmount ?? undefined,
        currency: kind === 'credit' ? currency : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        count: batch ? Number(count) || 0 : 1,
        prefix: batch ? prefix.trim() : undefined,
        code: !batch && code.trim() ? code.trim() : undefined,
      });
    },
    {
      success: (r) => (r.batch ? `${num(r.count)} vouchers issued` : 'Voucher issued'),
      invalidate: [['vouchers'], ['voucher-batches']],
      onSuccess: (r) => {
        onOpenChange(false);
        onIssued(r);
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Issue gift vouchers"
      description="Each code can be redeemed once, by one customer, through your app (client or server API)."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="voucher-form" loading={issue.isPending}>
            {batch ? `Issue ${num(Number(count) || 0)} vouchers` : 'Issue voucher'}
          </Button>
        </>
      }
    >
      <form
        id="voucher-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          issue.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Internal name" htmlFor="vo-name" required hint="Shown to your team, e.g. Holiday gift cards 2026">
          <Input id="vo-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={120} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">The voucher gives</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { value: 'product' as const, label: 'A product', hint: 'For good, or for a number of days.' },
              { value: 'credit' as const, label: 'Account credit', hint: 'Pays future invoices and carts.' },
            ].map((k) => (
              <label key={k.value} className={`flex cursor-pointer gap-2.5 rounded-ui-sm border p-3 text-sm ${kind === k.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
                <input type="radio" name="voucher-kind" checked={kind === k.value} onChange={() => setKind(k.value)} className="mt-0.5 accent-[var(--color-primary)]" />
                <span>
                  <span className="block font-medium">{k.label}</span>
                  <span className="block text-xs text-muted-foreground">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {kind === 'product' ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <Field label="Product" htmlFor="vo-product" required>
              <Select id="vo-product" value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="Choose a product" options={grantable.map((p) => ({ value: p.id, label: p.name }))} required />
            </Field>
            <Field label="Access (days)" htmlFor="vo-days" hint="Empty: for good">
              <Input id="vo-days" type="number" min={1} max={36500} value={accessDays} onChange={(e) => setAccessDays(e.target.value)} placeholder="For good" />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label="Credit" htmlFor="vo-amount" required>
              <AmountInput id="vo-amount" value={amount} onChange={setAmount} currency={currency} required />
            </Field>
            <Field label="Currency" htmlFor="vo-currency">
              <Select id="vo-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} options={list} />
            </Field>
          </div>
        )}
        <Field label="Expires" htmlFor="vo-expires" hint="Empty: never. Unredeemed vouchers stop working after this.">
          <Input id="vo-expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="sm:max-w-64" />
        </Field>
        <fieldset className="space-y-3 rounded-ui-sm border p-3">
          <legend className="px-1 text-sm font-medium">Codes</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="voucher-count" checked={!batch} onChange={() => setBatch(false)} className="accent-[var(--color-primary)]" /> One voucher
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="voucher-count" checked={batch} onChange={() => setBatch(true)} className="accent-[var(--color-primary)]" /> A batch
            </label>
          </div>
          {batch ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Number of vouchers" htmlFor="vo-count" hint="Up to 5,000">
                <Input id="vo-count" type="number" min={2} max={5000} value={count} onChange={(e) => setCount(e.target.value)} />
              </Field>
              <Field label="Prefix" htmlFor="vo-prefix" hint={`Codes look like ${prefix.trim() ? `${prefix.trim().toUpperCase()}-` : ''}7KQ2-M9XA-P3RT`}>
                <Input id="vo-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} maxLength={12} className="font-mono" />
              </Field>
            </div>
          ) : (
            <Field label="Code" htmlFor="vo-code" hint="Empty: a random code. Letters, numbers and dashes.">
              <Input id="vo-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={40} className="font-mono sm:max-w-64" />
            </Field>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}

function exportBatch(batchId: string) {
  return download(`/api/admin/voucher-batches/${batchId}/codes.csv`, undefined, 'vouchers.csv');
}

/** Shown after issuing: the code to hand over, or the batch to export. */
function IssuedModal({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const toast = useToast();
  const single = !issued.batch ? issued.vouchers[0] : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={single ? 'Voucher issued' : `${num(issued.count)} vouchers issued`}
      size="md"
      footer={
        <>
          {issued.batch && (
            <Button
              variant="outline"
              icon={<Download className="size-4" />}
              onClick={() => exportBatch(issued.batch!.id).catch((err) => toast.error('Export failed', errorMessage(err)))}
            >
              Export codes
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {single ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Give this code to the customer. It {single.kind === 'credit' ? 'adds' : 'grants'} {givesText(single)}.
          </p>
          <div className="flex items-center gap-2">
            <CodeBlock code={single.code} className="flex-1" />
            <CopyButton value={single.code} label="Copy code" />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Export the codes as CSV to send them out. The first ones:</p>
          <CodeBlock code={issued.vouchers.map((v) => v.code).join('\n')} />
        </div>
      )}
    </Modal>
  );
}

function VoucherDialog({ voucher, onClose }: { voucher: Voucher; onClose: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const manage = can('billing.vouchers.manage') && voucher.status !== 'redeemed';
  const update = useAction((body: Record<string, unknown>) => api.patch<Voucher>(`/api/admin/vouchers/${voucher.id}`, body), {
    success: (_r, b) => (b.status === 'disabled' ? 'Voucher disabled' : 'Voucher enabled'),
    invalidate: [['vouchers'], ['voucher-batches']],
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{voucher.code}</span>
          {/* Without the manage permission the server sends only the end of the code. */}
          {can('billing.vouchers.manage') && <CopyButton value={voucher.code} label="Copy code" />}
          <VoucherState voucher={voucher} />
        </span>
      }
      description={voucher.name}
      footer={
        manage &&
        (voucher.status === 'active' ? (
          <Button
            variant="outline"
            className="text-danger"
            loading={update.isPending}
            onClick={async () => {
              const r = await confirm({ title: `Disable ${voucher.code}?`, description: 'It can no longer be redeemed. You can enable it again later.', confirmLabel: 'Disable', tone: 'danger' });
              if (r.confirmed) update.mutate({ status: 'disabled' });
            }}
          >
            Disable
          </Button>
        ) : (
          <Button variant="outline" loading={update.isPending} onClick={() => update.mutate({ status: 'active' })}>
            Enable
          </Button>
        ))
      }
    >
      <KeyValue
        items={[
          { label: 'Gives', value: givesText(voucher) },
          { label: 'Quantity', value: num(voucher.quantity), hidden: voucher.kind !== 'product' || voucher.quantity === 1 },
          { label: 'Expires', value: voucher.expires_at ? dateTime(voucher.expires_at) : 'Never' },
          { label: 'Batch', value: voucher.batch_name, hidden: !voucher.batch_id },
          { label: 'Issued', value: dateTime(voucher.created_at) },
          { label: 'Redeemed', value: voucher.redeemed_at ? dateTime(voucher.redeemed_at) : 'Not yet' },
          {
            label: 'Redeemed by',
            value: voucher.subject_type && voucher.subject_id ? <CustomerLink type={voucher.subject_type} id={voucher.subject_id} label={voucher.redeemed_by} /> : null,
            hidden: !voucher.subject_id,
          },
        ]}
      />
    </Modal>
  );
}

function BatchesCard({ onShow }: { onShow: (b: VoucherBatch) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const manage = can('billing.vouchers.manage');
  const batches = useQuery({ queryKey: ['voucher-batches'], queryFn: () => api.get<{ data: VoucherBatch[] }>('/api/admin/voucher-batches') });
  const disable = useAction((b: VoucherBatch) => api.post<{ disabled: number }>(`/api/admin/voucher-batches/${b.id}/disable`), {
    success: (r) => `${num(r.disabled)} vouchers disabled`,
    invalidate: [['vouchers'], ['voucher-batches']],
  });
  if (!batches.data?.data.length) return null;
  const columns: Column<VoucherBatch>[] = [
    {
      key: 'name',
      header: 'Batch',
      cell: (b) => (
        <span className="min-w-0">
          <span className="block">{b.name}</span>
          <span className="block text-xs text-muted-foreground">{givesText(b)}</span>
        </span>
      ),
    },
    { key: 'redeemed', header: 'Redeemed', align: 'right', cell: (b) => <span className="tabular">{num(b.redeemed)} / {num(b.codes)}</span> },
    { key: 'disabled', header: 'Disabled', align: 'right', priority: 'low', cell: (b) => <span className="tabular">{num(b.disabled)}</span> },
    { key: 'expires', header: 'Expires', priority: 'low', cell: (b) => (b.expires_at ? <When value={b.expires_at} relative={false} /> : <span className="text-muted-foreground">Never</span>) },
    { key: 'created', header: 'Issued', cell: (b) => <When value={b.created_at} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (b) => (
        <Menu
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${b.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          }
          items={[
            { label: 'Show vouchers', icon: <Layers className="size-4" />, onSelect: () => onShow(b) },
            { label: 'Export CSV', icon: <Download className="size-4" />, hidden: !manage, onSelect: () => void exportBatch(b.id).catch((err) => toast.error('Export failed', errorMessage(err))) },
            {
              label: 'Disable unredeemed',
              icon: <Ban className="size-4" />,
              danger: true,
              hidden: !manage || b.redeemed + b.disabled >= b.codes,
              onSelect: async () => {
                const r = await confirm({ title: `Disable ${b.name}?`, description: 'Every voucher of this batch that was not redeemed yet stops working, for example after codes leaked.', confirmLabel: 'Disable', tone: 'danger' });
                if (r.confirmed) disable.mutate(b);
              },
            },
          ]}
        />
      ),
    },
  ];
  return (
    <Card title="Batches" padded={false}>
      <DataTable caption="Voucher batches" columns={columns} rows={batches.data.data} rowKey={(b) => b.id} />
    </Card>
  );
}

const DEFAULTS = { q: '', status: '', kind: '', batch: '', voucher: '', page: 1, pageSize: 25 };

export default function VouchersPage() {
  const { can } = useAuth();
  const [state, setState, reset] = useUrlState(DEFAULTS);
  const [search, setSearch] = useState(String(state.q ?? ''));
  const q = useDebounced(search.trim(), 300);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  useEffect(() => {
    if (q !== (state.q ?? '')) setState({ q });
  }, [q]); // only the debounced search text drives the URL

  const query = useMemo(() => ({ ...cleanQuery(state, ['voucher', 'batch']), batchId: state.batch || undefined }), [state]);
  const vouchers = useQuery({
    queryKey: ['vouchers', query],
    queryFn: ({ signal }) => api.get<Page<Voucher>>('/api/admin/vouchers', query, signal),
    placeholderData: keepPreviousData,
  });
  const open = vouchers.data?.data.find((v) => v.id === state.voucher);
  const filtered = Boolean(state.q || state.status || state.kind || state.batch);

  const columns: Column<Voucher>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (v) => (
        <span className="min-w-0">
          <span className="block font-mono">{v.code}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{v.name}</span>
        </span>
      ),
    },
    { key: 'gives', header: 'Gives', cell: (v) => givesText(v) },
    { key: 'status', header: 'Status', cell: (v) => <VoucherState voucher={v} /> },
    { key: 'redeemed', header: 'Redeemed by', priority: 'secondary', cell: (v) => (v.redeemed_at ? <span className="truncate">{v.redeemed_by ?? '—'}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'expires', header: 'Expires', priority: 'low', cell: (v) => (v.expires_at ? <When value={v.expires_at} relative={false} /> : <span className="text-muted-foreground">Never</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Gift vouchers"
        description="Codes that give a product or account credit. Issue them one at a time or in batches; each is redeemed once."
        actions={
          can('billing.vouchers.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setIssuing(true)}>
              Issue vouchers
            </Button>
          )
        }
      />
      <div className="space-y-4">
        {state.batch && (
          <Callout
            title="Showing one batch"
            action={
              <Button variant="outline" size="sm" onClick={() => setState({ batch: undefined })}>
                Show all vouchers
              </Button>
            }
          >
            Only the vouchers of this batch are listed.
          </Callout>
        )}
        <Card padded={false}>
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} placeholder="Search code, name or customer email…" className="w-full sm:w-72" />
            <Select
              aria-label="Status"
              className="w-auto"
              value={String(state.status)}
              onChange={(e) => setState({ status: e.target.value })}
              placeholder="Any status"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'redeemed', label: 'Redeemed' },
                { value: 'expired', label: 'Expired' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
            <Select aria-label="Gives" className="w-auto" value={String(state.kind)} onChange={(e) => setState({ kind: e.target.value })} placeholder="Products and credit" options={[{ value: 'product', label: 'Products' }, { value: 'credit', label: 'Account credit' }]} />
            {filtered && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  reset();
                }}
              >
                Clear
              </Button>
            )}
          </Toolbar>
          {vouchers.error ? (
            <ErrorState error={vouchers.error} onRetry={() => void vouchers.refetch()} />
          ) : (
            <DataTable
              caption="Gift vouchers"
              columns={columns}
              rows={vouchers.data?.data}
              rowKey={(v) => v.id}
              rowHref={(v) => `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(cleanQuery(state, ['voucher'])).map(([k, val]) => [k, String(val)])), voucher: v.id })}`}
              loading={vouchers.isLoading}
              fetching={vouchers.isFetching && !vouchers.isLoading}
              empty={filtered ? <EmptyState title="No vouchers match" /> : <EmptyState icon={<Gift />} title="No vouchers yet" description="Issue gift codes for products or account credit, for partners, giveaways or support goodwill." />}
            />
          )}
          {vouchers.data && <Pagination page={vouchers.data.page} pageSize={vouchers.data.pageSize} total={vouchers.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
        </Card>
        <BatchesCard
          onShow={(b) => {
            setSearch('');
            setState({ batch: b.id, q: undefined, status: undefined, kind: undefined });
          }}
        />
        <p className="text-xs text-muted-foreground">
          Customers redeem codes in your app through <code className="font-mono">POST /api/client/vouchers/redeem</code>, or your backend does with{' '}
          <code className="font-mono">POST /api/v1/vouchers/redeem</code>. Every redemption is in the <Link to="/admin/audit" className="text-primary hover:underline">audit log</Link>.
        </p>
      </div>
      {issuing && <IssueDialog open={issuing} onOpenChange={setIssuing} onIssued={setIssued} />}
      {issued && <IssuedModal issued={issued} onClose={() => setIssued(null)} />}
      {open && <VoucherDialog key={open.id} voucher={open} onClose={() => setState({ voucher: undefined }, { resetPage: false })} />}
    </>
  );
}
