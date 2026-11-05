import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Popover as RPopover } from 'radix-ui';
import { Building2, ChevronDown } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Button, SearchInput, Spinner } from '../../components/ui';

export interface OrgRef {
  id: string;
  name: string;
}

/** The display name of an organization referenced by id (falls back to the id). */
export function useOrgName(id: string | null | undefined): string | null {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['organization-name', id],
    queryFn: () => api.get<{ name: string }>(`/api/admin/organizations/${id}`),
    enabled: Boolean(id) && can('customers.organizations.view'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return id ? q.data?.name ?? id : null;
}

/** Searchable organization chooser (used for tenant-specific settings and branding). */
export function OrgPicker({ value, onChange, label = 'Choose organization', disabled }: { value: OrgRef | null; onChange: (org: OrgRef) => void; label?: string; disabled?: boolean }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const orgs = useQuery({
    queryKey: ['org-picker', dq],
    queryFn: ({ signal }) => api.get<Page<{ id: string; name: string; slug: string }>>('/api/admin/organizations', { q: dq || undefined, pageSize: 8, sort: 'name', order: 'asc' }, signal),
    enabled: open && can('customers.organizations.view'),
  });
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>
        <Button variant="outline" disabled={disabled} icon={<Building2 className="size-4" />}>
          <span className="max-w-48 truncate">{value ? value.name : label}</span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content align="start" sideOffset={6} className="z-50 w-[min(20rem,calc(100vw-2rem))] rounded-ui border bg-surface p-2 shadow-lg animate-pop-in">
          {!can('customers.organizations.view') ? (
            <p className="p-2 text-sm text-muted-foreground">You need permission to view organizations.</p>
          ) : (
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search organizations…" autoFocus />
              <ul className="mt-2 max-h-64 overflow-y-auto" role="listbox" aria-label="Organizations">
                {orgs.isLoading && (
                  <li className="flex justify-center p-3">
                    <Spinner />
                  </li>
                )}
                {orgs.data?.data.length === 0 && <li className="p-3 text-center text-sm text-muted-foreground">No organizations found</li>}
                {orgs.data?.data.map((o) => (
                  <li key={o.id} role="option" aria-selected={value?.id === o.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-ui-sm px-2.5 py-1.5 text-left hover:bg-muted aria-selected:bg-muted"
                      onClick={() => {
                        onChange({ id: o.id, name: o.name });
                        setOpen(false);
                      }}
                    >
                      <span className="truncate text-sm font-medium">{o.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">{o.slug}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
