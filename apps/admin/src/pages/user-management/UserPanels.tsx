import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Badge, Callout, Card, DataTable, EmptyState, ErrorState, Skeleton, When } from '../../components/ui';
import { describeAgent } from '../admin/shared';
import { SHARING_ACTIONS, SOURCE_LABELS, type UserAgreements, type UserIpAddresses } from './types';

/** What the customer accepted (version, when, from where), and required agreements still pending. */
export function AgreementsCard({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ['user-agreements', userId], queryFn: () => api.get<UserAgreements>(`/api/admin/users/${userId}/agreements`) });
  return (
    <Card title="Agreements" padded={false}>
      {q.isLoading ? (
        <div className="p-4">
          <Skeleton className="h-12" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data!.accepted.length && !q.data!.pending.length ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">No agreements accepted.</p>
      ) : (
        <ul className="divide-y">
          {q.data!.pending.map((p) => (
            <li key={p.versionId} className="flex items-start justify-between gap-2 px-4 py-2.5">
              <Link to={`/customers/agreements/${p.agreementId}`} className="min-w-0 text-sm font-medium hover:underline">
                {p.title} <span className="font-normal text-muted-foreground">v{p.version}</span>
              </Link>
              <Badge tone="warning">pending</Badge>
            </li>
          ))}
          {q.data!.accepted.map((a) => (
            <li key={a.id} className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/customers/agreements/${a.agreementId}`} className="min-w-0 text-sm font-medium hover:underline">
                  {a.agreementTitle} <span className="font-normal text-muted-foreground">v{a.version}</span>
                </Link>
                {a.current ? <Badge tone="success">current</Badge> : <Badge>superseded</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {dateTime(a.acceptedAt)} · {SOURCE_LABELS[a.source] ?? a.source}
                {a.ip && (
                  <>
                    {' · '}
                    <code className="font-mono">{a.ip}</code>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Social sign-in identities (Google, GitHub...) linked to the customer. */
export function SocialIdentitiesCard({ userId }: { userId: string }) {
  const q = useQuery({
    queryKey: ['user-identities', userId],
    queryFn: () => api.get<{ data: { id: string; provider: string; providerName: string; email: string | null; emailVerified: boolean; linkedAt: string; lastLoginAt: string | null }[] }>(`/api/admin/users/${userId}/identities`),
  });
  if (q.isLoading || !q.data?.data.length) return null;
  return (
    <Card title="Social sign-in" padded={false}>
      <ul className="divide-y">
        {q.data.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="block font-medium">{i.providerName}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {i.email ?? 'No email shared'}
                {i.email && !i.emailVerified && ' (unverified)'}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              Linked {dateTime(i.linkedAt)}
              {i.lastLoginAt && (
                <>
                  {' · last used '}
                  <When value={i.lastLoginAt} />
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Addresses the customer used, the sharing window count and any flags. */
export function IpAddressesCard({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ['user-ip-addresses', userId], queryFn: () => api.get<UserIpAddresses>(`/api/admin/users/${userId}/ip-addresses`) });
  const d = q.data;
  const open = d?.flags.find((f) => f.status === 'open');
  return (
    <Card
      title="IP addresses"
      description={d ? `${d.window.distinct} distinct ${d.window.countBy === 'network' ? 'networks' : 'addresses'} in the last ${d.window.hours} h${d.window.enabled ? ` (limit ${d.window.limit})` : ' (sharing detection is off)'}` : undefined}
      padded={false}
    >
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {(d?.blockedUntil || open) && (
            <div className="border-b p-3">
              <Callout tone={d?.blockedUntil ? 'danger' : 'warning'} title={d?.blockedUntil ? `Sign-ins paused until ${dateTime(d.blockedUntil)}` : 'Flagged for possible account sharing'}>
                {open && (
                  <>
                    {open.distinctCount} addresses against a limit of {open.maxAllowed} · {SHARING_ACTIONS[open.action]} ·{' '}
                    <Link className="text-primary hover:underline" to="/admin/security?tab=sharing">
                      Review in Security
                    </Link>
                  </>
                )}
              </Callout>
            </div>
          )}
          <DataTable
            caption="IP addresses"
            rows={d?.addresses}
            loading={q.isLoading}
            rowKey={(a) => a.ip}
            empty={<EmptyState title="No addresses recorded" description="Addresses are recorded at sign-in, session checks and client API requests." />}
            columns={[
              {
                key: 'ip',
                header: 'Address',
                cell: (a) => (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-xs">{a.ip}</code>
                    {a.country && <span className="text-xs text-muted-foreground">{a.country}</span>}
                    {a.trusted && <Badge tone="success">trusted</Badge>}
                  </span>
                ),
              },
              { key: 'seen', header: 'Last seen', cell: (a) => <When value={a.lastSeenAt} /> },
              { key: 'first', header: 'First seen', priority: 'low', cell: (a) => <When value={a.firstSeenAt} /> },
              { key: 'hits', header: 'Times', align: 'right', cell: (a) => <span className="tabular">{a.hits}</span> },
              { key: 'via', header: 'Seen via', cell: (a) => a.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ') },
              { key: 'device', header: 'Device', priority: 'low', cell: (a) => <span className="block max-w-48 truncate">{describeAgent(a.userAgent)}</span> },
            ]}
          />
          {d && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{d.caveat}</p>}
        </>
      )}
    </Card>
  );
}
