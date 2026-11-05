import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, FileUp, Globe, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormError, Input, Menu, Modal, PageHeader, PageSkeleton, Select, Textarea, useConfirm, useToast, type MenuItem } from '../../components/ui';
import { useOrgName } from './OrgPicker';
import { ThemeActivateDialog } from './ThemeActivateDialog';
import { Swatches, type ThemeDetail, type ThemeListRow } from './themes';

function NewThemeDialog({ themes, basedOn, onClose }: { themes: ThemeListRow[]; basedOn: ThemeListRow | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(basedOn ? `${basedOn.name} (custom)` : '');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState(basedOn?.id ?? themes.find((t) => t.is_active && t.scope === 'global')?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const create = useAction(() => api.post<ThemeDetail>('/api/admin/themes', { name, description, basedOn: source || undefined }), {
    success: 'Theme created as a draft',
    invalidate: [['themes']],
    onSuccess: (t) => {
      onClose();
      navigate(`/platform/themes/${t.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const published = themes.filter((t) => t.published_revision_id);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={basedOn ? `Customize ${basedOn.name}` : 'New theme'}
      description="A copy you can edit, preview and publish without affecting the active theme."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-theme" loading={create.isPending} disabled={!name.trim()}>
            Create theme
          </Button>
        </>
      }
    >
      <form
        id="new-theme"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="nt-name" required>
          <Input id="nt-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
        </Field>
        <Field label="Description" htmlFor="nt-desc">
          <Textarea id="nt-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Start from" htmlFor="nt-source">
          <Select id="nt-source" value={source} onChange={(e) => setSource(e.target.value)} options={published.map((t) => ({ value: t.id, label: `${t.name}${t.source === 'preset' ? ' (preset)' : ''}` }))} />
        </Field>
      </form>
    </Modal>
  );
}

function ActiveScope({ theme }: { theme: ThemeListRow }) {
  const orgName = useOrgName(theme.scope === 'global' ? null : theme.scope.slice(4));
  if (!theme.is_active) return null;
  return theme.scope === 'global' ? (
    <Badge tone="success" dot>
      active · global
    </Badge>
  ) : (
    <Badge tone="success" dot>
      active · {orgName}
    </Badge>
  );
}

function ThemeCard({ theme, onCustomize, onActivate }: { theme: ThemeListRow; onCustomize: () => void; onActivate: () => void }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const manage = can('themes.themes.manage');
  const remove = useAction(() => api.delete(`/api/admin/themes/${theme.id}`), { success: 'Theme deleted', invalidate: [['themes']] });
  const duplicate = useAction(() => api.post<ThemeDetail>('/api/admin/themes', { name: `${theme.name} copy`, basedOn: theme.id }), {
    success: 'Theme duplicated',
    invalidate: [['themes']],
    onSuccess: (t) => navigate(`/platform/themes/${t.id}`),
  });
  const editable = theme.source !== 'preset';
  const items: MenuItem[] = [
    { label: 'Activate…', icon: <Globe className="size-4" />, hidden: !manage || !theme.published_revision_id, onSelect: onActivate },
    { label: 'Duplicate', icon: <Copy className="size-4" />, hidden: !manage || !theme.published_revision_id, onSelect: () => duplicate.mutate() },
    {
      label: 'Export JSON',
      icon: <Download className="size-4" />,
      hidden: !theme.published_revision_id,
      onSelect: () => download(`/api/admin/themes/${theme.id}/export`, undefined, `${theme.key}.theme.json`).catch((err) => toast.error('Export failed', errorMessage(err))),
    },
    { separator: true, label: '', hidden: !manage || !editable },
    {
      label: 'Delete',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !manage || !editable,
      disabled: theme.is_active,
      onSelect: async () => {
        const { confirmed } = await confirm({ title: `Delete ${theme.name}?`, description: 'The theme and its revision history are removed.', confirmLabel: 'Delete theme', tone: 'danger', typeToConfirm: theme.name });
        if (confirmed) remove.mutate();
      },
    },
  ];
  return (
    <Card>
      <Swatches tokens={theme.published_tokens} />
      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {editable ? (
              <Link to={`/platform/themes/${theme.id}`} className="text-sm font-semibold hover:underline">
                {theme.name}
              </Link>
            ) : (
              <span className="text-sm font-semibold">{theme.name}</span>
            )}
            <ActiveScope theme={theme} />
          </p>
          {theme.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{theme.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{theme.source === 'upload' ? 'imported' : theme.source}</Badge>
            {theme.published_version ? <Badge>v{theme.published_version} published</Badge> : <Badge tone="warning">not published</Badge>}
            {theme.draft_version && <Badge tone="info">draft v{theme.draft_version}</Badge>}
          </div>
        </div>
        <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${theme.name}`}><MoreHorizontal className="size-4" /></Button>} items={items} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
        {editable ? (
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => navigate(`/platform/themes/${theme.id}`)}>
            Edit
          </Button>
        ) : (
          manage && (
            <Button size="sm" variant="outline" icon={<Palette className="size-3.5" />} onClick={onCustomize}>
              Customize
            </Button>
          )
        )}
        {manage && theme.published_revision_id && !(theme.is_active && theme.scope === 'global') && (
          <Button size="sm" variant="ghost" onClick={onActivate}>
            Activate
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function ThemesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const manage = can('themes.themes.manage');
  const file = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState<{ basedOn: ThemeListRow | null } | null>(null);
  const [activating, setActivating] = useState<ThemeListRow | null>(null);
  const themes = useQuery({ queryKey: ['themes'], queryFn: () => api.get<{ data: ThemeListRow[] }>('/api/admin/themes') });
  const importTheme = useAction((pkg: Record<string, unknown>) => api.post<ThemeDetail>('/api/admin/themes/import', pkg), {
    success: (t) => `${t.name} imported`,
    invalidate: [['themes']],
    onSuccess: (t) => navigate(`/platform/themes/${t.id}`),
  });

  if (themes.isLoading) return <PageSkeleton />;
  if (themes.error || !themes.data) return <ErrorState error={themes.error} onRetry={() => void themes.refetch()} />;
  const list = themes.data.data;
  const custom = list.filter((t) => t.source !== 'preset');
  const presets = list.filter((t) => t.source === 'preset');

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const pkg = JSON.parse(await f.text());
      if (pkg?.format !== 'steward-theme') throw new Error('This file is not a theme package (format "steward-theme").');
      importTheme.mutate(pkg);
    } catch (err) {
      toast.error('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  return (
    <>
      <PageHeader
        title="Themes & branding"
        description="White-label the console, hosted checkout and invoice pages, emails and each organization. Edit drafts safely, preview them, then publish."
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<FileUp className="size-4" />} loading={importTheme.isPending} onClick={() => file.current?.click()}>
                Import
              </Button>
              <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Theme package" onChange={(e) => void onImport(e.target.files?.[0])} />
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating({ basedOn: null })}>
                New theme
              </Button>
            </>
          )
        }
      />
      <section>
        <h2 className="mb-3 text-sm font-semibold">Your themes</h2>
        {custom.length === 0 ? (
          <Card>
            <EmptyState icon={<Palette />} title="No custom themes yet" description="Customize a preset below or create a theme from scratch to apply your brand." action={manage && <Button onClick={() => setCreating({ basedOn: null })}>New theme</Button>} />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {custom.map((t) => (
              <ThemeCard key={t.id} theme={t} onCustomize={() => setCreating({ basedOn: t })} onActivate={() => setActivating(t)} />
            ))}
          </div>
        )}
      </section>
      <section className="mt-8">
        <h2 className="mb-1 text-sm font-semibold">Presets</h2>
        <p className="mb-3 text-sm text-muted-foreground">Read-only starting points. Activate one as-is, or customize a copy.</p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {presets.map((t) => (
            <ThemeCard key={t.id} theme={t} onCustomize={() => setCreating({ basedOn: t })} onActivate={() => setActivating(t)} />
          ))}
        </div>
      </section>
      {creating && <NewThemeDialog themes={list} basedOn={creating.basedOn} onClose={() => setCreating(null)} />}
      {activating && <ThemeActivateDialog theme={activating} onClose={() => setActivating(null)} />}
    </>
  );
}
