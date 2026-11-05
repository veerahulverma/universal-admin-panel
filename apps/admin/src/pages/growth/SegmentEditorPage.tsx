import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Megaphone, Plus, Trash2, Users } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useDebounced } from '../../lib/hooks';
import { num } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  Money,
  PageHeader,
  PageSkeleton,
  Pagination,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  When,
  useConfirm,
} from '../../components/ui';
import { ConditionRow, newCondition, type Segment, type SegmentRules } from './segment-rules';
import { useBaseCurrency, useTabParam } from './shared';

interface Preview {
  total: number;
  reachable: number;
  sample: { id: string; email: string; name: string | null; country: string | null; marketing_consent: boolean; created_at: string }[];
}

interface Member {
  id: string;
  email: string;
  name: string | null;
  country: string | null;
  status: string;
  marketing_consent: boolean;
  lifetime_revenue: number;
  created_at: string;
}

function AudiencePreview({ rules, enabled }: { rules: SegmentRules; enabled: boolean }) {
  const key = JSON.stringify(rules);
  const debounced = useDebounced(key, 400);
  const preview = useQuery({
    queryKey: ['segment-preview', debounced],
    queryFn: () => api.post<Preview>('/api/admin/segments/preview', { rules: JSON.parse(debounced) }),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const p = preview.data;
  const stale = preview.isFetching || key !== debounced;
  return (
    <Card title="Audience preview" description="Live, from your current users">
      {preview.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-24" />
        </div>
      ) : preview.error ? (
        <div className="space-y-1 text-sm">
          {preview.error instanceof ApiError && preview.error.code === 'validation_error' ? (
            <>
              <p className="text-muted-foreground">Finish these conditions to see who matches:</p>
              <ul className="list-disc pl-5 text-danger">
                {Object.entries(preview.error.fieldErrors()).map(([path, message]) => {
                  const n = /conditions\.(\d+)/.exec(path)?.[1];
                  return <li key={path}>{n !== undefined ? `Condition ${Number(n) + 1}: ${message}` : message}</li>;
                })}
              </ul>
            </>
          ) : (
            <p className="text-danger">{errorMessage(preview.error)}</p>
          )}
        </div>
      ) : p ? (
        <div className={clsx('space-y-4 transition-opacity', stale && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-ui-sm bg-muted/50 px-3 py-2.5">
              <p className="text-2xl font-semibold tabular">{num(p.total)}</p>
              <p className="text-xs text-muted-foreground">people match</p>
            </div>
            <div className="rounded-ui-sm bg-muted/50 px-3 py-2.5">
              <p className="text-2xl font-semibold tabular">{num(p.reachable)}</p>
              <p className="text-xs text-muted-foreground">can receive marketing</p>
            </div>
          </div>
          {p.total > p.reachable && (
            <p className="text-xs text-muted-foreground">
              {num(p.total - p.reachable)} are excluded from campaigns: no marketing consent, unsubscribed, suppressed address or banned account.
            </p>
          )}
          {p.sample.length > 0 && (
            <ul className="divide-y rounded-ui-sm border">
              {p.sample.map((u) => (
                <li key={u.id}>
                  <Link to={`/customers/users/${u.id}`} className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40">
                    <Avatar name={u.name} email={u.email} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{u.name || u.email}</span>
                    {!u.marketing_consent && <Badge>no consent</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function Members({ segmentId, currency }: { segmentId: string; currency: string }) {
  const [page, setPage] = useState(1);
  const members = useQuery({
    queryKey: ['segment-members', segmentId, page],
    queryFn: () => api.get<Page<Member>>(`/api/admin/segments/${segmentId}/members`, { page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card padded={false} title="Current members" description="Evaluated now with the saved rules; campaigns freeze their audience when they start sending">
      {members.error ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <DataTable
          caption="Segment members"
          rows={members.data?.data}
          loading={members.isLoading}
          fetching={members.isFetching && !members.isLoading}
          rowKey={(m) => m.id}
          rowHref={(m) => `/customers/users/${m.id}`}
          empty={<EmptyState icon={<Users />} title="Nobody matches these rules right now" />}
          columns={[
            {
              key: 'user',
              header: 'Customer',
              cell: (m) => (
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={m.name} email={m.email} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate">{m.name || m.email}</span>
                    {m.name && <span className="block truncate text-xs font-normal text-muted-foreground">{m.email}</span>}
                  </span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
            { key: 'consent', header: 'Marketing', cell: (m) => (m.marketing_consent ? <Badge tone="success">consented</Badge> : <Badge>no consent</Badge>) },
            { key: 'country', header: 'Country', priority: 'low', cell: (m) => m.country ?? '—' },
            { key: 'revenue', header: 'Revenue', align: 'right', cell: (m) => <Money amount={m.lifetime_revenue} currency={currency} /> },
            { key: 'created', header: 'Signed up', cell: (m) => <When value={m.created_at} /> },
          ]}
        />
      )}
      {members.data && <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPage={setPage} />}
    </Card>
  );
}

function SegmentForm({ segment }: { segment: Segment | null }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const currency = useBaseCurrency();
  const editable = can('marketing.segments.manage');
  const [name, setName] = useState(segment?.name ?? '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const [rules, setRules] = useState<SegmentRules>(segment?.rules ?? { match: 'all', conditions: [newCondition('marketing_consent')] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useTabParam('rules');
  const plans = useQuery({
    queryKey: ['products', 'plan'],
    queryFn: () => api.get<{ data: { key: string; name: string }[] }>('/api/admin/products', { kind: 'plan' }),
    enabled: can('catalog.products.view'),
    staleTime: 5 * 60_000,
  });

  const dirty = useMemo(
    () => !segment || name !== segment.name || description !== segment.description || JSON.stringify(rules) !== JSON.stringify(segment.rules),
    [segment, name, description, rules],
  );

  const save = useAction(
    () => {
      const body = { name, description, rules };
      return segment ? api.patch<Segment>(`/api/admin/segments/${segment.id}`, body) : api.post<Segment>('/api/admin/segments', body);
    },
    {
      success: segment ? 'Segment saved' : 'Segment created',
      invalidate: [['segments'], ['segment-members']],
      onSuccess: (s) => {
        setErrors({});
        if (!segment) navigate(`/growth/segments/${s.id}`, { replace: true });
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const remove = useAction(() => api.delete(`/api/admin/segments/${segment!.id}`), {
    success: 'Segment deleted',
    invalidate: [['segments']],
    onSuccess: () => navigate('/growth/segments'),
  });

  const setCondition = (i: number, c: SegmentRules['conditions'][number]) => setRules((r) => ({ ...r, conditions: r.conditions.map((x, j) => (j === i ? c : x)) }));
  const conditionError = (i: number) => errors[`rules.conditions.${i}.value`] ?? errors[`rules.conditions.${i}.op`] ?? errors[`rules.conditions.${i}`];

  const editor = (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <Card title="Details">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="seg-name" error={errors.name} required>
              <Input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} required maxLength={200} placeholder="Active Pro customers in the EU" />
            </Field>
            <Field label="Description" htmlFor="seg-desc" error={errors.description}>
              <Textarea id="seg-desc" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} maxLength={1000} />
            </Field>
          </div>
        </Card>
        <Card
          title="Who is in this segment"
          actions={
            <div role="radiogroup" aria-label="Match" className="inline-flex rounded-ui-sm border p-0.5 text-xs">
              {(['all', 'any'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={rules.match === m}
                  disabled={!editable}
                  onClick={() => setRules((r) => ({ ...r, match: m }))}
                  className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-1 font-medium', rules.match === m ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {m === 'all' ? 'Match all conditions' : 'Match any condition'}
                </button>
              ))}
            </div>
          }
        >
          {rules.conditions.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">No conditions: every active user is in this segment.</p>
          ) : (
            <ul className="mb-3 space-y-2">
              {rules.conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  condition={c}
                  onChange={(next) => setCondition(i, next)}
                  onRemove={() => setRules((r) => ({ ...r, conditions: r.conditions.filter((_, j) => j !== i) }))}
                  disabled={!editable}
                  error={conditionError(i)}
                  currency={currency}
                  plans={plans.data?.data ?? null}
                />
              ))}
            </ul>
          )}
          {editable && rules.conditions.length < 50 && (
            <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={() => setRules((r) => ({ ...r, conditions: [...r.conditions, newCondition('plan')] }))}>
              Add condition
            </Button>
          )}
        </Card>
        <Callout>Campaigns only reach people in a segment who consented to marketing email and have not unsubscribed. Deleted accounts are never included.</Callout>
      </div>
      <div className="space-y-4">
        <AudiencePreview rules={rules} enabled />
      </div>
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <PageHeader
        breadcrumbs={[{ label: 'Segments', to: '/growth/segments' }, { label: segment?.name ?? 'New segment' }]}
        title={segment ? segment.name : 'New segment'}
        description="Group customers by plan, activity, location, revenue and consent. Segments are evaluated when you use them, so membership stays current."
        actions={
          <>
            {segment && can('marketing.campaigns.manage') && (
              <ButtonLink to={`/growth/campaigns?new=1&segment=${segment.id}`} variant="outline" icon={<Megaphone className="size-4" />}>
                New campaign
              </ButtonLink>
            )}
            {segment && editable && (
              <Button
                variant="outline"
                icon={<Trash2 className="size-4" />}
                onClick={async () => {
                  if ((await confirm({ title: `Delete “${segment.name}”?`, description: 'Segments used by a campaign cannot be deleted.', tone: 'danger', confirmLabel: 'Delete segment' })).confirmed) remove.mutate();
                }}
              >
                Delete
              </Button>
            )}
            {editable && (
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                {segment ? 'Save changes' : 'Create segment'}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4">
        <FormError message={error} />
      </div>
      {segment ? (
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'rules', label: 'Rules', content: editor },
            { value: 'members', label: 'Members', content: <Members segmentId={segment.id} currency={currency} /> },
          ]}
        />
      ) : (
        editor
      )}
    </form>
  );
}

export default function SegmentEditorPage() {
  const { id } = useParams();
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<{ data: Segment[] }>('/api/admin/segments'), enabled: Boolean(id) });
  if (!id) return <SegmentForm segment={null} />;
  if (segments.isLoading) return <PageSkeleton />;
  if (segments.error) return <ErrorState error={segments.error} onRetry={() => void segments.refetch()} />;
  const segment = segments.data?.data.find((s) => s.id === id);
  if (!segment) return <EmptyState title="Segment not found" description="It may have been deleted." action={<ButtonLink to="/growth/segments">All segments</ButtonLink>} />;
  return <SegmentForm key={`${segment.id}:${segment.updated_at}`} segment={segment} />;
}
