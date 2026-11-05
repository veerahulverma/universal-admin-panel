import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { AppError, conflict, notFound, validationError } from '../../core/errors.js';
import { keySlug } from '../../core/validation.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { safeRequest } from '../../core/net.js';
import { diff } from '../../core/json.js';
import { HOUR, MINUTE } from '../../core/clock.js';
import { getUser } from '../customers/service.js';

/**
 * Social sign-in (Google, GitHub, Microsoft, or any OpenID Connect provider)
 * for apps that use the built-in identity. It needs an OAuth app registered
 * with the provider: its client ID and secret, and your app's callback URL
 * registered there. Your backend drives the flow:
 *
 *   1. POST /api/v1/identity/social/:provider/start   -> redirect the browser to authorizationUrl
 *   2. the provider redirects to your callback URL with ?code&state
 *   3. POST /api/v1/identity/social/:provider/callback -> a session, like a password sign-in
 *
 * Accounts are linked by provider identity first, then by email address only
 * when the provider says the address is verified.
 */

export const PROVIDER_TYPES = ['google', 'github', 'microsoft', 'oidc'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderRow {
  id: string;
  key: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  client_id: string;
  scopes: string[];
  config: { issuer?: string; tenant?: string; trustEmail?: boolean };
  allow_signup: boolean;
  redirect_urls: string[];
  created_at: Date;
  updated_at: Date;
}

interface Endpoints {
  authorization: string;
  token: string;
  userinfo: string;
  /** GitHub only: the user's addresses with their verification state. */
  emails?: string;
  scopes: string[];
}

export interface SocialProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  locale: string | null;
}

const DEFAULT_NAMES: Record<ProviderType, string> = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft', oidc: 'OpenID Connect' };
const STATE_TTL = 10 * MINUTE;
const discoveryCache = new Map<string, { at: number; endpoints: Endpoints }>();

function allowPrivate(app: App): boolean {
  return app.config.allowPrivateNetwork;
}

