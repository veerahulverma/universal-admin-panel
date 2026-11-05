# @steward/node

Server-side SDK for the Steward integration API. Zero dependencies (uses the platform `fetch` and `node:crypto`); Node 18.17+.

```ts
import { Steward } from '@steward/node';

const steward = new Steward({
  apiKey: process.env.STEWARD_API_KEY!,      // sk_live_... — server only
  baseUrl: 'https://admin.example.com',
  webhookSecret: process.env.STEWARD_WEBHOOK_SECRET,
});
```

## Sync users and organizations

```ts
// On signup and profile changes (idempotent upsert by your own id)
const { user } = await steward.users.upsert({ externalId: myUser.id, email: myUser.email, name: myUser.name });

// If your app owns authentication, report logins for login history and suspicious-activity detection
await steward.users.recordLogin(user.id, { success: true, ip, userAgent, sessionId });

// Respect bans/suspensions made in the admin panel (cached for 30s)
const { allowed } = await steward.users.status(user.id);

const { organization } = await steward.organizations.upsert({ externalId: team.id, name: team.name, ownerUserId: user.id });
await steward.organizations.members.set(organization.id, otherUserId, 'admin');
```

## Entitlements and gating

```ts
const ent = await steward.entitlements.get({ userId });          // cached 30s; { fresh: true } to bypass
if (await steward.entitlements.has({ userId }, 'sso')) { /* ... */ }
const check = await steward.entitlements.check({ userId, feature: 'exports', quantity: 1 }); // server-side, always fresh
```

Framework-agnostic guards return a decision with an HTTP status (401 no subject, 403 inactive account, 402 not in plan, 429 quota used up):

```ts
import { gate, connectMiddleware, fastifyPreHandler, denyResponse } from '@steward/node';

const d = await gate(steward, { userId, feature: 'exports' });
if (!d.allowed) return res.status(d.status).json({ error: d.reason, message: d.message });

app.post('/export', connectMiddleware(steward, { feature: 'exports', getSubject: (req) => ({ userId: req.user?.stewardId }) }), handler); // Express/Connect
fastify.post('/export', { preHandler: fastifyPreHandler(steward, { feature: 'exports', getSubject: (r) => ({ userId: r.user.id }) }) }, handler);
const denied = await denyResponse(steward, { userId, feature: 'exports' }); if (denied) return denied; // Next.js / Fetch API
```

## Usage metering

Usage is always validated and recorded server-side; never trust quantities from browsers.

```ts
// Atomic check-and-record. allowed:false means nothing was recorded.
const r = await steward.usage.consume({ userId, meter: 'api_calls', quantity: 1, idempotencyKey: requestId });
if (!r.allowed) return res.status(429).json({ error: r.reason, resetsAt: r.resetsAt });

await steward.usage.record({ userId, meter: 'tokens', quantity: 1532, dimensions: { model: 'large' } }); // already happened

// Long-running work: hold quota, then commit the actual amount
const out = await steward.usage.withReservation({ userId, meter: 'render_minutes', quantity: 10 }, async () => {
  const video = await render();
  return { result: video, quantity: video.minutes };
});

await steward.usage.setGauge('projects', { userId, value: projectCount }); // gauges: seats, projects, storage
const meters = await steward.usage.summary({ userId });                   // usage, limits, forecasts
await steward.credits.consume({ userId, amount: 5 });                     // credit systems
```

An idempotency key is generated for every usage/credit write you do not key yourself, so automatic retries never double-charge.

## Billing

```ts
const session = await steward.checkout.create({ userId, priceId, successUrl, cancelUrl, couponCode });
if (session.url) redirect(session.url);           // hosted checkout (trials and free purchases complete immediately)

const subs = await steward.subscriptions.list({ userId });
await steward.subscriptions.change(subs[0].id, { priceId: annualPriceId });  // upgrades prorate; downgrades wait for period end
await steward.subscriptions.cancel(subs[0].id, { atPeriodEnd: true, reason: 'too expensive' });
const invoices = await steward.invoices.list({ userId });
const pdf = await steward.invoices.pdf(invoices[0].id);   // Uint8Array
await steward.billingProfile.update({ userId, address: { country: 'DE' }, taxId: 'DE123456789' });
```

## Browser sessions, API products, impersonation

```ts
const { token } = await steward.customerSessions.create({ userId });      // hand to @steward/js
const issued = await steward.customerKeys.issue({ userId, name: 'CI', scopes: ['read'], meterKey: 'api_calls' });
const v = await steward.customerKeys.verify(presentedKey, { ip });        // in your API gateway
const imp = await steward.impersonation.verify(tokenFromQueryString);     // show a banner; honour imp.readOnly
```

## Webhooks

```ts
app.post('/webhooks/steward', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = steward.webhooks.verify(req.body, req.headers['steward-signature']); // also refreshes cached access
    if (event.type === 'user.banned') endSessions(event.data.userId);
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);
  }
});
```

`verifyWebhook(rawBody, header, secretOrSecrets, { toleranceSeconds })` is also exported, and `createWebhookHandler({ secret, handlers: { 'user.*': fn } })` returns a framework-agnostic handler. Signatures use `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` with a 5-minute replay window. Pass several secrets while rotating.

## Errors and retries

API errors throw `StewardError` (`status`, `code`, `message`, `requestId`, `details`). Network failures throw `StewardConnectionError`. 429s are retried honouring `Retry-After`; 502/503/504 and network errors are retried only for idempotent calls. Configure with `maxRetries` and `timeoutMs`.

## Development

```bash
npm run typecheck -w @steward/node
npm test -w @steward/node     # unit tests with a mocked fetch
```
