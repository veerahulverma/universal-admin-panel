import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Braces, Download, Play, SquareTerminal, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { SchemaForm, type JsonSchema } from '../../components/SchemaForm';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Input,
  JsonView,
  PageHeader,
  PageSkeleton,
  PasswordInput,
  SearchInput,
  Select,
  Tabs,
  Textarea,
  useConfirm,
} from '../../components/ui';
import { HttpStatus, MethodBadge, ms } from './shared';
import {
  SURFACES,
  bodySchema,
  buildUrl,
  constraints,
  curlSnippet,
  exampleFor,
  fetchSnippet,
  operationsOf,
  paramExample,
  sdkSnippet,
  splitCode,
  typeLabel,
  unwrap,
  type OpenApiDoc,
  type OpenApiParam,
  type Operation,
  type RequestInput,
  type SurfaceId,
} from './explorer-utils';

const DEFAULTS = { surface: 'v1', op: '' };

interface ApiResponse {
  status: number | null;
  durationMs: number;
  headers: [string, string][];
  contentType: string;
  body: unknown;
  note?: string;
}

const SHOWN_HEADERS = ['content-type', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'x-error-code'];

function Prose({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-md text-muted-foreground">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {splitCode(para).map((part, j) =>
            part.code ? (
              <code key={j} className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {part.text}
              </code>
            ) : (
              <span key={j}>{part.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** Request body schema as an indented field list (name, type, required, constraints, description). */
function SchemaTree({ schema, depth = 0 }: { schema: JsonSchema; depth?: number }) {
  const s = unwrap(schema);
  const itemProps = s.type === 'array' && s.items ? unwrap(s.items).properties : undefined;
  const props = s.properties ?? itemProps;
  if (!props) return <p className="text-sm text-muted-foreground">{typeLabel(schema)}</p>;
  const required = new Set((s.properties ? s.required : s.items && unwrap(s.items).required) ?? []);
  return (
    <ul className={clsx('divide-y', depth > 0 && 'ml-4 border-l pl-3')}>
      {Object.entries(props).map(([name, prop]) => {
        const p = unwrap(prop);
        const nested = (p.type === 'object' && p.properties) || (p.type === 'array' && p.items && unwrap(p.items).properties);
        return (
          <li key={name} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <code className="font-mono text-xs font-semibold">{name}</code>
              <span className="font-mono text-xs text-muted-foreground">{typeLabel(prop)}</span>
              {required.has(name) && <Badge tone="warning">required</Badge>}
              {constraints(prop).map((c) => (
                <span key={c} className="text-xs text-muted-foreground">
                  {c}
                </span>
              ))}
            </div>
            {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
            {nested && depth < 3 && (
              <div className="mt-1">
                <SchemaTree schema={p} depth={depth + 1} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ParamInput({ param, path, value, onChange }: { param: OpenApiParam; path: string; value: string; onChange: (v: string) => void }) {
  const s = param.schema ? unwrap(param.schema) : undefined;
  const id = `param-${param.in}-${param.name}`;
  const label = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <code className="font-mono">{param.name}</code>
      <span className="font-normal text-muted-foreground">{param.in} · {typeLabel(param.schema)}</span>
      {param.required && <Badge tone="warning">required</Badge>}
    </span>
  );
  const control = s?.enum ? (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={param.required ? undefined : 'Not set'} options={s.enum.map(String)} />
  ) : s?.type === 'boolean' ? (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Not set" options={['true', 'false']} />
  ) : (
    <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" placeholder={param.in === 'path' ? paramExample(path, param.name, param.schema) : s?.default !== undefined ? String(s.default) : undefined} inputMode={s?.type === 'integer' || s?.type === 'number' ? 'numeric' : undefined} />
  );
  return (
    <Field label={label} hint={param.description} htmlFor={id}>
      {control}
    </Field>
  );
}

function ResponseView({ res }: { res: ApiResponse }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {res.status !== null ? <HttpStatus status={res.status} /> : <Badge tone="danger">network error</Badge>}
        <span className="text-muted-foreground tabular">{ms(Math.round(res.durationMs))}</span>
        {res.note && <span className="text-xs text-muted-foreground">{res.note}</span>}
      </div>
      {res.headers.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1 rounded-ui-sm bg-muted/50 p-3 text-xs sm:grid-cols-[max-content_1fr]">
          {res.headers.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-muted-foreground">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {typeof res.body === 'string' ? <CodeBlock code={res.body || '(empty body)'} className="max-h-96 overflow-y-auto" /> : <JsonView value={res.body} className="max-h-96 overflow-y-auto" />}
    </div>
  );
}

function OperationView({ surface, op, base, credential, setCredential }: { surface: SurfaceId; op: Operation; base: string; credential: string; setCredential: (v: string) => void }) {
  const { me } = useAuth();
  const confirm = useConfirm();
  const schema = bodySchema(op.op);
  const params = op.op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');
  const formable = Boolean(schema && unwrap(schema).type === 'object' && unwrap(schema).properties);

  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState<Record<string, unknown>>(() => (schema ? ((exampleFor(schema) as Record<string, unknown>) ?? {}) : {}));
  const [bodyMode, setBodyMode] = useState<'form' | 'json'>(formable ? 'form' : 'json');
  const [bodyText, setBodyText] = useState(() => JSON.stringify(schema ? exampleFor(schema) : {}, null, 2));
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  const currentBody = (): unknown => (bodyMode === 'form' ? body : JSON.parse(bodyText || '{}'));
  let snippetBody: unknown = body;
  if (bodyMode === 'json') {
    try {
      snippetBody = JSON.parse(bodyText || '{}');
    } catch {
      snippetBody = {};
    }
  }
  const filledPath = Object.fromEntries(pathParams.map((p) => [p.name, pathValues[p.name] || paramExample(op.path, p.name, p.schema)]));
  const input: RequestInput = { method: op.method, path: op.path, pathParams: filledPath, query: queryValues, body: snippetBody, hasBody: Boolean(schema) };
  const sdk = surface === 'v1' ? sdkSnippet(base, input) : null;
  const missingPath = pathParams.filter((p) => !pathValues[p.name]?.trim());
  const needsCredential = (surface === 'v1' || surface === 'client') && !credential.trim();

  const switchMode = (mode: 'form' | 'json') => {
    if (mode === bodyMode) return;
    if (mode === 'json') {
      setBodyText(JSON.stringify(body, null, 2));
      setBodyError(null);
      setBodyMode('json');
      return;
    }
    try {
      const parsed = JSON.parse(bodyText || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The body must be a JSON object to use the form');
      setBody(parsed);
      setBodyError(null);
      setBodyMode('form');
    } catch (err) {
      setBodyError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  const send = async () => {
    let payload: unknown;
    try {
      payload = schema ? currentBody() : undefined;
    } catch {
      setBodyError('Fix the JSON body first');
      return;
    }
    if (op.method !== 'GET') {
      const live = surface === 'admin' || credential.startsWith('sk_live_');
      const { confirmed } = await confirm({
        title: `Send ${op.method} ${op.path}?`,
        description: live ? 'This is a real request against live data and may change or delete records. It is recorded like any other call.' : 'This is a real request and may change data.',
        confirmLabel: 'Send request',
        tone: op.method === 'DELETE' ? 'danger' : 'default',
      });
      if (!confirmed) return;
    }
    const path = buildUrl({ path: op.path, pathParams: Object.fromEntries(pathParams.map((p) => [p.name, pathValues[p.name] ?? ''])), query: {} });
    const query = Object.fromEntries(Object.entries(queryValues).filter(([, v]) => v !== ''));
    const url = `${path}${qs(query)}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (surface === 'v1' || surface === 'client') headers.authorization = `Bearer ${credential.trim()}`;
    if (surface === 'admin' && op.method !== 'GET' && me?.csrfToken) headers['x-csrf-token'] = me.csrfToken;

    setSending(true);
    setResponse(null);
    const started = performance.now();
    try {
      // Admin calls ride on your session; other surfaces never send the admin cookie.
      const res = await fetch(url, { method: op.method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), credentials: surface === 'admin' ? 'same-origin' : 'omit' });
      const contentType = res.headers.get('content-type') ?? '';
      let resBody: unknown;
      if (contentType.includes('application/json')) resBody = await res.json();
      else if (contentType.startsWith('text/') || !contentType) {
        const text = await res.text();
        resBody = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${num(text.length)} characters)` : text;
      } else resBody = `Binary response: ${contentType}, ${num((await res.arrayBuffer()).byteLength)} bytes`;
      const durationMs = performance.now() - started;

      // Sensitive admin actions need a fresh re-authentication: go through the console's client, which asks for it and retries.
      if (surface === 'admin' && res.status === 403 && (resBody as { error?: { code?: string } })?.error?.code === 'reauth_required') {
        try {
          const retried = await api.raw<unknown>(op.method, path, { query, body: payload });
          setResponse({ status: null, durationMs: performance.now() - started, headers: [], contentType: 'application/json', body: retried ?? '(empty body)', note: 'Succeeded after re-authentication.' });
        } catch (err) {
          const e = err instanceof ApiError ? { error: { code: err.code, message: err.message, details: err.details, requestId: err.requestId } } : String(err);
          setResponse({ status: err instanceof ApiError ? err.status : null, durationMs: performance.now() - started, headers: [], contentType: 'application/json', body: e });
        }
        return;
      }
      setResponse({
        status: res.status,
        durationMs,
        contentType,
        headers: SHOWN_HEADERS.map((h) => [h, res.headers.get(h)] as [string, string | null]).filter((h): h is [string, string] => h[1] !== null),
        body: resBody,
      });
    } catch (err) {
      setResponse({ status: null, durationMs: performance.now() - started, headers: [], contentType: '', body: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <MethodBadge method={op.method} />
          <code className="min-w-0 break-all font-mono text-md font-semibold">{op.path}</code>
          {op.op.tags?.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
        {op.op.summary && <h2 className="mt-3 text-base font-semibold">{op.op.summary}</h2>}
        {op.op.description && (
          <div className="mt-2">
            <Prose text={op.op.description} />
          </div>
        )}
      </Card>

      {(params.length > 0 || schema) && (
        <Card title="Request">
          <div className="space-y-5">
            {params.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Parameters</caption>
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Parameter</th>
                      <th className="py-2 pr-3 font-medium">In</th>
                      <th className="py-2 pr-3 font-medium">Type</th>
                      <th className="py-2 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {params.map((p) => (
                      <tr key={`${p.in}:${p.name}`} className="border-b last:border-0 align-top">
                        <td className="py-2 pr-3">
                          <code className="font-mono text-xs font-semibold">{p.name}</code>
                          {p.required && <span className="ml-1 text-danger" aria-label="required">*</span>}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{p.in}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{typeLabel(p.schema)}</td>
                        <td className="py-2 text-sm text-muted-foreground">{[p.description, ...(p.schema ? constraints(p.schema) : [])].filter(Boolean).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {schema && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">JSON body {op.op.requestBody?.required ? '(required)' : ''}</p>
                <SchemaTree schema={schema} />
              </div>
            )}
          </div>
        </Card>
      )}

      <Card title="Code samples">
        <Tabs
          tabs={[
            { value: 'curl', label: 'cURL', content: <CodeBlock code={curlSnippet(surface, base, input)} /> },
            { value: 'node', label: 'Node SDK', hidden: !sdk, content: sdk && <CodeBlock code={sdk} /> },
            { value: 'fetch', label: 'JavaScript', content: <CodeBlock code={fetchSnippet(surface, base, input)} /> },
          ]}
        />
        {surface === 'admin' && <p className="mt-2 text-xs text-muted-foreground">Scripts authenticate to the admin API with a session token from <code className="font-mono">POST /api/admin/auth/login</code> using <code className="font-mono">client: "mobile"</code>, subject to 2FA and IP rules. Prefer the integration API with a scoped key for automation.</p>}
        {surface === 'v1' && !sdk && <p className="mt-2 text-xs text-muted-foreground">No typed SDK helper for this endpoint yet: call it with fetch.</p>}
      </Card>

      <Card title="Try it" description={surface === 'public' ? 'Public endpoint: no credentials are sent.' : surface === 'admin' ? 'Runs as you, with your current session and permissions.' : undefined}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {(surface === 'v1' || surface === 'client') && (
            <Field
              label={surface === 'v1' ? 'Secret API key' : 'Customer session token'}
              htmlFor="explorer-credential"
              hint={surface === 'v1' ? 'Kept in this page only: never saved or sent anywhere except with this request. Use a test key (sk_test_…).' : 'Create one with POST /api/v1/customer-sessions. Kept in this page only.'}
            >
              <PasswordInput id="explorer-credential" autoComplete="off" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={surface === 'v1' ? 'sk_test_…' : 'cs_…'} className="font-mono" />
            </Field>
          )}
          {credential.startsWith('sk_live_') && (
            <Callout tone="warning" title="Live key">
              Requests sent with a live key act on production data.
            </Callout>
          )}
          {pathParams.length + queryParams.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {pathParams.map((p) => (
                <ParamInput key={`path:${p.name}`} param={p} path={op.path} value={pathValues[p.name] ?? ''} onChange={(v) => setPathValues((s) => ({ ...s, [p.name]: v }))} />
              ))}
              {queryParams.map((p) => (
                <ParamInput key={`query:${p.name}`} param={p} path={op.path} value={queryValues[p.name] ?? ''} onChange={(v) => setQueryValues((s) => ({ ...s, [p.name]: v }))} />
              ))}
            </div>
          )}
          {schema && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Body</p>
                {formable && (
                  <div role="radiogroup" aria-label="Body editor" className="inline-flex rounded-ui-sm border p-0.5">
                    {(['form', 'json'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={bodyMode === m}
                        onClick={() => switchMode(m)}
                        className={clsx('rounded-[calc(var(--radius)-3px)] px-2.5 py-0.5 text-xs font-medium', bodyMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                      >
                        {m === 'form' ? 'Form' : 'JSON'}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {bodyMode === 'form' && formable ? (
                <div className="rounded-ui border p-3">
                  <SchemaForm schema={unwrap(schema)} value={body} onChange={setBody} />
                </div>
              ) : (
                <>
                  <Textarea
                    aria-label="JSON body"
                    rows={Math.min(18, Math.max(5, bodyText.split('\n').length + 1))}
                    className="font-mono text-xs"
                    value={bodyText}
                    invalid={Boolean(bodyError)}
                    onChange={(e) => {
                      setBodyText(e.target.value);
                      try {
                        JSON.parse(e.target.value || '{}');
                        setBodyError(null);
                      } catch {
                        setBodyError('Invalid JSON');
                      }
                    }}
                  />
                </>
              )}
              {bodyError && <p className="text-xs text-danger">{bodyError}</p>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" icon={<Play className="size-4" />} loading={sending} disabled={needsCredential || missingPath.length > 0 || Boolean(bodyError)}>
              Send request
            </Button>
            {needsCredential && <span className="text-xs text-muted-foreground">Enter {surface === 'v1' ? 'an API key' : 'a session token'} to send.</span>}
            {!needsCredential && missingPath.length > 0 && <span className="text-xs text-muted-foreground">Fill in {missingPath.map((p) => p.name).join(', ')}.</span>}
          </div>
        </form>
        {response && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Response</p>
            <ResponseView res={response} />
          </div>
        )}
      </Card>
    </div>
  );
}

export default function ExplorerPage() {
  const [state, setState] = useUrlState(DEFAULTS);
  const surface = SURFACES.find((s) => s.id === state.surface) ?? SURFACES[0];
  const [q, setQ] = useState('');
  // Secrets typed into the explorer live only in this component's memory.
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const doc = useQuery({ queryKey: ['developers', 'openapi', surface.id], queryFn: () => api.get<OpenApiDoc>(surface.doc), staleTime: 5 * 60_000 });
  const ops = useMemo(() => (doc.data ? operationsOf(doc.data) : []), [doc.data]);
  const lower = q.trim().toLowerCase();
  const filtered = useMemo(() => ops.filter((o) => !lower || o.path.toLowerCase().includes(lower) || (o.op.summary ?? '').toLowerCase().includes(lower) || o.tag.toLowerCase().includes(lower) || o.method.toLowerCase() === lower), [ops, lower]);
  const groups = useMemo(() => {
    const map = new Map<string, Operation[]>();
    for (const o of filtered) map.set(o.tag, [...(map.get(o.tag) ?? []), o]);
    return [...map.entries()];
  }, [filtered]);
  const selected = ops.find((o) => o.id === state.op) ?? filtered[0] ?? null;
  const base = doc.data?.servers?.[0]?.url ?? window.location.origin;

  return (
    <>
      <PageHeader
        title="API explorer"
        description="Every endpoint, generated from the server's live OpenAPI documents, with schemas, code samples and a console to try requests."
        actions={
          doc.data && (
            <a href={surface.doc} download={`steward-${surface.id}-openapi.json`} className="inline-flex h-9 items-center gap-1.5 rounded-ui-sm border bg-surface px-3.5 text-sm font-medium shadow-ui hover:bg-muted/60">
              <Download className="size-4" aria-hidden="true" /> OpenAPI JSON
            </a>
          )
        }
      />
      <div role="radiogroup" aria-label="API" className="mb-4 flex flex-wrap gap-2">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={s.id === surface.id}
            onClick={() => {
              setQ('');
              setState({ surface: s.id, op: undefined });
            }}
            className={clsx('min-w-40 flex-1 rounded-ui border px-3 py-2 text-left transition-colors sm:flex-none', s.id === surface.id ? 'border-primary bg-primary/5' : 'bg-surface hover:bg-muted/50')}
          >
            <span className="block text-sm font-medium">{s.label}</span>
            <span className="block text-xs text-muted-foreground">{s.blurb}</span>
          </button>
        ))}
      </div>

      {doc.isLoading ? (
        <PageSkeleton />
      ) : doc.error || !doc.data ? (
        <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start">
            <Card padded={false} className="flex flex-col lg:max-h-[calc(100dvh-6rem)]">
              <div className="border-b p-3">
                <SearchInput value={q} onChange={setQ} placeholder={`Search ${num(ops.length)} endpoints…`} />
              </div>
              <div className="p-3 lg:hidden">
                <Select aria-label="Endpoint" value={selected?.id ?? ''} onChange={(e) => setState({ op: e.target.value })} options={filtered.map((o) => ({ value: o.id, label: `${o.method} ${o.path}` }))} />
              </div>
              <nav aria-label="Endpoints" className="hidden min-h-0 flex-1 overflow-y-auto p-2 lg:block">
                {groups.length === 0 && <p className="p-3 text-sm text-muted-foreground">No endpoints match.</p>}
                {groups.map(([tag, items]) => (
                  <div key={tag} className="mb-3">
                    <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{tag}</p>
                    <ul>
                      {items.map((o) => (
                        <li key={o.id}>
                          <button
                            type="button"
                            onClick={() => setState({ op: o.id })}
                            aria-current={selected?.id === o.id ? 'true' : undefined}
                            className={clsx('flex w-full items-center gap-2 rounded-ui-sm px-2 py-1.5 text-left', selected?.id === o.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted')}
                            title={o.op.summary}
                          >
                            <span className={clsx('w-12 shrink-0 font-mono text-2xs font-semibold', { GET: 'text-info', POST: 'text-success', PUT: 'text-warning', PATCH: 'text-warning', DELETE: 'text-danger' }[o.method])}>{o.method}</span>
                            <span className="min-w-0 truncate font-mono text-xs">{o.path.replace(/^\/api\/(v1|client|admin|public)/, '')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
              <div className="hidden border-t px-3 py-2 text-xs text-muted-foreground lg:block">
                {doc.data.info.title} · v{doc.data.info.version}
              </div>
            </Card>
          </aside>
          {selected ? (
            <OperationView key={`${surface.id}:${selected.id}`} surface={surface.id} op={selected} base={base} credential={credentials[surface.id] ?? ''} setCredential={(v) => setCredentials((c) => ({ ...c, [surface.id]: v }))} />
          ) : (
            <EmptyState icon={<SquareTerminal />} title="No endpoints" description="This API surface has no documented endpoints." />
          )}
        </div>
      )}
      {doc.data && surface.id === 'v1' && (
        <Card className="mt-4" title="Conventions" padded>
          <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <li className="flex gap-2"><Braces className="mt-0.5 size-4 shrink-0" aria-hidden="true" />Errors return <code className="font-mono">{'{ error: { code, message, details, requestId } }'}</code> with a 4xx/5xx status.</li>
            <li className="flex gap-2"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />Rate limits are per key; read the <code className="font-mono">X-RateLimit-*</code> headers and back off on 429 using <code className="font-mono">Retry-After</code>.</li>
          </ul>
        </Card>
      )}
    </>
  );
}
