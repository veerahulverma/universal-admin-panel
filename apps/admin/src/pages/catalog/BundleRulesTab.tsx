import { useState } from 'react';
import { Link } from 'react-router';
import { Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, FormError, Input, KeyValue, Modal, SearchInput, Skeleton } from '../../components/ui';
import { KIND_LABEL, useFormErrors, useProductList, type Product, type ProductDetail, type ProductRef } from './shared';

function ProductLinks({ ids, products, empty }: { ids: string[]; products: Map<string, { id: string; name: string }>; empty: string }) {
  if (!ids.length) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1">
      {ids.map((id) => (
        <Link key={id} to={`/catalog/products/${id}`} className="text-primary hover:underline">
          {products.get(id)?.name ?? id}
        </Link>
      ))}
    </span>
  );
}

/** Checkbox list of products with a filter, for rules and bundles. */
function ProductChecklist({ id, products, selected, onChange, disabled }: { id: string; products: Product[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: (p: Product) => string | null }) {
  const [q, setQ] = useState('');
  const shown = products.filter((p) => !q || `${p.name} ${p.key}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-2">
      {products.length > 8 && <SearchInput value={q} onChange={setQ} placeholder="Filter products…" className="w-full" />}
      <div id={id} className="grid max-h-56 gap-x-4 gap-y-2 overflow-y-auto rounded-ui-sm border p-3 sm:grid-cols-2">
        {shown.map((p) => {
          const reason = disabled?.(p) ?? null;
          return (
            <Checkbox
              key={p.id}
              label={p.name}
              description={reason ?? `${KIND_LABEL[p.kind]} · ${p.key}`}
              checked={selected.includes(p.id)}
              disabled={Boolean(reason) && !selected.includes(p.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
            />
          );
        })}
        {!shown.length && <p className="text-sm text-muted-foreground">No products match.</p>}
      </div>
    </div>
  );
}

const limitText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const limitValue = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.trunc(Number(s))));

function RulesDialog({ product, open, onOpenChange }: { product: ProductDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const list = useProductList();
  const [requires, setRequires] = useState(product.requires_products);
  const [excludes, setExcludes] = useState(product.excludes_products);
  const [purchaseLimit, setPurchaseLimit] = useState(limitText(product.purchase_limit));
  const [stockLimit, setStockLimit] = useState(limitText(product.stock_limit));
  const errors = useFormErrors();
  const others = (list.data?.data ?? []).filter((p) => p.id !== product.id);
  const save = useAction(
    () => api.patch<Product>(`/api/admin/products/${product.id}`, { requiresProducts: requires, excludesProducts: excludes, purchaseLimit: limitValue(purchaseLimit) || null, stockLimit: limitValue(stockLimit) }),
    {
      success: 'Purchase rules saved',
      invalidate: [['product', product.id], ['products']],
      onSuccess: () => onOpenChange(false),
      onError: (err) => errors.set(err, ['requiresProducts', 'excludesProducts', 'purchaseLimit', 'stockLimit']),
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Purchase rules and stock"
      description="Checked at checkout, on carts and invoices, and when an administrator starts a subscription."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="rules-form" loading={save.isPending}>
            Save rules
          </Button>
        </>
      }
    >
      <form
        id="rules-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        {list.isLoading ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            <Field label="Requires one of" htmlFor="rules-requires" hint="Customers must already have one of these, or buy it in the same order. None checked: no requirement." error={errors.fields.requiresProducts}>
              <ProductChecklist id="rules-requires" products={others} selected={requires} onChange={setRequires} disabled={(p) => (excludes.includes(p.id) ? 'Excluded below' : null)} />
            </Field>
            <Field label="Cannot be bought with" htmlFor="rules-excludes" hint="Customers who have one of these, or buy it in the same order, cannot buy this product." error={errors.fields.excludesProducts}>
              <ProductChecklist id="rules-excludes" products={others} selected={excludes} onChange={setExcludes} disabled={(p) => (requires.includes(p.id) ? 'Required above' : null)} />
            </Field>
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Per customer" htmlFor="rules-limit" hint="Units one customer can buy in all (a subscription counts once). Empty: no limit." error={errors.fields.purchaseLimit}>
            <Input id="rules-limit" type="number" min={1} value={purchaseLimit} onChange={(e) => setPurchaseLimit(e.target.value)} placeholder="No limit" />
          </Field>
          <Field label="Stock" htmlFor="rules-stock" hint={`Units for sale in all, across prices. ${num(product.stock.sold)} sold and ${num(product.stock.reserved)} awaiting payment so far. Empty: unlimited.`} error={errors.fields.stockLimit}>
            <Input id="rules-stock" type="number" min={0} value={stockLimit} onChange={(e) => setStockLimit(e.target.value)} placeholder="Unlimited" />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function BundleDialog({ product, open, onOpenChange }: { product: ProductDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const list = useProductList();
  const [selected, setSelected] = useState(product.bundle.map((p) => p.id));
  const errors = useFormErrors();
  const containers = new Set(product.includedIn.map((p) => p.id));
  const candidates = (list.data?.data ?? []).filter((p) => p.id !== product.id);
  const save = useAction(() => api.put<{ productIds: string[] }>(`/api/admin/products/${product.id}/bundle`, { productIds: selected }), {
    success: (r) => (r.productIds.length ? `Bundle includes ${r.productIds.length} product${r.productIds.length === 1 ? '' : 's'}` : 'Bundle emptied'),
    invalidate: [['product', product.id], ['product'], ['products']],
    onSuccess: () => onOpenChange(false),
    onError: (err) => errors.set(err, []),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Products included in ${product.name}`}
      description="Customers who own this product also get the features and plans of every product checked here, for as long as they own it."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="bundle-form" loading={save.isPending}>
            Save bundle
          </Button>
        </>
      }
    >
      <form
        id="bundle-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          errors.clear();
          save.mutate();
        }}
      >
        <FormError message={errors.general} />
        {list.isLoading ? (
          <Skeleton className="h-40" />
        ) : (
          <ProductChecklist
            id="bundle-products"
            products={candidates}
            selected={selected}
            onChange={setSelected}
            disabled={(p) => (p.kind === 'credit_pack' ? 'Credit packs cannot be included' : containers.has(p.id) ? `Already includes ${product.name}` : null)}
          />
        )}
      </form>
    </Modal>
  );
}

