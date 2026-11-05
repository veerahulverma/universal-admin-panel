import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Archive, Boxes, Copy, Eye, EyeOff, MoreHorizontal, Pencil, Plus, RotateCcw, Rocket, Undo2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { dateTime, money, num } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
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
  StatusBadge,
  Tabs,
  useConfirm,
  type MenuItem,
} from '../../components/ui';
import { FeatureLimitsEditor } from './FeatureLimitsEditor';
import { PriceDialog } from './PriceDialog';
import { ProductDialog } from './ProductForm';
import { BundleRulesTab } from './BundleRulesTab';
import { KIND_LABEL, describePrice, priceTerms, slugify, stockText, useFormErrors, useMeters, type Price, type Product, type ProductDetail } from './shared';

function PriceStockDialog({ product, price, onClose }: { product: ProductDetail; price: Price; onClose: () => void }) {
  const [limit, setLimit] = useState(price.stockLimit === null ? '' : String(price.stockLimit));
  const errors = useFormErrors();
  const save = useAction(() => api.patch<Price>(`/api/admin/prices/${price.id}`, { stockLimit: limit.trim() === '' ? null : Math.max(0, Math.trunc(Number(limit))) }), {
    success: 'Stock updated',
    invalidate: [['product', product.id]],
    onSuccess: onClose,
    onError: (err) => errors.set(err, ['stockLimit']),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Stock at this price"
      description={`${describePrice(price)}: ${num(price.stock?.sold ?? 0)} sold, ${num(price.stock?.reserved ?? 0)} awaiting payment.`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="price-stock-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="price-stock-form"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        <Field label="Units for sale" htmlFor="ps-limit" hint="Empty: unlimited. Sales stop once sold and reserved units reach it." error={errors.fields.stockLimit}>
          <Input id="ps-limit" type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function DuplicateDialog({ product, open, onOpenChange }: { product: ProductDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(`${product.name} (copy)`);
  const [key, setKey] = useState(slugify(`${product.key}_copy`));
  const errors = useFormErrors();
  const dup = useAction(() => api.post<Product>(`/api/admin/products/${product.id}/duplicate`, { key, name }), {
    success: 'Product duplicated as a draft',
    invalidate: [['products']],
    onSuccess: (p) => {
      onOpenChange(false);
      navigate(`/catalog/products/${p.id}`);
    },
    onError: (err) => errors.set(err, ['key', 'name']),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Duplicate ${product.name}`}
      description="Copies the active prices and every feature limit into a new draft product."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="dup-form" loading={dup.isPending}>
            Duplicate
          </Button>
        </>
      }
    >
      <form
        id="dup-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          dup.mutate();
        }}
      >
        <FormError message={errors.general} />
        <Field label="Name" htmlFor="dup-name" error={errors.fields.name}>
          <Input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Key" htmlFor="dup-key" error={errors.fields.key}>
          <Input id="dup-key" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" required />
        </Field>
      </form>
    </Modal>
  );
}

function PricingTab({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const meters = useMeters(true);
  const [adding, setAdding] = useState(false);
  const [stocking, setStocking] = useState<Price | null>(null);
  const manage = can('catalog.products.manage');
  const unitOf = (key: string | null) => meters.data?.data.find((m) => m.key === key)?.unit;
  const patch = useAction(({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch<Price>(`/api/admin/prices/${id}`, body), {
    success: (_r, v) => (v.body.active === false ? 'Price archived' : v.body.active === true ? 'Price reactivated' : 'Price renamed'),
    invalidate: [['product', product.id], ['products']],
  });
  const active = product.prices.filter((p) => p.active);

  return (
    <div className="space-y-4">
      {product.status === 'active' && active.length === 0 && product.plan_type !== 'free' && (
        <Callout tone="warning" title="No active price">
          Customers can't buy this product until it has at least one active price.
        </Callout>
      )}
      <Card
        title="Prices"
        description="A product can have prices in several currencies and billing intervals."
        padded={false}
        actions={
          manage && (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add price
            </Button>
          )
        }
      >
        <DataTable
          caption="Prices"
          rows={product.prices}
          rowKey={(p) => p.id}
          empty={<EmptyState title="No prices yet" description={product.plan_type === 'free' ? 'Free plans need no price.' : 'Add a price so customers can subscribe or buy.'} />}
          columns={[
            {
              key: 'price',
              header: 'Price',
              cell: (p) => (
                <span className="min-w-0">
                  <span className="block">{describePrice(p, unitOf(p.meterKey))}</span>
                  {p.nickname && <span className="block text-xs text-muted-foreground">{p.nickname}</span>}
                </span>
              ),
            },
            { key: 'currency', header: 'Currency', cell: (p) => p.currency },
            {
              key: 'details',
              header: 'Details',
              cell: (p) => (
                <span className="flex flex-wrap gap-1">
                  {priceTerms(p) && <Badge tone="primary">{priceTerms(p)}</Badge>}
                  {stockText(p.stockLimit, p.stock) && <Badge tone={p.stock?.available ? 'neutral' : 'warning'}>{stockText(p.stockLimit, p.stock)}</Badge>}
                  {p.introAmount !== null && p.introCycles !== null && <Badge tone="info">intro {money(p.introAmount, p.currency)} × {p.introCycles}</Badge>}
                  {p.taxBehavior === 'inclusive' && <Badge>tax incl.</Badge>}
                  {p.pricingModel === 'per_seat' && (p.minQuantity > 1 || p.maxQuantity) && (
                    <Badge>
                      {p.minQuantity}–{p.maxQuantity ?? '∞'} seats
                    </Badge>
                  )}
                  {p.tiers && <Badge>{p.tiers.length} tiers</Badge>}
                </span>
              ),
            },
            { key: 'id', header: 'Price ID', priority: 'low', cell: (p) => <Mono copy>{p.id}</Mono> },
            { key: 'status', header: 'Status', cell: (p) => <StatusBadge status={p.active ? 'active' : 'archived'} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (p) =>
                manage ? (
                  <Menu
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label="Price actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                    items={[
                      {
                        label: 'Rename',
                        icon: <Pencil className="size-4" />,
                        onSelect: async () => {
                          const r = await confirm({ title: 'Rename price', confirmLabel: 'Save', reason: { label: 'Nickname', placeholder: p.nickname ?? 'e.g. Launch price' } });
                          if (r.confirmed) patch.mutate({ id: p.id, body: { nickname: r.reason ?? null } });
                        },
                      },
                      { label: 'Stock…', icon: <Boxes className="size-4" />, onSelect: () => setStocking(p) },
                      {
                        label: 'Archive',
                        icon: <Archive className="size-4" />,
                        hidden: !p.active,
                        danger: true,
                        onSelect: async () => {
                          const r = await confirm({ title: `Archive ${describePrice(p, unitOf(p.meterKey))}?`, description: 'New customers can no longer choose this price. You can reactivate it later.', confirmLabel: 'Archive', tone: 'danger' });
                          if (r.confirmed) patch.mutate({ id: p.id, body: { active: false } });
                        },
                      },
                      { label: 'Reactivate', icon: <RotateCcw className="size-4" />, hidden: p.active, onSelect: () => patch.mutate({ id: p.id, body: { active: true } }) },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      </Card>
      {product.prices.some((p) => p.tiers) && (
        <Card title="Tiers">
          <div className="grid gap-4 md:grid-cols-2">
            {product.prices
              .filter((p) => p.tiers)
              .map((p) => (
                <div key={p.id}>
                  <p className="mb-1.5 text-sm font-medium">
                    {p.nickname ?? describePrice(p, unitOf(p.meterKey))} · {p.tierMode}
                  </p>
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-1 font-medium">Up to</th>
                        <th className="py-1 text-right font-medium">Per unit</th>
                        <th className="py-1 text-right font-medium">Flat</th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {p.tiers!.map((t, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-1">{t.upTo === null ? '∞' : num(t.upTo)}</td>
                          <td className="py-1 text-right">{money(t.unitAmount, p.currency)}</td>
                          <td className="py-1 text-right">{t.flatAmount ? money(t.flatAmount, p.currency) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        </Card>
      )}
      {adding && <PriceDialog product={product} open={adding} onOpenChange={setAdding} />}
      {stocking && <PriceStockDialog product={product} price={stocking} onClose={() => setStocking(null)} />}
    </div>
  );
}

function OverviewTab({ product: p }: { product: ProductDetail }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Details" className="lg:col-span-2">
        <KeyValue
          items={[
            { label: 'Key', value: <Mono copy>{p.key}</Mono> },
            { label: 'Product ID', value: <Mono copy>{p.id}</Mono> },
            { label: 'Type', value: `${KIND_LABEL[p.kind]}${p.plan_type ? ` · ${p.plan_type}` : ''}` },
            { label: 'Subscribed by', value: p.subscriber_type === 'organization' ? 'Organizations' : 'Individual users', hidden: p.kind === 'one_time' || p.kind === 'credit_pack' },
            { label: 'Free trial', value: p.trial_days ? `${p.trial_days} days${p.trial_requires_payment_method ? ' (payment method required)' : ''}` : 'None', hidden: p.kind !== 'plan' },
            { label: 'Grace period', value: `${p.grace_days} days after a failed renewal`, hidden: p.kind !== 'plan' && p.kind !== 'addon' },
            { label: 'Credits', value: p.credit_amount ? `${num(p.credit_amount)} ${p.credit_type ?? 'credits'}${p.credits_expire_days ? `, expire after ${p.credits_expire_days} days` : ', never expire'}` : null, hidden: p.kind !== 'credit_pack' },
            { label: 'Visibility', value: p.is_public ? 'Listed publicly' : 'Hidden from public pricing' },
            { label: 'Display order', value: p.sort_order },
            { label: 'Created', value: dateTime(p.created_at) },
            { label: 'Last updated', value: dateTime(p.updated_at) },
          ]}
        />
        {p.description && <p className="mt-4 whitespace-pre-wrap border-t pt-4 text-sm">{p.description}</p>}
      </Card>
      <div className="space-y-4">
        <Card title="Highlights">
          {p.highlights.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {p.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None. Highlights appear on pricing tables.</p>
          )}
        </Card>
        {Object.keys(p.metadata ?? {}).length > 0 && (
          <Card title="Metadata">
            <JsonView value={p.metadata} />
          </Card>
        )}
        {Object.keys(p.gateway_refs ?? {}).length > 0 && (
          <Card title="Payment gateway references">
            <JsonView value={p.gateway_refs} />
          </Card>
        )}
      </div>
    </div>
  );
}

const TAB_DEFAULTS = { tab: 'overview' };

export default function ProductDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [state, setState] = useUrlState(TAB_DEFAULTS);
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api.get<ProductDetail>(`/api/admin/products/${id}`) });
  const update = useAction((body: Record<string, unknown>) => api.patch<Product>(`/api/admin/products/${id}`, body), {
    success: (_r, b) => (b.status === 'archived' ? 'Product archived' : b.status === 'active' ? 'Product is live' : b.status === 'draft' ? 'Moved to draft' : 'Product updated'),
    invalidate: [['product', id], ['products']],
  });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const manage = can('catalog.products.manage');
  const activePrices = p.prices.filter((x) => x.active).length;

  const actions: MenuItem[] = [
    { label: 'Duplicate', icon: <Copy className="size-4" />, onSelect: () => setDuplicating(true) },
    { label: p.is_public ? 'Hide from public pricing' : 'List publicly', icon: p.is_public ? <EyeOff className="size-4" /> : <Eye className="size-4" />, hidden: p.status === 'archived', onSelect: () => update.mutate({ isPublic: !p.is_public }) },
    { label: 'Move to draft', icon: <Undo2 className="size-4" />, hidden: p.status !== 'active', onSelect: () => update.mutate({ status: 'draft' }) },
    { separator: true, label: '' },
    {
      label: 'Archive',
      icon: <Archive className="size-4" />,
      danger: true,
      hidden: p.status === 'archived',
      onSelect: async () => {
        const r = await confirm({
          title: `Archive ${p.name}?`,
          description: 'It disappears from public pricing, can no longer be purchased or granted, and is hidden from the product list. You can restore it later.',
          confirmLabel: 'Archive',
          tone: 'danger',
        });
        if (r.confirmed) update.mutate({ status: 'archived' });
      },
    },
    { label: 'Restore as draft', icon: <RotateCcw className="size-4" />, hidden: p.status !== 'archived', onSelect: () => update.mutate({ status: 'draft' }) },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Plans & products', to: '/catalog/products' }, { label: p.name }]}
        title={p.name}
        description={p.description || undefined}
        meta={
          <>
            <Badge tone={p.kind === 'plan' ? 'primary' : 'neutral'}>{KIND_LABEL[p.kind]}</Badge>
            <StatusBadge status={p.status} />
            {!p.is_public && <Badge>hidden</Badge>}
            {p.trial_days > 0 && <Badge tone="info">{p.trial_days}-day trial</Badge>}
            <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
          </>
        }
        actions={
          manage && (
            <>
              {p.status === 'draft' && (
                <Button icon={<Rocket className="size-4" />} loading={update.isPending && update.variables?.status === 'active'} onClick={() => update.mutate({ status: 'active' })}>
                  Publish
                </Button>
              )}
              <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={actions} />
            </>
          )
        }
      />
      {p.status === 'archived' && (
        <div className="mb-4">
          <Callout tone="warning" title="This product is archived">
            It is not offered to customers. Restore it as a draft to make changes and publish it again.
          </Callout>
        </div>
      )}
      <Tabs
        value={String(state.tab)}
        onValueChange={(tab) => setState({ tab })}
        tabs={[
          { value: 'overview', label: 'Overview', content: <OverviewTab product={p} /> },
          { value: 'pricing', label: 'Pricing', count: activePrices, content: <PricingTab product={p} /> },
          { value: 'features', label: 'Features & limits', count: p.features.length, content: <FeatureLimitsEditor product={p} /> },
          { value: 'rules', label: 'Bundle & rules', count: p.bundle.length || undefined, content: <BundleRulesTab product={p} /> },
        ]}
      />
      {editing && <ProductDialog open={editing} onOpenChange={setEditing} product={p} />}
      {duplicating && <DuplicateDialog product={p} open={duplicating} onOpenChange={setDuplicating} />}
    </>
  );
}
