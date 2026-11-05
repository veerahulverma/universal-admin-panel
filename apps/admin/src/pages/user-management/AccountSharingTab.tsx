import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import { Badge, Button, ButtonLink, Callout, Card, DataTable, EmptyState, ErrorState, Field, FormError, KeyValue, Modal, Pagination, Select, Textarea, Toolbar, When, type Column } from '../../components/ui';
import { SHARING_ACTIONS, SOURCE_LABELS, type SharingFlag, type SharingPolicy } from './types';

type FlagPage = Page<SharingFlag> & { policy: SharingPolicy; caveat: string };

function FlagDialog({ flag, caveat, onClose }: { flag: SharingFlag; caveat: string; onClose: () => void }) {
  const { can } = useAuth();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const clear = useAction(() => api.post(`/api/admin/security/account-sharing/${flag.id}/clear`, { note: note.trim() || undefined }), {
    success: 'Flag cleared',
    invalidate: [['sharing-flags'], ['security-events'], ['security-overview'], ['user-ip-addresses', flag.userId]],
    onSuccess: onClose,
    onError: (err) => setError(errorMessage(err)),
  });
  const open = flag.status === 'open';
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Possible account sharing: ${flag.email ?? flag.userId}`}
      description={`${flag.distinctCount} distinct ${flag.countBy === 'network' ? 'networks' : 'addresses'} within ${flag.windowHours} h, against a limit of ${flag.maxAllowed}.`}
      footer={
        open && can('security.sharing.manage') ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={clear.isPending} onClick={() => clear.mutate()}>
              Clear flag
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <Callout tone="info">{caveat}</Callout>
        <KeyValue
          items={[
            { label: 'Customer', value: <Link className="text-primary hover:underline" to={`/customers/users/${flag.userId}`}>{flag.name || flag.email || flag.userId}</Link> },
            { label: 'Action taken', value: SHARING_ACTIONS[flag.action] },
            { label: 'Sign-ins paused until', value: flag.blockedUntil ? dateTime(flag.blockedUntil) : null, hidden: !flag.blockedUntil },
            { label: 'Flagged', value: dateTime(flag.createdAt) },
            { label: 'Cleared', value: flag.clearedAt ? `${dateTime(flag.clearedAt)}${flag.clearNote ? ` · ${flag.clearNote}` : ''}` : null, hidden: !flag.clearedAt },
          ]}
        />
        <div className="max-h-64 overflow-y-auto rounded-ui border">
          <DataTable
            caption="Addresses counted"
            rows={flag.addresses}
            rowKey={(a) => a.ip}
            columns={[
              { key: 'ip', header: 'Address', cell: (a) => <code className="font-mono text-xs">{a.ip}</code> },
              { key: 'network', header: 'Network', priority: 'low', cell: (a) => <code className="font-mono text-xs">{a.network}</code> },
              { key: 'last', header: 'Last seen', cell: (a) => <When value={a.lastSeenAt} /> },
              { key: 'hits', header: 'Times', align: 'right', cell: (a) => <span className="tabular">{a.hits}</span> },
              { key: 'via', header: 'Seen via', cell: (a) => a.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ') },
            ]}
          />
        </div>
        {open && can('security.sharing.manage') && (
          <Field label="Review note" htmlFor="flag-note" hint="Recorded in the audit log. Clearing lifts any sign-in pause and resolves the security alert; counting starts again from now.">
            <Textarea id="flag-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed by phone: travelling between offices" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Customer accounts flagged for possible sharing, with the evidence and a way to clear each flag. */
export function AccountSharingTab() {
  const { can } = useAuth();
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<SharingFlag | null>(null);
  const query = { status, page, pageSize: 25 };
  const flags = useQuery({ queryKey: ['sharing-flags', query], queryFn: ({ signal }) => api.get<FlagPage>('/api/admin/security/account-sharing', query, signal), placeholderData: keepPreviousData });
  const policy = flags.data?.policy;

  const columns: Column<SharingFlag>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cell: (f) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setOpen(f)}>
          <span className="block truncate font-medium hover:underline">{f.name || f.email || f.userId}</span>
          {f.name && <span className="block truncate text-xs text-muted-foreground">{f.email}</span>}
        </button>
      ),
    },
    {
      key: 'addresses',
      header: 'Addresses',
      cell: (f) => (
        <span className="tabular">
          {f.distinctCount} / {f.maxAllowed} in {f.windowHours} h
        </span>
      ),
    },
    { key: 'action', header: 'Action', cell: (f) => (f.blockedUntil && new Date(f.blockedUntil) > new Date() ? <Badge tone="danger">paused until {dateTime(f.blockedUntil)}</Badge> : SHARING_ACTIONS[f.action]) },
    { key: 'status', header: 'Status', cell: (f) => <Badge tone={f.status === 'open' ? 'warning' : 'success'}>{f.status}</Badge> },
    { key: 'flagged', header: 'Flagged', cell: (f) => <When value={f.createdAt} /> },
  ];

  return (
    <div className="space-y-4">
      <Callout
        tone="info"
        title={policy ? (policy.enabled ? `Flags accounts using more than ${policy.maxAddresses} ${policy.countBy === 'network' ? 'networks' : 'addresses'} in ${policy.windowHours} h · ${SHARING_ACTIONS[policy.action].toLowerCase()}` : 'Sharing detection is off') : undefined}
        action={can('security.sharing.manage') && can('system.settings.view') ? <ButtonLink to="/platform/settings/accountSharing" size="sm">Edit policy</ButtonLink> : undefined}
      >
        {flags.data?.caveat}
      </Callout>
      <Card padded={false}>
        <Toolbar>
          <Select
            aria-label="Status"
            className="w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'cleared', label: 'Cleared' },
              { value: 'all', label: 'Any status' },
            ]}
          />
        </Toolbar>
        {flags.error ? (
          <ErrorState error={flags.error} onRetry={() => void flags.refetch()} />
        ) : (
          <DataTable
            caption="Account-sharing flags"
            columns={columns}
            rows={flags.data?.data}
            rowKey={(f) => f.id}
            loading={flags.isLoading}
            fetching={flags.isFetching && !flags.isLoading}
            empty={<EmptyState icon={<ShieldCheck />} title={status === 'open' ? 'No accounts flagged' : 'No flags match'} description="Accounts are flagged when they use more distinct IP addresses than the sharing policy allows." />}
          />
        )}
        {flags.data && <Pagination page={flags.data.page} pageSize={flags.data.pageSize} total={flags.data.total} onPage={setPage} />}
      </Card>
      {open && flags.data && <FlagDialog flag={open} caveat={flags.data.caveat} onClose={() => setOpen(null)} />}
    </div>
  );
}
