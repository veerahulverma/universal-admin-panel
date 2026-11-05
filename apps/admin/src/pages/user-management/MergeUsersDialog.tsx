import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Merge } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { dateTime, num } from '../../lib/format';
import { Avatar, Badge, Button, Callout, ErrorState, Field, FormError, Input, Modal, Skeleton } from '../../components/ui';
import { UserPicker, type PickedUser } from '../customers/shared';
import { humanizeTable, type MergeEntry, type MergePreview } from './types';

const RESOLUTION: Record<MergeEntry['resolution'], string> = {
  move: '',
  combine: 'added together with the kept account’s',
  keep_target: 'the kept account’s setting wins',
  custom: 'combined into one',
  keep_source: 'stay with the closed account',
};

function AccountCard({ label, user, tone }: { label: string; user: { email: string; name: string | null; createdAt?: string }; tone: 'success' | 'danger' }) {
  return (
    <div className="min-w-0 flex-1 rounded-ui border p-3">
      <Badge tone={tone}>{label}</Badge>
      <div className="mt-2 flex min-w-0 items-center gap-2.5">
        <Avatar name={user.name} email={user.email} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{user.name || user.email}</span>
          {user.name && <span className="block truncate text-xs text-muted-foreground">{user.email}</span>}
        </span>
      </div>
      {user.createdAt && <p className="mt-1 text-xs text-muted-foreground">Signed up {dateTime(user.createdAt)}</p>}
    </div>
  );
}

/**
 * Merge a duplicate into the account on screen (or, swapped, this account into the other).
 * The preview lists every record that moves before anything changes.
 */
export function MergeUsersDialog({ user, open, onOpenChange }: { user: PickedUser & { createdAt?: string }; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [other, setOther] = useState<PickedUser | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const target = swapped ? other : user;
  const source = swapped ? user : other;

  const preview = useQuery({
    queryKey: ['merge-preview', target?.id, source?.id],
    queryFn: () => api.get<MergePreview>(`/api/admin/users/${target!.id}/merge-preview`, { sourceId: source!.id }),
    enabled: open && Boolean(target && source),
  });

  const merge = useAction(() => api.post<{ moved: { rows: number }[] }>(`/api/admin/users/${target!.id}/merge`, { sourceId: source!.id, confirm: 'MERGE' }), {
    success: 'Accounts merged',
    invalidate: [['users'], ['user', user.id], ['user', other?.id ?? '']],
    onSuccess: () => {
      close(false);
      navigate(`/customers/users/${target!.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setOther(null);
      setSwapped(false);
      setTyped('');
      setError(null);
    }
  };

  const entries = preview.data?.entries ?? [];
  const moving = entries.reduce((n, e) => n + e.rows, 0);
  const staying = entries.filter((e) => e.resolution === 'keep_source');

  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="lg"
      title="Merge duplicate accounts"
      description="Everything that belongs to the duplicate moves to the account you keep, in one step. The kept account’s profile stays; its empty fields are filled from the duplicate, which is then closed. This cannot be undone."
      footer={
        <>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="danger" icon={<Merge className="size-4" />} disabled={!preview.data || typed !== 'MERGE'} loading={merge.isPending} onClick={() => merge.mutate()}>
            Merge accounts
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        {!other ? (
          <Field label="Duplicate account" htmlFor="merge-other" hint="Search for the other account of the same person.">
            <UserPicker id="merge-other" value={other} onChange={setOther} excludeIds={[user.id]} />
          </Field>
        ) : (
          <>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <AccountCard label="Keep" user={{ ...target!, createdAt: preview.data?.target.createdAt }} tone="success" />
              <Button variant="ghost" size="icon" className="self-center" aria-label="Swap which account is kept" onClick={() => setSwapped((s) => !s)}>
                <ArrowLeftRight className="size-4" />
              </Button>
              <AccountCard label="Merge and close" user={{ ...source!, createdAt: preview.data?.source.createdAt }} tone="danger" />
            </div>
            <Button variant="link" size="sm" onClick={() => setOther(null)}>
              Choose a different account
            </Button>
            {preview.isLoading ? (
              <Skeleton className="h-40" />
            ) : preview.error ? (
              <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
            ) : (
              <>
                <div>
                  <p className="text-sm font-medium">{moving ? `${num(moving)} records move to the kept account` : 'The duplicate has no records to move'}</p>
                  {entries.length > 0 && (
                    <ul className="mt-2 max-h-64 divide-y overflow-y-auto rounded-ui border">
                      {entries.map((e) => (
                        <li key={`${e.table}.${e.column}`} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                          <span className="min-w-0">
                            <span className="block truncate">{humanizeTable(e.table)}</span>
                            <span className="block text-xs text-muted-foreground">
                              {e.module ?? 'other'} · {e.column}
                              {e.conflicts > 0 && ` · ${num(e.conflicts)} ${RESOLUTION[e.resolution]}`}
                            </span>
                          </span>
                          <span className="shrink-0 tabular">{num(e.rows)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {preview.data!.filled.length > 0 && (
                  <p className="text-sm">
                    <span className="font-medium">Filled from the duplicate:</span> {preview.data!.filled.map((f) => f.replace(/_/g, ' ')).join(', ')}
                  </p>
                )}
                {staying.length > 0 && (
                  <Callout tone="warning" title="Some records cannot move">
                    {staying.map((e) => `${humanizeTable(e.table)} (${e.conflicts})`).join(', ')} already exist on the kept account and stay with the closed one.
                  </Callout>
                )}
                <Field label={<>Type <code className="rounded bg-muted px-1 font-mono text-xs">MERGE</code> to confirm</>} htmlFor="merge-confirm">
                  <Input id="merge-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                </Field>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
