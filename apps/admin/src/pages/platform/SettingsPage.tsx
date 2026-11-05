import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Globe, RotateCcw, Save, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { SchemaForm, humanize, type JsonSchema } from '../../components/SchemaForm';
import { Badge, Button, Callout, Card, EmptyState, ErrorState, PageHeader, PageSkeleton, Select, useConfirm } from '../../components/ui';
import { OrgPicker, useOrgName } from './OrgPicker';
import { EmailSettingsForm } from './EmailSettingsForm';
import { changedKeys, fieldErrors, keepEmptyStrings, normalizeSchema, pick, refreshShell } from './shared';

interface SettingsSection {
  key: string;
  module: string;
  label: string;
  description: string | null;
  tenantOverridable: boolean;
  permission: string;
  schema: JsonSchema;
  defaults: Record<string, unknown>;
  value: Record<string, unknown>;
  override: Record<string, unknown> | null;
}

function SectionForm({ section, scope, orgName }: { section: SettingsSection; scope: string; orgName: string | null }) {
  const { can } = useAuth();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Record<string, unknown>>(section.value);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const schema = useMemo(() => normalizeSchema(section.schema), [section.schema]);
  const dirty = changedKeys(section.value, draft);
  const manage = can(section.permission);
  const isOrg = scope !== 'global';
  const overridden = Object.keys(section.override ?? {});

  const save = useAction(() => api.raw<{ value: Record<string, unknown> }>('PATCH', `/api/admin/settings/${section.key}`, { query: { scope }, body: pick(draft, dirty) }), {
    success: isOrg ? `Override saved for ${orgName}` : `${section.label} settings saved`,
    invalidate: [['settings']],
    onSuccess: (r) => {
      setErrors({});
      setDraft(r.value);
      refreshShell(client);
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const reset = useAction(() => api.raw<{ value: Record<string, unknown> }>('DELETE', `/api/admin/settings/${section.key}`, { query: { scope } }), {
    success: isOrg ? 'Override removed; the organization now uses the global settings' : `${section.label} reset to defaults`,
    invalidate: [['settings']],
    onSuccess: (r) => {
      setErrors({});
      setDraft(r.value);
      refreshShell(client);
    },
  });

  // Unsaved edits are never dropped silently by a section switch or by leaving the page.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty.length > 0 && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm({ title: 'Discard unsaved changes?', description: `Your edits to ${section.label} have not been saved.`, confirmLabel: 'Discard', tone: 'danger' }).then((r) =>
      r.confirmed ? blockerRef.current.proceed?.() : blockerRef.current.reset?.(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  const resetDisabled = isOrg ? overridden.length === 0 : !section.override;

  return (
    <Card
      title={section.label}
      description={section.description ?? undefined}
      actions={
        manage && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="size-3.5" />}
            disabled={resetDisabled || reset.isPending}
            onClick={async () => {
              const { confirmed } = await confirm(
                isOrg
                  ? { title: `Remove the override for ${orgName}?`, description: `${orgName} will use the global ${section.label} settings again.`, confirmLabel: 'Remove override', tone: 'danger' }
                  : { title: `Reset ${section.label} to defaults?`, description: 'Every value in this section returns to the built-in default. This is recorded in the audit log.', confirmLabel: 'Reset section', tone: 'danger' },
              );
              if (confirmed) reset.mutate();
            }}
          >
            {isOrg ? 'Remove override' : 'Reset to defaults'}
          </Button>
        )
      }
    >
      {isOrg && (
        <div className="mb-4">
          <Callout tone="info" title={`Overrides for ${orgName}`}>
            {overridden.length ? (
              <>
                Customized here: {overridden.map(humanize).join(', ')}. Other values are inherited from the global settings.
              </>
            ) : (
              'Nothing is overridden yet; every value below is inherited from the global settings. Saving stores only what you change.'
            )}
          </Callout>
        </div>
      )}
      {!manage && (
        <div className="mb-4">
          <Callout tone="warning">You can view these settings; changing them needs the {section.permission} permission.</Callout>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty.length) save.mutate();
        }}
      >
        <fieldset disabled={!manage || save.isPending} className="min-w-0">
          <SchemaForm schema={schema} value={draft} onChange={(next) => setDraft(keepEmptyStrings(schema, next))} errors={errors} disabled={!manage} />
        </fieldset>
        {manage && (
          <div className="sticky bottom-0 -mx-4 -mb-4 mt-5 flex flex-wrap items-center justify-end gap-2 rounded-b-ui border-t bg-surface/95 px-4 py-3 backdrop-blur">
            {dirty.length > 0 && (
              <span className="mr-auto text-sm text-muted-foreground">
                {dirty.length} unsaved change{dirty.length === 1 ? '' : 's'}
              </span>
            )}
            <Button
              variant="outline"
              icon={<Undo2 className="size-4" />}
              disabled={!dirty.length}
              onClick={() => {
                setDraft(section.value);
                setErrors({});
              }}
            >
              Discard
            </Button>
            <Button type="submit" icon={<Save className="size-4" />} loading={save.isPending} disabled={!dirty.length}>
              {isOrg ? 'Save override' : 'Save changes'}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const { section: sectionParam } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const orgId = params.get('org');
  const scope = orgId ? `org:${orgId}` : 'global';
  const orgName = useOrgName(orgId);
  const settings = useQuery({
    queryKey: ['settings', scope],
    queryFn: ({ signal }) => api.get<{ scope: string; data: SettingsSection[] }>('/api/admin/settings', { scope }, signal),
    placeholderData: keepPreviousData,
  });

  if (settings.isLoading) return <PageSkeleton />;
  if (settings.error || !settings.data) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const sections = settings.data.data;
  if (!sections.length) return <EmptyState title="No settings" description="Enabled modules have no configurable settings." />;
  const active = sections.find((s) => s.key === sectionParam) ?? sections[0];
  const hrefFor = (key: string) => {
    const target = sections.find((s) => s.key === key);
    return `/platform/settings/${key}${orgId && target?.tenantOverridable ? `?org=${encodeURIComponent(orgId)}` : ''}`;
  };
  const scopeMismatch = Boolean(orgId) && !active.tenantOverridable;
  const loadingScope = settings.isFetching && settings.data.scope !== scope;

  return (
    <>
      <PageHeader title="Settings" description="Platform configuration by module. Changes apply immediately and are recorded in the audit log." />
      <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-20 space-y-0.5">
            {sections.map((s) => (
              <li key={s.key}>
                <Link
                  to={hrefFor(s.key)}
                  aria-current={s.key === active.key ? 'page' : undefined}
                  className={clsx(
                    'flex items-center justify-between gap-2 rounded-ui-sm px-2.5 py-1.5 text-md transition-colors',
                    s.key === active.key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span className="truncate">{s.label}</span>
                  {s.tenantOverridable && <Building2 className="size-3.5 shrink-0 opacity-60" aria-label="Can be overridden per organization" />}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4">
          <div className="lg:hidden">
            <Select aria-label="Settings section" value={active.key} onChange={(e) => navigate(hrefFor(e.target.value))} options={sections.map((s) => ({ value: s.key, label: s.label }))} />
          </div>

          {active.tenantOverridable && (
            <div className="flex flex-wrap items-center gap-2 rounded-ui border bg-surface px-3 py-2.5 shadow-ui">
              <span className="text-sm text-muted-foreground">Editing</span>
              {orgId ? (
                <Badge tone="primary">
                  <Building2 className="size-3" aria-hidden="true" /> {orgName} only
                </Badge>
              ) : (
                <Badge>
                  <Globe className="size-3" aria-hidden="true" /> all organizations
                </Badge>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {orgId && (
                  <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
                    Edit global settings
                  </Button>
                )}
                <OrgPicker value={orgId ? { id: orgId, name: orgName ?? orgId } : null} onChange={(o) => setParams({ org: o.id }, { replace: true })} label="Override for an organization…" />
              </div>
            </div>
          )}

          {scopeMismatch ? (
            <Callout tone="info" title={`${active.label} applies to every organization`} action={<Button size="sm" variant="outline" onClick={() => setParams({}, { replace: true })}>Show global settings</Button>}>
              This section cannot be overridden per organization.
            </Callout>
          ) : loadingScope ? (
            <PageSkeleton />
          ) : active.key === 'email' && scope === 'global' ? (
            <EmailSettingsForm key={JSON.stringify(active.value)} section={active} retention={sections.find((s) => s.key === 'retention') ?? null} />
          ) : (
            <SectionForm key={`${active.key}:${scope}`} section={active} scope={scope} orgName={orgName} />
          )}
        </div>
      </div>
    </>
  );
}
