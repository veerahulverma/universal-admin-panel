import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Globe } from 'lucide-react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { Button, Modal } from '../../components/ui';
import { OrgPicker, type OrgRef } from './OrgPicker';
import { refreshShell } from './shared';
import type { ThemeListRow } from './themes';

export function ThemeActivateDialog({ theme, onClose }: { theme: Pick<ThemeListRow, 'id' | 'name' | 'is_active' | 'scope'>; onClose: () => void }) {
  const client = useQueryClient();
  const [target, setTarget] = useState<'global' | 'org'>('global');
  const [org, setOrg] = useState<OrgRef | null>(null);
  const scope = target === 'global' ? 'global' : org ? `org:${org.id}` : null;
  const activate = useAction(() => api.post(`/api/admin/themes/${theme.id}/activate`, { scope }), {
    success: target === 'global' ? `${theme.name} is now the active theme` : `${theme.name} is now active for ${org?.name}`,
    invalidate: [['themes'], ['theme', theme.id]],
    onSuccess: () => {
      refreshShell(client);
      onClose();
    },
  });
  const moving = theme.is_active && scope && theme.scope !== scope;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Activate ${theme.name}`}
      description="Choose where this theme applies. Organizations without their own theme use the global one."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!scope} loading={activate.isPending} onClick={() => activate.mutate()}>
            Activate
          </Button>
        </>
      }
    >
      <div className="space-y-3" role="radiogroup" aria-label="Where the theme applies">
        <label className="flex cursor-pointer items-start gap-3 rounded-ui border p-3 has-[:checked]:border-primary">
          <input type="radio" name="scope" className="mt-1 accent-[var(--color-primary)]" checked={target === 'global'} onChange={() => setTarget('global')} />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Globe className="size-4" aria-hidden="true" /> Global
            </span>
            <span className="block text-xs text-muted-foreground">This console, hosted pages, emails and every organization without its own theme.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-ui border p-3 has-[:checked]:border-primary">
          <input type="radio" name="scope" className="mt-1 accent-[var(--color-primary)]" checked={target === 'org'} onChange={() => setTarget('org')} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Building2 className="size-4" aria-hidden="true" /> One organization
            </span>
            <span className="block text-xs text-muted-foreground">White-label branding for a single tenant (also used for its custom domain).</span>
            {target === 'org' && (
              <span className="mt-2 block">
                <OrgPicker value={org} onChange={setOrg} />
              </span>
            )}
          </span>
        </label>
        {moving && <p className="text-xs text-warning">This theme is currently active elsewhere; a theme is active in one place at a time, so that scope falls back to its default.</p>}
      </div>
    </Modal>
  );
}