async function providerJson(app: App, url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<any> {
  const res = await safeRequest(url, {
    method: opts.method,
    headers: { accept: 'application/json', 'user-agent': 'Steward', ...opts.headers },
    body: opts.body,
    timeoutMs: 10_000,
    allowPrivate: allowPrivate(app),
    maxResponseBytes: 256 * 1024,
  });
  let data: any = null;
  try {
    data = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  if (res.status >= 400 || data === null) {
    const reason = data?.error_description ?? data?.error ?? `HTTP ${res.status}`;
    throw new AppError(502, 'provider_error', `The sign-in provider refused the request: ${String(reason).slice(0, 200)}`);
  }
  return data;
}

async function endpointsFor(app: App, p: Pick<ProviderRow, 'type' | 'config' | 'scopes'>): Promise<Endpoints> {
  const scopes = (fallback: string[]) => (p.scopes.length ? p.scopes : fallback);
  switch (p.type) {
    case 'google':
      return { authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo', scopes: scopes(['openid', 'email', 'profile']) };
    case 'github':
      return { authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user', emails: 'https://api.github.com/user/emails', scopes: scopes(['read:user', 'user:email']) };
    case 'microsoft': {
      const tenant = encodeURIComponent(p.config.tenant || 'common');
      return {
        authorization: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        userinfo: 'https://graph.microsoft.com/oidc/userinfo',
        scopes: scopes(['openid', 'email', 'profile']),
      };
    }
    case 'oidc': {
      const issuer = (p.config.issuer ?? '').replace(/\/+$/, '');
      const cached = discoveryCache.get(issuer);
      if (cached && Date.now() - cached.at < HOUR) return { ...cached.endpoints, scopes: scopes(cached.endpoints.scopes) };
      const doc = await providerJson(app, `${issuer}/.well-known/openid-configuration`);
      if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
        throw new AppError(502, 'provider_misconfigured', 'The issuer’s discovery document lacks the authorization, token or userinfo endpoint');
      }
      const endpoints = { authorization: doc.authorization_endpoint, token: doc.token_endpoint, userinfo: doc.userinfo_endpoint, scopes: ['openid', 'email', 'profile'] };
      discoveryCache.set(issuer, { at: Date.now(), endpoints });
      return { ...endpoints, scopes: scopes(endpoints.scopes) };
    }
  }
}

/** Map a provider's user record to one shape. Unverified addresses are never used to link accounts. */
export function normalizeProfile(type: ProviderType, info: any, emails: { email: string; primary: boolean; verified: boolean }[] | null, config: ProviderRow['config']): SocialProfile {
  if (type === 'github') {
    const primary = emails?.find((e) => e.primary && e.verified) ?? emails?.find((e) => e.verified) ?? null;
    return {
      subject: String(info.id),
      email: (primary?.email ?? info.email ?? null)?.toLowerCase() ?? null,
      emailVerified: Boolean(primary),
      name: info.name || info.login || null,
      avatarUrl: info.avatar_url ?? null,
      locale: null,
    };
  }
  const email = typeof info.email === 'string' ? info.email.toLowerCase() : null;
  // Microsoft work accounts carry addresses set by each tenant's administrators: trust them only when configured to.
  const verified = type === 'microsoft' ? Boolean(config.trustEmail) : info.email_verified === true || info.email_verified === 'true' || (Boolean(config.trustEmail) && info.email_verified === undefined);
  return {
    subject: String(info.sub ?? info.oid ?? ''),
    email,
    emailVerified: Boolean(email) && verified,
    name: info.name || [info.given_name, info.family_name].filter(Boolean).join(' ') || null,
    avatarUrl: info.picture ?? null,
    locale: typeof info.locale === 'string' ? info.locale.slice(0, 10) : null,
  };
}

export async function loadProvider(db: Db, key: string, opts: { enabledOnly?: boolean } = {}): Promise<ProviderRow> {
  const row = await db.maybe<ProviderRow>(sql`SELECT * FROM identity_providers WHERE key = ${key} ${opts.enabledOnly ? sql`AND enabled` : sql.empty}`);
  if (!row) throw notFound('Sign-in provider');
  return row;
}

/** Step 1: a provider URL to send the browser to, bound to a one-time state and a PKCE verifier. */
export async function startSocialSignIn(db: Db, app: App, provider: ProviderRow, redirectUri: string): Promise<{ authorizationUrl: string; state: string; expiresAt: Date }> {
  if (!provider.redirect_urls.includes(redirectUri)) {
    throw validationError([{ path: ['redirectUri'], message: 'This callback URL is not in the provider’s allowed list' }]);
  }
  const endpoints = await endpointsFor(app, provider);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const nonce = randomToken(16);
  const id = newId('ost');
  const now = app.clock.now();
  const expiresAt = new Date(now.getTime() + STATE_TTL);
  await db.exec(sql.insert('oauth_states', {
    id,
    state_hash: sha256(state),
    provider_id: provider.id,
    redirect_uri: redirectUri,
    code_verifier: app.encryptor.encrypt(verifier, `oauth_state:${id}`),
    nonce,
    expires_at: expiresAt,
    created_at: now,
  }, ''));
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: provider.client_id,
    redirect_uri: redirectUri,
    scope: endpoints.scopes.join(' '),
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(provider.type === 'google' ? { prompt: 'select_account' } : {}),
  }).toString();
  return { authorizationUrl: url.toString(), state, expiresAt };
}

/** Step 3: exchange the code for the provider's profile. The state is single-use and expires after ten minutes. */
export async function completeSocialSignIn(db: Db, app: App, provider: ProviderRow, code: string, state: string): Promise<SocialProfile> {
  const row = await db.maybe<{ id: string; redirect_uri: string; code_verifier: string }>(sql`
    UPDATE oauth_states SET used_at = ${app.clock.now()}
    WHERE state_hash = ${sha256(state)} AND provider_id = ${provider.id} AND used_at IS NULL AND expires_at > ${app.clock.now()}
    RETURNING id, redirect_uri, code_verifier
  `);
  if (!row) throw new AppError(400, 'state_invalid', 'This sign-in attempt has expired or was already used; start again');
  const secret = await app.secrets.get(db, 'identity_provider', provider.id, 'client_secret');
  if (!secret) throw new AppError(503, 'provider_unconfigured', 'The sign-in provider has no client secret');
  const endpoints = await endpointsFor(app, provider);
  const token = await providerJson(app, endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: row.redirect_uri,
      client_id: provider.client_id,
      client_secret: secret,
      code_verifier: app.encryptor.decrypt(row.code_verifier, `oauth_state:${row.id}`),
    }).toString(),
  });
  if (!token.access_token) throw new AppError(502, 'provider_error', 'The sign-in provider returned no access token');
  const auth = { authorization: `Bearer ${token.access_token}` };
  const info = await providerJson(app, endpoints.userinfo, { headers: auth });
  const emails = endpoints.emails ? await providerJson(app, endpoints.emails, { headers: auth }).catch(() => null) : null;
  const profile = normalizeProfile(provider.type, info, Array.isArray(emails) ? emails : null, provider.config);
  if (!profile.subject) throw new AppError(502, 'provider_error', 'The sign-in provider returned no user identifier');
  return profile;
}

