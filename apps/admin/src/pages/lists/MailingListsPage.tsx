import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MailPlus, Plus } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { num } from '../../lib/format';
import { Badge, Button, Callout, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Select, Textarea, When } from '../../components/ui';
import { ProductChecklist, useMailingLists, type ListProvider, type MailingList } from './shared';

function NewListDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', key: '', description: '', visibility: 'public', doubleOptIn: true, autoProductIds: [] as string[] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    () =>
      api.post<MailingList>('/api/admin/lists', {
        name: form.name,
        key: form.key || undefined,
        description: form.description,
        visibility: form.visibility,
        doubleOptIn: form.doubleOptIn,
        autoProductIds: form.autoProductIds,
      }),
    {
      success: 'Mailing list created',
      invalidate: [['mailing-lists']],
      onSuccess: (l) => {
        onClose();
        navigate(`/growth/lists/${l.id}`);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New mailing list"
      description="People join public lists themselves (from your app or the client API); hidden lists are filled by you, your application or a product rule."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-list" loading={create.isPending}>
            Create list
          </Button>
        </>
      }
    >
      <form
        id="new-list"
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
        <Field label="Name" htmlFor="nl-name" error={errors.name} required>
          <Input id="nl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required autoFocus placeholder="Product updates" />
        </Field>
        <Field label="Key" htmlFor="nl-key" error={errors.key} hint="How your application refers to it; generated from the name when empty">
          <Input id="nl-key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase() })} maxLength={64} className="font-mono" placeholder="product-updates" />
        </Field>
        <Field label="Description" htmlFor="nl-desc" className="sm:col-span-2" hint="Shown to customers choosing their lists">
          <Textarea id="nl-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="Visibility" htmlFor="nl-visibility">
          <Select id="nl-visibility" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} options={[{ value: 'public', label: 'Public: customers can join' }, { value: 'hidden', label: 'Hidden: managed by you' }]} />
        </Field>
        <div className="flex items-end pb-1">
          <Checkbox checked={form.doubleOptIn} onChange={(e) => setForm({ ...form, doubleOptIn: e.target.checked })} label="Double opt-in" description="New subscribers confirm by email first" />
        </div>
        <Field label="Product rule (optional)" className="sm:col-span-2" hint="People who have any of these products join automatically and leave when their access ends" error={errors.autoProductIds}>
          <ProductChecklist value={form.autoProductIds} onChange={(ids) => setForm({ ...form, autoProductIds: ids })} label="Products that put people on this list" />
        </Field>
      </form>
    </Modal>
  );
}

function ProvidersCallout() {
  const providers = useQuery({ queryKey: ['list-providers'], queryFn: () => api.get<{ data: ListProvider[] }>('/api/admin/lists/providers'), staleTime: 60_000 });
  const connected = (providers.data?.data ?? []).filter((p) => p.connected);
  if (providers.isLoading || providers.error) return null;
  if (!connected.length) {
    return (
      <Callout title="External newsletter services: not connected">
        Lists are kept in Steward. To keep a list in sync with Mailchimp or another service, install a plugin that provides it (it listens to the <code className="font-mono">list.member_subscribed</code> and <code className="font-mono">list.member_unsubscribed</code> events). Nothing is sent to any external service until then.
      </Callout>
    );
  }
  return <Callout tone="success" title="Connected newsletter services">{connected.map((p) => p.name).join(', ')} can sync lists. Choose the service in a list’s settings.</Callout>;
}

export default function MailingListsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const lists = useMailingLists();
  return (
    <>
      <PageHeader
        title="Mailing lists"
        description="Lists people subscribe to with recorded consent, optionally confirmed by email. Product rules keep a list in step with who has a product. Send a campaign to a list from Campaigns."
        actions={
          can('marketing.lists.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New list
            </Button>
          )
        }
      />
      <div className="mb-4">
        <ProvidersCallout />
      </div>
      <Card padded={false}>
        {lists.error ? (
          <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />
        ) : (
          <DataTable
            caption="Mailing lists"
            rows={lists.data?.data}
            loading={lists.isLoading}
            rowKey={(l) => l.id}
            rowHref={(l) => `/growth/lists/${l.id}`}
            empty={<EmptyState icon={<MailPlus />} title="No mailing lists yet" description="For example a public “Product updates” list, or a hidden list of everyone on the Pro plan." />}
            columns={[
              {
                key: 'name',
                header: 'List',
                cell: (l) => (
                  <span className="block min-w-0 max-w-md">
                    <span className="block truncate">{l.name}</span>
                    <span className="block truncate font-mono text-xs font-normal text-muted-foreground">{l.key}</span>
                  </span>
                ),
              },
              { key: 'visibility', header: 'Visibility', cell: (l) => <Badge tone={l.visibility === 'public' ? 'success' : 'neutral'}>{l.visibility}</Badge> },
              { key: 'optin', header: 'Opt-in', cell: (l) => (l.double_opt_in ? <Badge tone="info">double</Badge> : <Badge>single</Badge>) },
              { key: 'rule', header: 'Product rule', priority: 'low', cell: (l) => (l.auto_product_ids.length ? `${l.auto_product_ids.length} ${l.auto_product_ids.length === 1 ? 'product' : 'products'}` : <span className="text-muted-foreground">—</span>) },
              { key: 'subscribed', header: 'Subscribed', align: 'right', cell: (l) => <span className="tabular">{num(l.subscribed_count ?? 0)}</span> },
              { key: 'pending', header: 'Pending', align: 'right', priority: 'low', cell: (l) => <span className="tabular">{num(l.pending_count ?? 0)}</span> },
              { key: 'updated', header: 'Updated', cell: (l) => <When value={l.updated_at} /> },
            ]}
          />
        )}
      </Card>
      {creating && <NewListDialog onClose={() => setCreating(false)} />}
    </>
  );
}
