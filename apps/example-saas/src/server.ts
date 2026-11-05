/**
 * Example SaaS app integrated with Steward.
 *
 * It owns its own users and authentication (like most existing SaaS apps) and
 * uses Steward for everything else:
 *   - signup/login  -> steward.users.upsert + steward.users.recordLogin
 *   - access checks -> gate() (account status + plan feature)
 *   - metering      -> steward.usage.consume with an idempotency key
 *   - upgrades      -> steward.checkout.create (hosted checkout)
 *   - frontend      -> short-lived customer session for the browser SDK
 *   - webhooks      -> verified with the signing secret; bans/revocations end local sessions
 *   - impersonation -> one-time admin token verified server-side, visible banner, read-only
 *
 * Storage is in memory to keep the example dependency-free.
 */
import http from 'node:http';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { Steward, StewardError, createWebhookHandler, gate, type WebhookEvent } from '@steward/node';

const config = {
  port: Number(process.env.PORT ?? 3000),
  appUrl: (process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ''),
  stewardUrl: process.env.STEWARD_URL ?? 'http://localhost:4000',
  apiKey: process.env.STEWARD_API_KEY ?? '',
  webhookSecret: process.env.STEWARD_WEBHOOK_SECRET ?? '',
  /** Feature gated by the "Generate report" button. */
  feature: process.env.DEMO_FEATURE ?? 'sso',
  /** Meter consumed by the "Call the API" button. */
  meter: process.env.DEMO_METER ?? 'api_calls',
  /** Price used by the upgrade button. */
  upgradePriceId: process.env.DEMO_PRICE_ID ?? '',
};

if (!config.apiKey) {
  console.error('Set STEWARD_API_KEY (and STEWARD_URL, STEWARD_WEBHOOK_SECRET). See apps/example-saas/README.md.');
  process.exit(1);
}

const steward = new Steward({ apiKey: config.apiKey, baseUrl: config.stewardUrl, webhookSecret: config.webhookSecret || undefined });

// ---- Your app's own data (stand-in for a database) ---------------------------------------------

interface AppUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** Steward's id for this user (we also send our id as externalId). */
  stewardId: string;
}

interface Session {
  userId: string;
  impersonation?: { adminName: string; readOnly: boolean; expiresAt: string; reason: string };
}

const users = new Map<string, AppUser>();
const userIdByEmail = new Map<string, string>();
const sessions = new Map<string, Session>();

function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(`${salt.toString('hex')}:${key.toString('hex')}`))),
  );
}

function checkPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  return new Promise((resolve, reject) =>
    scrypt(password, Buffer.from(saltHex, 'hex'), 32, (err, key) => (err ? reject(err) : resolve(timingSafeEqual(key, Buffer.from(keyHex, 'hex'))))),
  );
}

function endSessionsFor(stewardUserId: string, why: string): void {
  for (const [sid, s] of sessions) {
    if (users.get(s.userId)?.stewardId === stewardUserId) {
      sessions.delete(sid);
      console.log(`[auth] ended session for ${stewardUserId}: ${why}`);
    }
  }
}

// ---- HTTP helpers ----------------------------------------------------------------------

const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((p) => p.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
}

