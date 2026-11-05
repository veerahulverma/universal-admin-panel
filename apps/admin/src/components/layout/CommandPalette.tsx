import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { ArrowRight, Building2, CornerDownLeft, FileText, Package, Search, User } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { NavIcon } from '../../lib/icons';
import { sectionLabel, type NavItem } from './nav';

interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle?: string | null;
  url: string;
}

const TYPE_ICON: Record<string, typeof User> = { user: User, organization: Building2, invoice: FileText, product: Package };

export function CommandPalette({ open, onOpenChange, nav }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavItem[] }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const debounced = useDebounced(q.trim(), 200);

  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
    }
  }, [open]);

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: ({ signal }) => api.get<{ data: SearchResult[] }>('/api/admin/search', { q: debounced }, signal),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });

  const items = useMemo(() => {
    const lower = q.trim().toLowerCase();
    const pages = nav
      .filter((n) => !lower || `${n.label} ${sectionLabel(n.section) ?? ''}`.toLowerCase().includes(lower))
      .slice(0, lower ? 6 : 8)
      .map((n) => ({ key: `nav:${n.id}`, title: n.label, subtitle: sectionLabel(n.section) ?? 'Go to page', url: n.path, icon: <NavIcon name={n.icon} className="size-4" /> }));
    const records = (search.data?.data ?? []).map((r) => {
      const Icon = TYPE_ICON[r.type] ?? ArrowRight;
      return { key: `${r.type}:${r.id}`, title: r.title, subtitle: r.subtitle ?? r.type, url: r.url, icon: <Icon className="size-4" /> };
    });
    return [...records, ...pages];
  }, [q, nav, search.data]);

  useEffect(() => setIndex(0), [items.length]);

  const go = (url: string) => {
    onOpenChange(false);
    navigate(url);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-ui border bg-surface shadow-2xl animate-pop-in">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Dialog.Description className="sr-only">Search customers, invoices, products and pages</Dialog.Description>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIndex((i) => Math.min(items.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIndex((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter' && items[index]) {
                  e.preventDefault();
                  go(items[index].url);
                }
              }}
              placeholder="Search users, organizations, invoices, pages…"
              aria-label="Search"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-results"
              aria-activedescendant={items[index] ? `cmd-${index}` : undefined}
              className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border px-1.5 text-2xs text-muted-foreground">Esc</kbd>
          </div>
          <ul id="command-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{search.isFetching ? 'Searching…' : 'No results'}</li>}
            {items.map((item, i) => (
              <li
                key={item.key}
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(item.url)}
                className={clsx('flex cursor-pointer items-center gap-3 rounded-ui-sm px-3 py-2', i === index && 'bg-muted')}
              >
                <span className="text-muted-foreground">{item.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
                </span>
                {i === index && <CornerDownLeft className="size-3.5 text-muted-foreground" aria-hidden="true" />}
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