function present(p: ProviderRow, secret: { last4: string | null } | null) {
  return {
    id: p.id,
    key: p.key,
    type: p.type,
    name: p.name,
    enabled: p.enabled,
    clientId: p.client_id,
    hasSecret: Boolean(secret),
    secretLast4: secret?.last4 ?? null,
    scopes: p.scopes,
    issuer: p.config.issuer ?? null,
    tenant: p.config.tenant ?? null,
    trustEmail: Boolean(p.config.trustEmail),
    allowSignup: p.allow_signup,
    redirectUrls: p.redirect_urls,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

async function secretInfo(db: Db, app: App, providerId: string) {
  return (await app.secrets.describe(db, 'identity_provider', providerId)).find((s) => s.name === 'client_secret') ?? null;
}

const httpsUrl = z.string().trim().url().max(1000);

const providerBody = z.object({
  type: z.enum(PROVIDER_TYPES),
  key: keySlug.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(2000),
  scopes: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  /** OpenID Connect: the issuer URL (its /.well-known/openid-configuration is read). */
  issuer: httpsUrl.optional(),
  /** Microsoft: the directory (tenant) ID, or common / organizations / consumers. */
  tenant: z.string().trim().max(100).regex(/^[A-Za-z0-9.-]+$/, 'Use a tenant ID or common, organizations, consumers').optional(),
  /** Treat addresses from this provider as verified even without an email_verified claim. */
  trustEmail: z.boolean().default(false),
  /** Your app's callback URLs; start requests must use one of them. */
  redirectUrls: z.array(httpsUrl).min(1).max(20),
  allowSignup: z.boolean().default(true),
  enabled: z.boolean().default(false),
});

export function registerSocialAdminRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/identity/providers',
    auth: 'admin',
    permission: 'identity.providers.view',
    summary: 'Social sign-in providers',
    tags: ['Identity'],
    handler: async () => {
      const rows = await app.db.many<ProviderRow>(sql`SELECT * FROM identity_providers ORDER BY name`);
      return { data: await Promise.all(rows.map(async (p) => present(p, await secretInfo(app.db, app, p.id)))) };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/identity/providers',
    auth: 'admin',
    permission: 'identity.providers.manage',
    sensitive: true,
    summary: 'Add a social sign-in provider (needs the OAuth app credentials from the provider)',
    tags: ['Identity'],
    body: providerBody,
    handler: async (c) => {
      const b = c.body;
      if (b.type === 'oidc' && !b.issuer) throw validationError([{ path: ['issuer'], message: 'OpenID Connect providers need the issuer URL' }]);
      const key = b.key ?? (b.type === 'oidc' ? null : b.type);
      if (!key) throw validationError([{ path: ['key'], message: 'Choose a key for this provider' }]);
      return app.db.tx(async (tx) => {
        if (await tx.maybe(sql`SELECT 1 FROM identity_providers WHERE key = ${key}`)) throw conflict('A provider with this key already exists', 'provider_key_taken');
        const now = app.clock.now();
        const row = await tx.one<ProviderRow>(sql.insert('identity_providers', {
          id: newId('idp'),
          key,
          type: b.type,
          name: b.name ?? DEFAULT_NAMES[b.type],
          enabled: b.enabled,
          client_id: b.clientId,
          scopes: b.scopes,
          config: { issuer: b.issuer, tenant: b.tenant, trustEmail: b.trustEmail },
          allow_signup: b.allowSignup,
          redirect_urls: b.redirectUrls,
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }));
        await app.secrets.set(tx, 'identity_provider', row.id, 'client_secret', b.clientSecret);
        await c.audit(tx, 'identity.provider_create', { type: 'identity_provider', id: row.id }, { key, type: b.type, enabled: b.enabled });
        return present(row, await secretInfo(tx, app, row.id));
      });
    },
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/identity/providers/:id',
    auth: 'admin',
    permission: 'identity.providers.manage',
    sensitive: true,
    summary: 'Update a provider; the client secret changes only when a new one is sent',
    tags: ['Identity'],
    params: z.object({ id: z.string() }),
    body: providerBody.omit({ type: true, key: true }).partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await tx.maybe<ProviderRow>(sql`SELECT * FROM identity_providers WHERE id = ${c.params.id} FOR UPDATE`);
        if (!before) throw notFound('Sign-in provider');
        const b = c.body;
        const config = { ...before.config, ...(b.issuer !== undefined ? { issuer: b.issuer } : {}), ...(b.tenant !== undefined ? { tenant: b.tenant } : {}), ...(b.trustEmail !== undefined ? { trustEmail: b.trustEmail } : {}) };
        const patch = { name: b.name, enabled: b.enabled, client_id: b.clientId, scopes: b.scopes, config, allow_signup: b.allowSignup, redirect_urls: b.redirectUrls };
        const changes = diff(before as unknown as Record<string, unknown>, patch);
        const row = await tx.one<ProviderRow>(sql`UPDATE identity_providers SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${before.id} RETURNING *`);
        if (b.clientSecret) await app.secrets.set(tx, 'identity_provider', row.id, 'client_secret', b.clientSecret);
        if (before.type === 'oidc') discoveryCache.delete((before.config.issuer ?? '').replace(/\/+$/, ''));
        await c.audit(tx, 'identity.provider_update', { type: 'identity_provider', id: row.id }, { fields: Object.keys(changes), secretChanged: Boolean(b.clientSecret) });
        return present(row, await secretInfo(tx, app, row.id));
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/identity/providers/:id',
    auth: 'admin',
    permission: 'identity.providers.manage',
    sensitive: true,
    summary: 'Remove a provider; customers linked to it sign in another way',
    tags: ['Identity'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const row = await tx.maybe<ProviderRow>(sql`DELETE FROM identity_providers WHERE id = ${c.params.id} RETURNING *`);
        if (!row) throw notFound('Sign-in provider');
        await app.secrets.delete(tx, 'identity_provider', row.id);
        await c.audit(tx, 'identity.provider_delete', { type: 'identity_provider', id: row.id }, { key: row.key });
      });
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/identity/providers/:id/check',
    auth: 'admin',
    permission: 'identity.providers.view',
    summary: 'Check the configuration: resolves the provider’s endpoints (OpenID Connect discovery)',
    tags: ['Identity'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<ProviderRow>(sql`SELECT * FROM identity_providers WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Sign-in provider');
      if (row.type === 'oidc') discoveryCache.delete((row.config.issuer ?? '').replace(/\/+$/, ''));
      const endpoints = await endpointsFor(app, row);
      return { ok: true, hasSecret: Boolean(await secretInfo(app.db, app, row.id)), endpoints };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/users/:id/identities',
    auth: 'admin',
    permission: 'identity.providers.view',
    summary: 'Social sign-in identities linked to a customer',
    tags: ['Identity', 'Users'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const user = await getUser(app.db, c.params.id, c.orgScope(), { includeDeleted: true });
      return {
        data: await app.db.many(sql`
          SELECT i.id, p.key AS provider, p.name AS "providerName", i.email, i.email_verified AS "emailVerified", i.created_at AS "linkedAt", i.last_login_at AS "lastLoginAt"
          FROM user_identities i JOIN identity_providers p ON p.id = i.provider_id WHERE i.user_id = ${user.id} ORDER BY i.created_at
        `),
      };
    },
  });
}
