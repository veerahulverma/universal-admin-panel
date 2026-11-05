import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ButtonLink, Card, DataTable, EmptyState, ErrorState, PageHeader, SearchInput, Toolbar, When } from '../../components/ui';
import { describeRules, type Segment } from './segment-rules';
import { useBaseCurrency } from './shared';

export default function SegmentsPage() {
  const { can } = useAuth();
  const currency = useBaseCurrency();
  const [q, setQ] = useState('');
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<{ data: Segment[] }>('/api/admin/segments') });
  const term = q.trim().toLowerCase();
  const rows = (segments.data?.data ?? []).filter((s) => !term || s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term));

  return (
    <>
      <PageHeader
        title="Segments"
        description="Reusable groups of customers for campaigns and analysis. Membership is evaluated live from each segment’s rules."
        actions={
          can('marketing.segments.manage') && (
            <ButtonLink to="/growth/segments/new" variant="primary" icon={<Plus className="size-4" />}>
              New segment
            </ButtonLink>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search segments…" className="w-full sm:w-72" />
        </Toolbar>
        {segments.error ? (
          <ErrorState error={segments.error} onRetry={() => void segments.refetch()} />
        ) : (
          <DataTable
            caption="Segments"
            rows={segments.data ? rows : undefined}
            loading={segments.isLoading}
            rowKey={(s) => s.id}
            rowHref={(s) => `/growth/segments/${s.id}`}
            empty={
              term ? (
                <EmptyState title="No segments match" />
              ) : (
                <EmptyState
                  icon={<Filter />}
                  title="No segments yet"
                  description="For example: customers on a paid plan who have not been active for 30 days."
                  action={
                    can('marketing.segments.manage') && (
                      <ButtonLink to="/growth/segments/new" variant="outline">
                        Create a segment
                      </ButtonLink>
                    )
                  }
                />
              )
            }
            columns={[
              {
                key: 'name',
                header: 'Segment',
                cell: (s) => (
                  <span className="min-w-0">
                    <span className="block truncate">{s.name}</span>
                    {s.description && <span className="block truncate text-xs font-normal text-muted-foreground">{s.description}</span>}
                  </span>
                ),
              },
              { key: 'rules', header: 'Rules', cell: (s) => <span className="line-clamp-2 max-w-xl text-sm text-muted-foreground">{describeRules(s.rules, currency)}</span> },
              { key: 'updated', header: 'Updated', cell: (s) => <When value={s.updated_at} /> },
            ]}
          />
        )}
      </Card>
    </>
  );
}
