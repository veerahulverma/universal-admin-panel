# Integrating Steward into a SaaS application

Steward runs next to your application. Your app keeps its database, its authentication and its
code; it talks to Steward through the server SDK (`@steward/node`), optionally the browser SDK
(`@steward/js`), and signed webhooks. It works the same for a brand-new product and for an
existing one: nothing has to be migrated up front.

The [example SaaS app](../apps/example-saas) implements every step below in a few hundred lines.

## 1. Install or deploy the admin platform

Follow [installation.md](installation.md): `npm run dev` locally, or Docker Compose with
PostgreSQL in production. Open `/setup` with the one-time setup token from the server log and
create the first super administrator, then turn on **Settings → Admin sign-in & sessions → Require 2FA**.

## 2. Configure the SaaS application connection

1. **Developers → API keys**: create a secret key for your backend with only the scopes it needs
   (for example `users:write`, `entitlements:read`, `usage:write`, `checkout:write`,
   `customer_sessions:write`). Restrict it to your servers' IPs if they are static. Keys carry a
   test or live label (`sk_test_…` / `sk_live_…`) so environments are easy to tell apart; data is
   not partitioned by key mode, so use a separate Steward instance for staging.
2. **Developers → Webhooks**: add an endpoint in your app (for example
   `https://app.example.com/webhooks/steward`), choose the events, and copy the signing secret.
3. If your front end will use the browser SDK, add its origin under
   **Settings → API & webhooks → Client origins**.

```ts
import { Steward } from '@steward/node';
export const steward = new Steward({ apiKey: process.env.STEWARD_API_KEY!, baseUrl: process.env.STEWARD_URL!, webhookSecret: process.env.STEWARD_WEBHOOK_SECRET });
```

```ts
app.post('/webhooks/steward', express.raw({ type: 'application/json' }), (req, res) => {
  const event = steward.webhooks.verify(req.body, req.headers['steward-signature']);  // throws on a bad signature or a timestamp older than 5 minutes
  if (event.type === 'user.banned' || event.type === 'user.sessions_revoked') endSessions(event.data.userId);
  res.sendStatus(200);
});
```

Deliveries are signed (`t=…,v1=HMAC-SHA256`), retried with backoff, logged and replayable in
**Developers → Webhooks**. **Developers → Event log** lists every event type.

## 3. Integrate authentication and user synchronization

Keep your login system. Upsert users with your own id as `externalId` on signup and profile
changes; the call is idempotent, so existing users can be backfilled with a one-off script at
your own pace.

```ts
const { user } = await steward.users.upsert({ externalId: me.id, email: me.email, name: me.name });
await steward.users.recordLogin(user.id, { success: true, ip, userAgent });   // login history + anomaly detection
const { allowed } = await steward.users.status(user.id);                       // honour suspensions and bans
```

- Teams and workspaces map to organizations (`steward.organizations.upsert`, `members.set`).
- Suspensions, bans and "sign out everywhere" made in the console reach your app as webhooks and
  through `users.status`.
- **Impersonation**: set **Settings → Customers → Impersonation URL** to a route in your app that
  calls `steward.impersonation.verify(token)`, shows a visible banner and blocks writes when the
  session is read-only.
- No authentication yet? The optional **identity** module provides registration, login, email
  verification and password reset (`/api/v1/identity/*`).

## 4. Register application-specific features and usage meters

In **Products & Plans → Features & meters**, create a meter for everything you want to count or limit
(API calls, projects, seats, storage, AI tokens, exports…) and features: boolean switches
(`sso`, `exports`) or quotas on a meter with a reset period and enforcement (hard, soft,
overage). Then use them from your backend:

```ts
if (!(await steward.entitlements.has({ userId }, 'exports'))) return res.status(402).end();

const r = await steward.usage.consume({ userId, meter: 'api_calls', quantity: 1, idempotencyKey: requestId });
if (!r.allowed) return res.status(429).json({ error: r.reason, resetsAt: r.resetsAt });
```

- Usage is checked and recorded atomically on the Steward server. Never accept quantities from a
  browser; compute them in your backend.
- Idempotency keys make retries safe: the same key never counts twice.
- Long operations reserve quota first (`usage.withReservation`) and commit the real amount.
- Gauges (`usage.setGauge`) track current totals such as seats or projects.
- Ready-made guards exist for Express/Connect, Fastify and Fetch-style handlers (`gate`,
  `connectMiddleware`, `fastifyPreHandler`, `denyResponse`).

## 5. Configure plans, permissions, and limits

