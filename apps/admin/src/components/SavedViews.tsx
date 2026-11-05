import { useQuery } from '@tanstack/react-query';
import { Bookmark, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/mutations';
import { Button, Menu, useConfirm, type MenuItem } from './ui';

interface SavedView {
  id: string;
  name: string;
  state: Record<string, string | number>;
  shared: boolean;
}

/**
 * Saved filters for a list page. `state` is the page's URL state (filters and
 * sort), so applying a view is just navigating to it.
 */
export function SavedViews({ resource, state, onApply }: { resource: string; state: Record<string, unknown>; onApply: (state: Record<string, string | number>) => void }) {
  const confirm = useConfirm();
  const views = useQuery({ queryKey: ['saved-views', resource], queryFn: () => api.get<{ data: SavedView[] }>('/api/admin/saved-views', { resource }) });
  const save = useAction((name: string) => api.post('/api/admin/saved-views', { resource, name, state: clean(state) }), { success: 'View saved', invalidate: [['saved-views', resource]] });
  const remove = useAction((id: string) => api.delete(`/api/admin/saved-views/${id}`), { success: 'View deleted', invalidate: [['saved-views', resource]] });

  const items: MenuItem[] = [
    ...(views.data?.data ?? []).map((v) => ({
      label: (
        <span className="flex w-full items-center justify-between gap-3">
          <span className="truncate">{v.name}</span>
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Delete view ${v.name}`}
            className="rounded p-0.5 text-muted-foreground hover:text-danger"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              remove.mutate(v.id);
            }}
          >
            <Trash2 className="size-3.5" />
          </span>
        </span>
      ),
      onSelect: () => onApply(v.state),
    })),
    { separator: true, label: '', hidden: !views.data?.data.length },
    {
      label: 'Save current view…',
      onSelect: async () => {
        const { confirmed, reason } = await confirm({ title: 'Save view', description: 'Saves the current filters and sorting for quick access.', confirmLabel: 'Save', reason: { label: 'Name', required: true, placeholder: 'e.g. Churn risk, EU customers' } });
        if (confirmed && reason) save.mutate(reason);
      },
    },
  ];

  return <Menu align="start" trigger={<Button variant="outline" icon={<Bookmark className="size-4" />}>Views</Button>} items={items} />;
}

function clean(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([k, v]) => k !== 'page' && v !== undefined && v !== ''));
}
