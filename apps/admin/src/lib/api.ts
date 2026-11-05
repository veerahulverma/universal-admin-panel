/**
 * Admin API client. Cookie session + CSRF header for writes; typed errors;
 * automatic re-authentication when the server asks for it on sensitive actions.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from a validation_error, keyed by the last path segment. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: (string | number)[]; message?: string }[]) {
        const key = (d.path ?? []).filter((p) => p !== 'body' && p !== 'query' && p !== 'params').join('.');
        if (key && d.message && !out[key]) out[key] = d.message;
      }
    }
    return out;
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
export function onReauthRequired(handler: ReauthHandler | null): void {
  reauthHandler = handler;
}

type UnauthorizedHandler = (code: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','));
    } else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Raw body (FormData for uploads). */
  form?: FormData;
  signal?: AbortSignal;
  /** Do not trigger the global sign-out redirect on 401 (used by auth screens). */
  quiet401?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('application/json') ? await res.json() : await res.text();
  if (res.ok) return payload as T;
  const err = (payload as any)?.error ?? {};
  const error = new ApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? res.statusText, err.details, err.requestId);
  if (error.code === 'reauth_required' && !retried && reauthHandler) {
    if (await reauthHandler()) return request<T>(method, path, opts, true);
  }
  if (res.status === 401 && !opts.quiet401) unauthorizedHandler?.(error.code);
  throw error;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('POST', path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, { form }),
  raw: request,
};

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Download a file from an authenticated GET endpoint (CSV/PDF/JSON exports). */
export async function download(path: string, query?: Query, fallbackName = 'download'): Promise<void> {
  const res = await fetch(`${path}${qs(query)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? 'download_failed', body?.error?.message ?? 'Download failed');
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'validation_error') {
      const fields = Object.entries(err.fieldErrors());
      if (fields.length) return fields.map(([k, v]) => `${k}: ${v}`).join(' · ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