- **Products & Plans → Plans & products**: plans with prices per interval and currency, trials, intro
  prices, per-seat pricing, add-ons, one-time products and credit packs; attach features and
  limits to each. Set the default plan for customers without a subscription in
  **Settings → Plans & entitlements**. Renaming a plan or changing a limit needs no code change.
- **Marketing → Coupons** for discounts.
- Per-customer exceptions live on the customer's **Plan & access** tab (users and organizations):
  grant a product without payment, or override one feature or limit, optionally between two dates
  (for example 10,000 extra API calls for launch week). Your app is notified through the
  `entitlements.updated` webhook.
- **Content & Access → Protected content**: protect URLs and folders of your app, or publish
  members-only pages, links and downloads, for a plan, a product or a user group (**User Management →
  User groups**), optionally released a number of days after access starts (drip). Your app asks
  before serving a protected route; paths nothing protects are allowed:

```ts
const decision = await steward.access.check({ userId, resource: req.path, ip: req.ip });
if (!decision.allowed) return res.status(403).render('locked', { opensAt: decision.availableAt });
```

- **System → Roles and Team**: give your staff the narrowest roles that work (billing,
  support, developer, marketing, analyst, or custom roles) and limit agency or reseller staff to
  their organizations.

## 6. Connect payment gateways and notification providers

- **Billing & Payments → Payment gateways**: add Stripe, PayPal or Razorpay (or a gateway plugin), enter
  the credentials (stored encrypted), copy the webhook URL into the provider's dashboard and use
  **Test connection**. The sandbox gateway lets you run the whole flow without a provider.
- **System → Settings → Email**: the admin, technical and outgoing addresses, the sender name, and the
  sending method (SMTP, Amazon SES, SendGrid, Postmark, Mailgun, Mailjet or Resend) with a test send;
  also log retention, a sending-rate throttle and copies of admin notifications. **Email → Email
  delivery** adds fallback providers in failover order; edit templates under **Email → Email templates**.
- Sell through Steward's hosted checkout:

```ts
const session = await steward.checkout.create({ userId, priceId, successUrl, cancelUrl });
res.redirect(session.url);
```

- **Push notifications**: browsers subscribe with `steward.push.subscribeBrowser(registration)` from
  `@steward/js` (your service worker shows the notification). For phones and apps, activate the **Push
  notifications** plugin and add OneSignal or Firebase credentials (see [plugins](plugins.md#push-notification-plugins)).
  Choose the automatic notifications (payment received, payment failed, upcoming renewal, trial ending,
  cancellation, usage alerts) in **System → Settings → Notifications**; send to everyone, a segment or a
  plan's customers under **Marketing → Push notifications**, and to one customer from their page.
- **Keep your existing billing instead**: grant products from your own billing events with
  `POST /api/v1/entitlements/grants` (scope `entitlements:write`). Entitlements, quotas and the
  console work the same while Steward's invoices and gateways stay unused.
- Self-service in your UI: your backend mints a short-lived customer session
  (`steward.customerSessions.create`) and the browser uses `@steward/js` for plans, usage meters,
  subscription changes, invoices and billing details.

## 7. Test the integration and activate production mode

1. Use a `sk_test_` key, the sandbox gateway and a test webhook endpoint. Sign up a user in your
   app and check it appears in **User Management → Users** with its login history.
2. Exhaust a quota and confirm your app returns the limit error; buy a plan through the sandbox
   checkout and confirm the entitlement change arrives (webhook + `entitlements.get`).
3. Suspend the user in the console and confirm your app blocks them; try an impersonation.
4. Watch **Developers → API logs** and **Webhooks → Deliveries** for errors.
5. Go live: create a `sk_live_` key, switch the payment gateway to live mode with live
   credentials, review the [security checklist](security.md#operator-checklist), and remove test
   endpoints and keys.

## Adapters instead of rewrites

| Your app already has… | Use |
| --- | --- |
| Authentication | User upsert + `recordLogin` + `status` checks (step 3) |
| A users table | `externalId` mapping; no data migration needed |
| Billing / a payment provider | Entitlement grants (step 6) or a gateway plugin |
| Its own feature flags | Read entitlements in your flag provider, or keep both during a transition |
| Its own email sending | Leave Steward's automatic emails off in **Settings → Email** |
| Members-only areas | Keep serving them from your app; call `POST /api/v1/access/check` (or `steward.access.check`) before each protected route |
| Its own terms-of-service checkbox | Record acceptance with `POST /api/v1/users/:id/agreements/accept` so the console shows who accepted which version |
