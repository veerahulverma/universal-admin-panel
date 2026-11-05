import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, Lock, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  ErrorState,
  Field,
  FormError,
  Input,
  PageHeader,
  PageSkeleton,
  SearchInput,
  Switch,
  Textarea,
  useConfirm,
} from '../../components/ui';
import { canGrant, groupByNamespace, isAllowed, namespaceLabel, permissionMatches, usePermissionCatalog, useRoles } from './shared';
import type { AdminRow, PermissionDef, Role } from './types';

interface Draft {
  name: string;
  key: string;
  description: string;
  patterns: string[];
}

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Permission matrix over a list of grant patterns. Checkboxes write exact keys
 * or "<area>.*" wildcards; anything else ("*.*.view", explicit denies "!key")
 * stays editable as an advanced pattern, so no role is ever flattened.
 */
function PermissionMatrix({ catalog, patterns, onChange, readOnly }: { catalog: PermissionDef[]; patterns: string[]; onChange: (p: string[]) => void; readOnly: boolean }) {
  const [filter, setFilter] = useState('');
  const [onlyGranted, setOnlyGranted] = useState(false);
  const keys = useMemo(() => new Set(catalog.map((d) => d.key)), [catalog]);
  const groups = useMemo(() => groupByNamespace(catalog), [catalog]);
  const wildcards = useMemo(() => new Set(groups.map((g) => `${g.ns}.*`)), [groups]);
  const full = patterns.includes('*');
  const advanced = patterns.filter((p) => p !== '*' && !keys.has(p) && !wildcards.has(p) && !(p.startsWith('!') && keys.has(p.slice(1))));
  const [advancedText, setAdvancedText] = useState(advanced.join('\n'));
  const advancedKey = advanced.join('\n');
  const lastAdvanced = useRef(advancedKey);
  if (lastAdvanced.current !== advancedKey) {
    // Patterns changed from outside the textarea (e.g. reset): resync it.
    lastAdvanced.current = advancedKey;
    if (advancedText.split('\n').map((s) => s.trim()).filter(Boolean).join('\n') !== advancedKey) setAdvancedText(advancedKey);
  }

  const denied = (key: string) => patterns.some((p) => p.startsWith('!') && permissionMatches(p.slice(1), key));
  const coveredBy = (key: string) => patterns.find((p) => !p.startsWith('!') && p !== key && permissionMatches(p, key));
  const granted = catalog.filter((d) => isAllowed(patterns, d.key));
  const sensitive = granted.filter((d) => d.dangerous).length;
  const f = filter.trim().toLowerCase();

  const setFull = (on: boolean) => onChange(on ? uniq(['*', ...patterns.filter((p) => p.startsWith('!'))]) : patterns.filter((p) => p !== '*'));
  const setNamespace = (ns: string, on: boolean) =>
    onChange(on ? uniq([...patterns.filter((p) => !(keys.has(p) && p.startsWith(`${ns}.`))), `${ns}.*`]) : patterns.filter((p) => p !== `${ns}.*`));
  const setKey = (key: string, on: boolean) => onChange(on ? uniq([...patterns, key]) : patterns.filter((p) => p !== key));
  const exclude = (key: string, on: boolean) => onChange(on ? uniq([...patterns, `!${key}`]) : patterns.filter((p) => p !== `!${key}`));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-ui border bg-muted/40 px-4 py-3 text-sm">
        <span>
          <span className="font-semibold tabular">{granted.length}</span> of {catalog.length} permissions granted
        </span>
        {sensitive > 0 && (
          <span className="inline-flex items-center gap-1 text-warning">
            <ShieldAlert className="size-4" aria-hidden="true" /> {sensitive} sensitive
          </span>
        )}
        <div className="ml-auto">
          <Switch checked={full} onCheckedChange={setFull} disabled={readOnly} label="Full access (*)" />
        </div>
      </div>
      {full && (
        <Callout tone="warning" title="Full access">
          This role can do everything, including future permissions added by new modules and plugins. Only someone with unrestricted full access can grant it. Exclude specific permissions below if needed.
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Find a permission…" className="w-full sm:w-72" />
        <Checkbox checked={onlyGranted} onChange={(e) => setOnlyGranted(e.target.checked)} label="Only granted" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((g) => {
          const items = g.items.filter((d) => (!f || d.key.includes(f) || d.label.toLowerCase().includes(f)) && (!onlyGranted || isAllowed(patterns, d.key)));
          if (!items.length) return null;
          const ns = `${g.ns}.*`;
          const nsOn = patterns.includes(ns);
          const count = g.items.filter((d) => isAllowed(patterns, d.key)).length;
          return (
            <fieldset key={g.ns} className="rounded-ui border bg-surface shadow-ui">
              <legend className="sr-only">{namespaceLabel(g.ns)}</legend>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <p className="text-sm font-semibold">
                  {namespaceLabel(g.ns)} <span className="font-normal text-muted-foreground tabular">· {count}/{g.items.length}</span>
                </p>
                <Checkbox checked={nsOn || full} disabled={readOnly || full} onChange={(e) => setNamespace(g.ns, e.target.checked)} label={<code className="font-mono text-xs">{ns}</code>} />
              </div>
              <ul className="divide-y">
                {items.map((d) => {
                  const isDenied = denied(d.key);
                  const via = !patterns.includes(d.key) ? coveredBy(d.key) : undefined;
                  const effective = isAllowed(patterns, d.key);
                  return (
                    <li key={d.key} className={clsx('flex items-start gap-3 px-4 py-2', isDenied && 'bg-danger/5')}>
                      <Checkbox
                        className="flex-1"
                        checked={effective}
                        disabled={readOnly || Boolean(via) || isDenied}
                        onChange={(e) => setKey(d.key, e.target.checked)}
                        label={
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            {d.label}
                            {d.dangerous && <Badge tone="warning">sensitive</Badge>}
                          </span>
                        }
                        description={
                          <span className="flex flex-wrap items-center gap-x-2">
                            <code className="font-mono text-xs">{d.key}</code>
                            {via && !isDenied && <span className="text-xs">included by <code className="font-mono">{via}</code></span>}
                            {isDenied && <span className="text-xs text-danger">excluded</span>}
                          </span>
                        }
                      />
                      {!readOnly && (via || isDenied) && patterns.includes(`!${d.key}`) === isDenied && (
                        <button type="button" className="shrink-0 pt-0.5 text-xs text-primary hover:underline" onClick={() => exclude(d.key, !isDenied)}>
                          {isDenied ? 'Undo' : 'Exclude'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
      </div>
      <Field
        label="Advanced patterns"
        htmlFor="advanced-patterns"
        hint={
          <>
            One per line. <code className="font-mono">*.*.view</code> grants every view permission, <code className="font-mono">billing.*.view</code> every billing view permission, and <code className="font-mono">!key</code> denies a permission even if another pattern allows it.
          </>
        }
      >
        <Textarea
          id="advanced-patterns"
          rows={3}
          className="font-mono text-xs"
          value={advancedText}
          disabled={readOnly}
          placeholder="*.*.view"
          onChange={(e) => {
            setAdvancedText(e.target.value);
            const next = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
            lastAdvanced.current = next.join('\n');
            onChange(uniq([...patterns.filter((p) => !advanced.includes(p)), ...next]));
          }}
        />
      </Field>
    </div>
  );
}

function AssignedAdmins({ role }: { role: Role }) {
  const { can } = useAuth();
  const team = useQuery({ queryKey: ['team', ''], queryFn: () => api.get<{ data: AdminRow[] }>('/api/admin/team'), enabled: can('iam.admins.view') });
  if (!can('iam.admins.view')) return null;
  const admins = (team.data?.data ?? []).filter((a) => a.roles.some((r) => r.id === role.id));
  return (
    <Card title="Assigned to" description={`${admins.length} administrator${admins.length === 1 ? '' : 's'}`} padded={false}>
      {admins.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nobody has this role.</p>
      ) : (
        <ul className="divide-y">
          {admins.map((a) => (
            <li key={a.id}>
              <Link to={`/admin/team/${a.id}`} className="flex items-center gap-2.5 px-4 py-2 hover:bg-muted/40">
                <Avatar name={a.name} email={a.email} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{a.email}</span>
                </span>
                {a.status !== 'active' && <Badge>{a.status}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function serialize(d: Draft): string {
  return JSON.stringify({ ...d, patterns: [...d.patterns].sort() });
}

export default function RoleEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const creating = !id;
  const fromId = params.get('from');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can, me } = useAuth();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const role = roles.data?.data.find((r) => r.id === (id ?? fromId));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const leaving = useRef(false);

  // Initialise the form once the role (or the role being duplicated) is known.
  useEffect(() => {
    if (draft || !roles.data) return;
    const base: Draft = creating
      ? role
        ? { name: `${role.name} (copy)`, key: '', description: role.description, patterns: role.permissions }
        : { name: '', key: '', description: '', patterns: [] }
      : role
        ? { name: role.name, key: role.key, description: role.description, patterns: role.permissions }
        : { name: '', key: '', description: '', patterns: [] };
    setDraft(base);
    setInitial(serialize(base));
  }, [roles.data, role, creating, draft]);

  const dirty = Boolean(draft) && serialize(draft!) !== initial;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const { proceed, reset } = blocker;
    void confirm({ title: 'Discard unsaved changes?', description: 'Your changes to this role have not been saved.', confirmLabel: 'Discard', tone: 'danger' }).then((r) => (r.confirmed ? proceed() : reset()));
    // Only react to the transition into "blocked"; the blocker object itself changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  const onError = (err: unknown) => {
    setError(errorMessage(err));
    setFieldErrors(err instanceof ApiError ? err.fieldErrors() : {});
  };
  const create = useAction(
    () => api.post<Role>('/api/admin/roles', { name: draft!.name, key: draft!.key || undefined, description: draft!.description, permissions: draft!.patterns }),
    {
      success: 'Role created',
      invalidate: [['roles']],
      onSuccess: (r) => {
        leaving.current = true;
        navigate(`/admin/roles/${r.id}`, { replace: true });
      },
      onError,
    },
  );
  const update = useAction(() => api.patch<Role>(`/api/admin/roles/${id}`, { name: draft!.name, description: draft!.description, permissions: draft!.patterns }), {
    success: 'Role saved',
    invalidate: [['roles'], ['team']],
    onSuccess: () => setInitial(serialize(draft!)),
    onError,
  });
  const remove = useAction(() => api.delete(`/api/admin/roles/${id}`), {
    success: 'Role deleted',
    invalidate: [['roles']],
    onSuccess: () => {
      leaving.current = true;
      navigate('/admin/roles', { replace: true });
    },
  });

  if (roles.isLoading || catalog.isLoading || !draft) {
    if (roles.error || catalog.error) return <ErrorState error={roles.error ?? catalog.error} onRetry={() => void (roles.error ? roles.refetch() : catalog.refetch())} />;
    return <PageSkeleton />;
  }
  if (!creating && !role) return <ErrorState error={Object.assign(new Error('This role does not exist or was deleted.'), { status: 404 })} title="Role not found" />;

  const system = Boolean(role?.is_system) && !creating;
  const readOnly = system || !can('iam.roles.manage');
  const defs = catalog.data?.data ?? [];
  const grantCheck = canGrant(defs, me?.grants ?? [], draft.patterns);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d!, ...patch }));
  const autoKey = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Roles', to: '/admin/roles' }, { label: creating ? 'New role' : role!.name }]}
        title={creating ? (fromId && role ? `Duplicate ${role.name}` : 'New role') : role!.name}
        meta={
          !creating && (
            <>
              {system ? (
                <Badge>
                  <Lock className="size-3" aria-hidden="true" /> system
                </Badge>
              ) : (
                <Badge tone="primary">custom</Badge>
              )}
              <code className="font-mono text-xs text-muted-foreground">{role!.key}</code>
              <span className="text-xs text-muted-foreground">
                {role!.admin_count} administrator{role!.admin_count === 1 ? '' : 's'}
              </span>
            </>
          )
        }
        actions={
          <>
            {!creating && can('iam.roles.manage') && (
              <ButtonLink to={`/admin/roles/new?from=${role!.id}`} icon={<Copy className="size-4" />}>
                Duplicate
              </ButtonLink>
            )}
            {!creating && !system && can('iam.roles.manage') && (
              <Button
                variant="outline"
                className="text-danger"
                icon={<Trash2 className="size-4" />}
                disabled={role!.admin_count > 0}
                title={role!.admin_count > 0 ? 'Reassign the administrators who have this role first' : undefined}
                loading={remove.isPending}
                onClick={async () => {
                  const r = await confirm({ title: `Delete the ${role!.name} role?`, description: 'This cannot be undone.', confirmLabel: 'Delete role', tone: 'danger' });
                  if (r.confirmed) remove.mutate();
                }}
              >
                Delete
              </Button>
            )}
            {!readOnly && (
              <Button
                loading={create.isPending || update.isPending}
                disabled={!draft.name.trim() || (!creating && !dirty)}
                onClick={() => {
                  setError(null);
                  setFieldErrors({});
                  if (creating) create.mutate();
                  else update.mutate();
                }}
              >
                {creating ? 'Create role' : 'Save changes'}
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-4">
        {system && (
          <Callout title="System roles are read-only">
            They are maintained by the platform and gain new permissions on upgrades. Duplicate this role to create a customized version.
          </Callout>
        )}
        {!readOnly && !grantCheck.ok && (
          <Callout tone="warning" title="You cannot grant everything selected">
            {grantCheck.missing[0] === '*' ? 'Full access can only be granted by an administrator with unrestricted full access.' : `You do not hold: ${grantCheck.missing.slice(0, 6).join(', ')}${grantCheck.missing.length > 6 ? ` and ${grantCheck.missing.length - 6} more` : ''}. The server will refuse to save.`}
          </Callout>
        )}
        <FormError message={error} />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Details" className={clsx(creating ? 'lg:col-span-3' : 'lg:col-span-2')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="role-name" required error={fieldErrors.name}>
                <Input id="role-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={readOnly} maxLength={80} />
              </Field>
              {creating ? (
                <Field label="Key" htmlFor="role-key" hint={`Used in the API. Defaults to "${autoKey || 'derived from the name'}".`} error={fieldErrors.key}>
                  <Input id="role-key" className="font-mono" value={draft.key} onChange={(e) => set({ key: e.target.value })} placeholder={autoKey} maxLength={60} />
                </Field>
              ) : (
                <Field label="Key">
                  <Input value={draft.key} disabled className="font-mono" />
                </Field>
              )}
              <Field label="Description" htmlFor="role-description" className="sm:col-span-2" error={fieldErrors.description}>
                <Textarea id="role-description" rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} disabled={readOnly} maxLength={500} placeholder="What this role is for and who should have it" />
              </Field>
            </div>
          </Card>
          {!creating && role && <AssignedAdmins role={role} />}
        </div>
        <Card title="Permissions" description="Changes apply to every administrator with this role at their next request.">
          {fieldErrors.permissions && (
            <p className="mb-3 inline-flex items-center gap-1.5 text-sm text-danger" role="alert">
              <TriangleAlert className="size-4" /> {fieldErrors.permissions}
            </p>
          )}
          <PermissionMatrix catalog={defs} patterns={draft.patterns} onChange={(patterns) => set({ patterns })} readOnly={readOnly} />
        </Card>
      </div>
    </>
  );
}