function RefList({ refs, empty }: { refs: ProductRef[]; empty: string }) {
  if (!refs.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {refs.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <Link to={`/catalog/products/${p.id}`} className="min-w-0 truncate text-primary hover:underline">
            {p.name}
          </Link>
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge>{KIND_LABEL[p.kind]}</Badge>
            {p.status !== 'active' && <Badge tone="warning">{p.status}</Badge>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Who may buy the product, how many are left, and what it includes. */
export function BundleRulesTab({ product }: { product: ProductDetail }) {
  const { can } = useAuth();
  const manage = can('catalog.products.manage');
  const list = useProductList();
  const [editing, setEditing] = useState<'rules' | 'bundle' | null>(null);
  const names = new Map((list.data?.data ?? []).map((p) => [p.id, p]));
  const { stock } = product;
  const ruled = product.requires_products.length > 0 || product.excludes_products.length > 0 || product.purchase_limit !== null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title="Purchase rules and stock"
        actions={
          manage && (
            <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setEditing('rules')}>
              Edit
            </Button>
          )
        }
      >
        <KeyValue
          columns={1}
          items={[
            { label: 'Requires one of', value: <ProductLinks ids={product.requires_products} products={names} empty="No requirement" /> },
            { label: 'Cannot be bought with', value: <ProductLinks ids={product.excludes_products} products={names} empty="No exclusions" /> },
            { label: 'Per customer', value: product.purchase_limit ? `At most ${num(product.purchase_limit)}` : 'No limit' },
            {
              label: 'Stock',
              value: stock.limit === null ? `Unlimited · ${num(stock.sold)} sold` : `${num(stock.available)} of ${num(stock.limit)} left · ${num(stock.sold)} sold, ${num(stock.reserved)} awaiting payment`,
            },
          ]}
        />
        {stock.limit !== null && stock.available === 0 && (
          <div className="mt-3">
            <Callout tone="warning" title="Sold out">
              New sales are refused until you raise the stock or reserved sales expire.
            </Callout>
          </div>
        )}
        {!ruled && stock.limit === null && <p className="mt-3 text-xs text-muted-foreground">Anyone can buy this product, as often as they like.</p>}
      </Card>
      <Card
        title="Bundle"
        description="Owning this product confers the products it includes."
        actions={
          manage &&
          product.kind !== 'credit_pack' && (
            <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setEditing('bundle')}>
              Edit
            </Button>
          )
        }
      >
        {product.bundle.length === 0 && product.includedIn.length === 0 ? (
          <EmptyState title="Not a bundle" description={product.kind === 'credit_pack' ? 'Credit packs add credits and cannot include products.' : 'Include other products to sell them together as one.'} />
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Includes</p>
              <RefList refs={product.bundle} empty="Nothing." />
            </div>
            {product.includedIn.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Included in</p>
                <RefList refs={product.includedIn} empty="" />
              </div>
            )}
          </div>
        )}
      </Card>
      {editing === 'rules' && <RulesDialog product={product} open onOpenChange={(o) => !o && setEditing(null)} />}
      {editing === 'bundle' && <BundleDialog product={product} open onOpenChange={(o) => !o && setEditing(null)} />}
    </div>
  );
}
