import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Checkbox, Skeleton, type OptionGroup } from '../../components/ui';

// ---- Products ----------------------------------------------------------------------------------

export interface ProductOption {
  id: string;
  key: string;
  name: string;
  kind: string;
  status: string;
}

/** Active products (shared cache with the catalog pages); needs catalog.products.view. */
export function useProductOptions() {
  const { can } = useAuth();
  const allowed = can('catalog.products.view');
  const query = useQuery({ queryKey: ['products', 'all-active'], queryFn: () => api.get<{ data: ProductOption[] }>('/api/admin/products'), enabled: allowed, staleTime: 60_000 });
  return { ...query, allowed };
}

/** Pick products by name: plans, add-ons and one-time products. */
export function ProductChecklist({ value, onChange, disabled, label }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; label: string }) {
  const products = useProductOptions();
  if (!products.allowed) {
    return <p className="text-sm text-muted-foreground">{value.length ? `${value.length} selected. ` : ''}Viewing products needs the catalog permission.</p>;
  }
  if (products.isLoading) return <Skeleton className="h-24" />;
  const rows = products.data?.data ?? [];
  if (!rows.length) return <p className="text-sm text-muted-foreground">No products yet.</p>;
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((v) => v !== id));
  return (
    <fieldset className="max-h-56 space-y-1.5 overflow-y-auto rounded-ui-sm border p-2.5" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {rows.map((p) => (
        <Checkbox
          key={p.id}
          checked={value.includes(p.id)}
          onChange={(e) => toggle(p.id, e.target.checked)}
          label={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {p.name} <span className="font-mono text-xs font-normal text-muted-foreground">{p.key}</span>
              {p.kind !== 'plan' && <Badge>{p.kind.replace(/_/g, ' ')}</Badge>}
            </span>
          }
        />
      ))}
    </fieldset>
  );
}

// ---- Mailing lists --------------------------------------------------------------------------------

export interface MailingList {
  id: string;
  key: string;
  name: string;
  description: string;
  visibility: 'public' | 'hidden';
  double_opt_in: boolean;
  auto_product_ids: string[];
  external_provider: string | null;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
  subscribed_count?: number;
  pending_count?: number;
}

export interface ListDetail extends MailingList {
  counts: { subscribed: number; pending: number; unsubscribed: number; reachable: number };
  products: { id: string; key: string; name: string }[];
  campaigns: { id: string; name: string; status: string; completed_at: string | null }[];
  external: { provider: string; ref: string | null; connected: boolean; name: string | null } | null;
}

export interface ListProvider {
  id: string;
  name: string;
  connected: boolean;
  detail?: string | null;
}

export function useMailingLists(enabled = true) {
  return useQuery({ queryKey: ['mailing-lists'], queryFn: () => api.get<{ data: MailingList[] }>('/api/admin/lists'), enabled, staleTime: 30_000 });
}

// ---- Campaign audiences ---------------------------------------------------------------------------------

/** A campaign goes to a segment or to a list's subscribers; selects encode the choice as `segment:<id>` or `list:<id>`. */
export function audienceOptions(segments: { id: string; name: string }[], lists: { id: string; name: string }[]): OptionGroup[] {
  return [
    ...(segments.length ? [{ label: 'Segments', options: segments.map((s) => ({ value: `segment:${s.id}`, label: s.name })) }] : []),
    ...(lists.length ? [{ label: 'Mailing lists', options: lists.map((l) => ({ value: `list:${l.id}`, label: l.name })) }] : []),
  ];
}

export function audienceValue(c: { segment_id: string | null; list_id?: string | null }): string {
  if (c.list_id) return `list:${c.list_id}`;
  return c.segment_id ? `segment:${c.segment_id}` : '';
}

/** The API fields for an audience choice. */
export function audienceBody(audience: string): { segmentId?: string; listId?: string } {
  const [kind, ...rest] = audience.split(':');
  const id = rest.join(':');
  if (!id) return {};
  return kind === 'list' ? { listId: id } : { segmentId: id };
}

/** How someone joined a list. */
export const SOURCE_LABEL: Record<string, string> = {
  customer: 'Joined themselves',
  admin: 'Added by an administrator',
  api: 'Added by your application',
  rule: 'Product rule',
  double_opt_in: 'Confirmed by email',
  unsubscribe_link: 'Unsubscribe link',
};

/** Why a member does not receive list email (see BLOCK_REASON on the server). */
export const BLOCK_LABEL: Record<string, string> = {
  not_subscribed: 'Not subscribed',
  inactive_recipient: 'Account deleted or banned',
  no_consent: 'Needs marketing consent',
  unsubscribe: 'Unsubscribed from all marketing',
  unsubscribed: 'Opted out of marketing',
  hard_bounce: 'Address bounced',
  complaint: 'Marked as spam',
  manual: 'Suppressed by an administrator',
};