function send(res: http.ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');
const redirect = (res: http.ServerResponse, location: string, headers: Record<string, string> = {}) => send(res, 303, '', 'text/plain', { location, ...headers });

function startSession(res: http.ServerResponse | null, session: Session): Record<string, string> {
  const sid = randomBytes(24).toString('base64url');
  sessions.set(sid, session);
  const cookie = `example_sid=${sid}; HttpOnly; SameSite=Lax; Path=/`;
  res?.setHeader('set-cookie', cookie);
  return { 'set-cookie': cookie };
}

function current(req: http.IncomingMessage): { sid: string; session: Session; user: AppUser } | null {
  const sid = cookies(req).example_sid;
  const session = sid ? sessions.get(sid) : undefined;
  const user = session ? users.get(session.userId) : undefined;
  if (!sid || !session || !user) return null;
  if (session.impersonation && new Date(session.impersonation.expiresAt) < new Date()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, session, user };
}

// ---- Pages -------------------------------------------------------------------------------

const layout = (body: string, banner = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Example SaaS</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;color:#16181d}
.card{border:1px solid #e3e6eb;border-radius:10px;padding:16px;margin:12px 0}
.banner{background:#fef3c7;border:1px solid #f59e0b;color:#78350f;padding:10px 14px;border-radius:8px;font-weight:600}
button,input{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #cfd4dc}button{cursor:pointer;background:#4f46e5;color:#fff;border-color:#4f46e5}
pre{background:#f6f7f9;padding:10px;border-radius:6px;overflow:auto}.muted{color:#5d6470}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
</style></head><body>${banner}<h1>Example SaaS</h1>${body}</body></html>`;

async function homePage(req: http.IncomingMessage): Promise<string> {
  const me = current(req);
  if (!me) {
    return layout(`
      <div class="card"><h2>Sign up</h2><form method="post" action="/signup" class="row">
        <input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required>
        <input name="password" type="password" placeholder="Password (8+ chars)" minlength="8" required><button>Create account</button></form></div>
      <div class="card"><h2>Sign in</h2><form method="post" action="/login" class="row">
        <input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Password" required><button>Sign in</button></form></div>`);
  }
  const subject = { userId: me.user.stewardId };
  const [ent, usage] = await Promise.all([steward.entitlements.get(subject, { fresh: true }), steward.usage.summary(subject)]);
  const imp = me.session.impersonation;
  const banner = imp
    ? `<div class="banner">You are being viewed by ${escape(imp.adminName)} (support)${imp.readOnly ? ' in read-only mode' : ''}. Reason: ${escape(imp.reason)}. <form method="post" action="/logout" style="display:inline"><button>End</button></form></div>`
    : '';
  const meters = usage
    .filter((m) => m.feature)
    .map((m) => `<li>${escape(m.name)}: ${m.used} / ${m.limit === null ? '∞' : m.limit} ${escape(m.unit)}</li>`)
    .join('');
  return layout(
    `<p>Signed in as <strong>${escape(me.user.email)}</strong> · Plan: <strong>${escape(ent.plans.map((p) => p.name).join(', ') || 'none')}</strong>
     <form method="post" action="/logout" style="display:inline"><button>Sign out</button></form></p>
     <div class="card"><h2>Feature gate</h2><p class="muted">Requires <code>${escape(config.feature)}</code> in the plan.</p>
       <button onclick="act('/api/report')">Generate report</button></div>
     <div class="card"><h2>Metered API</h2><p class="muted">Each click consumes 1 <code>${escape(config.meter)}</code> (idempotent per click).</p>
       <button onclick="act('/api/call', crypto.randomUUID())">Call the API</button><ul>${meters}</ul></div>
     <div class="card"><h2>Upgrade</h2>${config.upgradePriceId ? '<form method="post" action="/api/upgrade"><button>Upgrade with hosted checkout</button></form>' : '<p class="muted">Set DEMO_PRICE_ID to enable.</p>'}</div>
     <div class="card"><h2>Browser SDK session</h2><p class="muted">Mint a customer session and read entitlements straight from Steward in the browser.</p>
       <button onclick="browserCall()">Load from the browser</button></div>
     <pre id="out">Results appear here.</pre>
     <script>
       const out = document.getElementById('out');
       async function act(path, key) {
         const res = await fetch(path, { method: 'POST', headers: key ? { 'idempotency-key': key } : {} });
         out.textContent = res.status + ' ' + JSON.stringify(await res.json(), null, 2);
       }
       async function browserCall() {
         const s = await (await fetch('/api/steward-session')).json();
         const res = await fetch(s.baseUrl + '/api/client/entitlements', { headers: { authorization: 'Bearer ' + s.token } });
         out.textContent = res.status + ' ' + JSON.stringify(await res.json(), null, 2);
       }
     </script>`,
    banner,
  );
}

// ---- Webhooks -----------------------------------------------------------------------------

const handleWebhook = createWebhookHandler({
  secret: config.webhookSecret || 'unset',
  onEvent: (e: WebhookEvent) => {
    console.log(`[webhook] ${e.type} ${e.id}`);
    // Access changed: drop cached entitlements/status for that subject immediately.
    steward.invalidate({ userId: e.userId, orgId: e.orgId });
  },
  handlers: {
    'user.banned': (e) => endSessionsFor(String(e.data.userId), 'banned'),
    'user.suspended': (e) => endSessionsFor(String(e.data.userId), 'suspended'),
    'user.deleted': (e) => endSessionsFor(String(e.data.userId), 'deleted'),
    'user.sessions_revoked': (e) => endSessionsFor(String(e.data.userId), 'sessions revoked by an admin'),
    'user.password_reset_requested': (e) => console.log(`[webhook] send a password reset email to ${e.data.email}`),
    'invoice.payment_failed': (e) => console.log(`[webhook] payment failed for invoice ${e.data.number}; nudge the customer to update their card`),
  },
});

// ---- Router ------------------------------------------------------------------------------

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', config.appUrl);
  const method = req.method ?? 'GET';

  if (method === 'POST' && url.pathname === '/webhooks/steward') {
    if (!config.webhookSecret) return sendJson(res, 503, { error: 'STEWARD_WEBHOOK_SECRET is not configured' });
    // Verify against the raw body exactly as received.
    const result = await handleWebhook(await readBody(req), req.headers['steward-signature']);
    return sendJson(res, result.status, result.body);
  }

  if (method === 'GET' && url.pathname === '/') return send(res, 200, await homePage(req));

  if (method === 'POST' && url.pathname === '/signup') {
    const form = new URLSearchParams(await readBody(req));
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    if (!email || password.length < 8 || userIdByEmail.has(email)) return send(res, 400, layout('<p>Invalid signup or email already registered. <a href="/">Back</a></p>'));
    const id = `app_${randomUUID()}`;
    // Register the user in Steward with our id as the external id.
    const { user } = await steward.users.upsert({ externalId: id, email, name: String(form.get('name') ?? ''), registrationSource: 'example-app' });
    users.set(id, { id, email, name: String(form.get('name') ?? ''), passwordHash: await hashPassword(password), stewardId: user.id });
    userIdByEmail.set(email, id);
    await steward.users.recordLogin(user.id, { success: true, ip: req.socket.remoteAddress ?? '0.0.0.0', userAgent: String(req.headers['user-agent'] ?? ''), method: 'signup' });
    return redirect(res, '/', startSession(null, { userId: id }));
  }

  if (method === 'POST' && url.pathname === '/login') {
    const form = new URLSearchParams(await readBody(req));
    const user = users.get(userIdByEmail.get(String(form.get('email') ?? '').trim().toLowerCase()) ?? '');
    const ok = user ? await checkPassword(String(form.get('password') ?? ''), user.passwordHash) : false;
    const ip = req.socket.remoteAddress ?? '0.0.0.0';
    const userAgent = String(req.headers['user-agent'] ?? '');
    if (user) await steward.users.recordLogin(user.stewardId, { success: ok, ip, userAgent, failureReason: ok ? undefined : 'bad_password' });
    if (!user || !ok) return send(res, 401, layout('<p>Wrong email or password. <a href="/">Back</a></p>'));
    // Respect bans and suspensions made in the admin panel.
    const status = await steward.users.status(user.stewardId, { fresh: true });
    if (!status.allowed) return send(res, 403, layout(`<p>Your account is ${escape(status.status)}. <a href="/">Back</a></p>`));
    return redirect(res, '/', startSession(null, { userId: user.id }));
  }

  if (method === 'POST' && url.pathname === '/logout') {
    const me = current(req);
    if (me) sessions.delete(me.sid);
    return redirect(res, '/', { 'set-cookie': 'example_sid=; Max-Age=0; Path=/' });
  }

  // One-time impersonation token from the Steward admin panel ("Impersonate" button).
  if (method === 'GET' && url.pathname === '/impersonate') {
    try {
      const imp = await steward.impersonation.verify(String(url.searchParams.get('token') ?? ''));
      const local = [...users.values()].find((u) => u.stewardId === imp.userId);
      if (!local) return send(res, 404, layout('<p>That user does not exist in this app.</p>'));
      const headers = startSession(null, {
        userId: local.id,
        impersonation: { adminName: imp.admin.name ?? imp.admin.email ?? 'An administrator', readOnly: imp.readOnly, expiresAt: imp.expiresAt, reason: imp.reason },
      });
      return redirect(res, '/', headers);
    } catch (err) {
      return send(res, 403, layout(`<p>Impersonation link invalid or expired (${escape((err as Error).message)}).</p>`));
    }
  }

  // ---- Authenticated API -------------------------------------------------------------
  const me = current(req);
  if (!me) return sendJson(res, 401, { error: 'Sign in first' });
  if (me.session.impersonation?.readOnly && method !== 'GET') return sendJson(res, 403, { error: 'Read-only impersonation: changes are blocked' });
  const subject = { userId: me.user.stewardId };

  if (method === 'POST' && url.pathname === '/api/report') {
    const decision = await gate(steward, { ...subject, feature: config.feature });
    if (!decision.allowed) return sendJson(res, decision.status, { error: decision.reason, message: decision.message });
    return sendJson(res, 200, { report: `Report generated at ${new Date().toISOString()}` });
  }

  if (method === 'POST' && url.pathname === '/api/call') {
    const status = await steward.users.status(me.user.stewardId);
    if (!status.allowed) return sendJson(res, 403, { error: 'account_inactive' });
    // The idempotency key makes retries of the same click count once.
    const key = String(req.headers['idempotency-key'] ?? randomUUID());
    const usage = await steward.usage.consume({ ...subject, meter: config.meter, idempotencyKey: `click:${me.user.id}:${key}` });
    if (!usage.allowed) return sendJson(res, 429, { error: usage.reason, used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt });
    return sendJson(res, 200, { ok: true, used: usage.used, remaining: usage.remaining, duplicate: Boolean(usage.duplicate), warning: usage.warning ?? null });
  }

  if (method === 'POST' && url.pathname === '/api/upgrade') {
    if (!config.upgradePriceId) return sendJson(res, 400, { error: 'Set DEMO_PRICE_ID' });
    const session = await steward.checkout.create({ ...subject, priceId: config.upgradePriceId, successUrl: `${config.appUrl}/?upgraded=1`, cancelUrl: `${config.appUrl}/?canceled=1` });
    return redirect(res, session.url ?? `${config.appUrl}/?upgraded=1`);
  }

  // Short-lived token for the browser SDK; never expose the secret API key.
  if (method === 'GET' && url.pathname === '/api/steward-session') {
    const session = await steward.customerSessions.create({ userId: me.user.stewardId, ttlMinutes: 30 });
    return sendJson(res, 200, { token: session.token, expiresAt: session.expiresAt, baseUrl: config.stewardUrl });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof StewardError && err.status >= 400 && err.status < 500 ? 502 : 500;
    console.error('[error]', err);
    if (!res.headersSent) sendJson(res, status, { error: err instanceof StewardError ? err.code : 'internal_error', message: (err as Error).message });
  });
});

server.listen(config.port, () => console.log(`Example SaaS on ${config.appUrl} (Steward: ${config.stewardUrl})`));
