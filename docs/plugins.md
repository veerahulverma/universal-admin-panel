# Plugins

Plugins add features without touching Steward's code: react to events, add HTTP endpoints and
admin pages, run scheduled jobs, extend entitlements or dashboards, and add payment gateways.
Types and a test harness live in [`@steward/plugin-sdk`](../packages/plugin-sdk); three
reference plugins and the Paddle, PayU and Cashfree gateway plugins are in [`plugins/`](../plugins).

## Anatomy

```
my-plugin/
  package.json     # name/version for npm pack
  plugin.json      # the manifest
  index.js         # ES module exporting activate(ctx) and optionally deactivate()
```

```json
{
  "id": "slack-notifications",
  "name": "Slack notifications",
  "version": "1.2.0",
  "engine": ">=0.1.0 <2.0.0",
  "type": "integration",
  "permissions": ["settings", "secrets", "events:subscription.*", "http:hooks.slack.com"],
  "settingsSchema": { "type": "object", "properties": { "channel": { "type": "string", "title": "Channel" } } },
  "secrets": [{ "key": "webhookUrl", "label": "Incoming webhook URL", "required": true }],
  "adminPages": [{ "id": "overview", "title": "Slack", "path": "/page" }]
}
```

```js
export async function activate(ctx) {
  await ctx.events.on('subscription.created', async (event) => {
    const url = await ctx.secrets.get('webhookUrl');
    await ctx.http.fetch(url, { method: 'POST', body: { text: `New subscription for ${event.data.userId}` } });
  });
}
```

`settingsSchema` is JSON Schema; the admin console renders it as a form automatically. Secrets
are entered in a write-only form and stored encrypted.

## Permissions

Every capability must be declared and is shown to the administrator, who approves it before the
plugin is enabled. A plugin that asks for more on an update needs approval again.

| Permission | Grants |
| --- | --- |
| `settings` | `ctx.settings.get()` |
| `secrets` | `ctx.secrets.get(key)` for the plugin's own secrets |
| `kv` | Small JSON key-value storage (64 KB per value, 1000 keys) |
| `users:read` | `ctx.users.get / list` (read-only) |
| `http:<host>` | `ctx.http.fetch` to that host (`http:*.example.com` for subdomains); HTTPS only, private networks blocked |
| `events:<pattern>` | `ctx.events.on(pattern, handler)`; handlers run as background jobs with retries |
| `hooks:<name>` | Filters: `entitlements.resolve`, `admin.nav`, `reports.dashboard.kpis`, `system.health`, `marketing.list_providers` (report a newsletter service you keep in sync through the `list.member_subscribed` / `list.member_unsubscribed` events) (2 s budget, side-effect free) |
| `routes` | HTTP endpoints at `/api/plugins/<id>/<path>`, public or admin-only |
| `jobs` | `ctx.jobs.schedule(name, seconds, fn)` (minimum 60 s) |
| `gateway` | `ctx.gateways.register(adapter)` — a payment gateway (see below) |
| `push` | `ctx.push.register(provider)` — a push notification provider (see below) |

## Isolation

- **Bundled plugins** (shipped in `plugins/`) are trusted code and run in the server process,
  still only through `ctx`.
- **Uploaded and marketplace plugins** run in a separate Node.js process started with Node's
  permission model: read access to the plugin's own folder only, no filesystem writes, no child
  processes or worker threads, a 128 MB heap, and a minimal environment (no server secrets).
  Network modules (`net`, `http`, `https`, `tls`, `dns`, `dgram`, …) are refused at module
  resolution and `fetch` is routed through the host, which enforces `http:<host>` grants and
  SSRF rules. All other access goes through `ctx` over IPC, checked against the granted
  permissions.
- Node's permission model does not restrict network sockets by itself; the module and `fetch`
  interception above is defense in depth. For untrusted third-party plugins also restrict the
  server's outbound traffic at the network layer (egress firewall or proxy allowlist).
- A **circuit breaker** disables a plugin after 10 failures within 5 minutes and notifies
  administrators; the error is shown in **Integrations → Plugins**.

## Admin pages

`adminPages` entries appear in the navigation. The page is served by one of the plugin's admin
routes and displayed in a sandboxed iframe, so plugin HTML never runs inside the console itself.

## Payment gateway plugins

Implement the `GatewayAdapter` interface from the SDK (`createCheckout`, `parseWebhook`, and
optionally `chargeSaved`, `refund`, `handleReturn`, `testConnection`), declare capabilities
(checkout, saved methods, off-session charges, refunds, partial refunds, webhooks, currencies,
payment methods) and secret fields, then register it with `ctx.gateways.register(adapter)`.
Steward's billing engine stays the source of truth for invoices and subscriptions; the adapter
only moves money and normalizes provider events. See
[`plugins/gateway-mockpay`](../plugins/gateway-mockpay) for a complete example including signed
webhooks.

### Paddle, PayU and Cashfree

Three provider plugins ship as bundled plugins. Activate one in **Integrations → Plugins**, add it under
**Billing & Payments → Payment gateways** in test or live mode, and point the provider's webhooks at the webhook
URL shown on the gateway page. Credentials are stored encrypted and are write-only. None of them saves
payment methods or charges off-session, so renewals paid through them fall back to emailed invoices
with a payment link.

| | Paddle (`gateway-paddle`) | PayU India (`gateway-payu`) | Cashfree (`gateway-cashfree`) |
| --- | --- | --- | --- |
| Checkout | One-off Paddle Billing transaction on Paddle Checkout | PayU Hosted Checkout (`_payment` form) | Cashfree Payment Link |
| Currencies | The 33 Paddle currencies | INR | INR; add others to the gateway once Cashfree enables international payments |
| Refunds | Full and partial, as refund adjustments | Full and partial | Full and partial |
| Chargebacks | From chargeback adjustments; a reversal closes the dispute as won | Not processed | Created and closed |
| Credentials | API key, webhook secret key | Merchant key, merchant salt | App ID, secret key |
| Webhook check | `Paddle-Signature` (HMAC-SHA256 of `ts:body`, 5-minute window) | PayU's reverse SHA-512 hash | `x-webhook-signature` (HMAC-SHA256 of timestamp + body, keyed with the secret key) |

**Paddle.** Paddle is the merchant of record: Steward sends a tax-inclusive, quantity-locked price
and Paddle takes its tax out of that amount. Customers pay on the account's default payment link
(Paddle → Checkout → Checkout settings), a page on an approved domain that loads Paddle.js v2 and
calls `Paddle.Initialize` with a client-side token. Paddle.js opens the checkout from the `_ptxn`
parameter, and that page's `successUrl` decides where customers go afterwards. Paddle's hosted
checkout is meant for mobile apps and needs Paddle's approval, so the plugin does not use it. The API
key needs `transaction.write` and `adjustment.write`; **Test connection** reports missing
permissions. Subscribe the notification destination to `transaction.completed`,
`transaction.payment_failed`, `adjustment.created` and `adjustment.updated`. A refund that Paddle
does not approve automatically stays pending until `adjustment.updated` reports the outcome.

**PayU.** PayU requires the customer's mobile number and Steward does not store one, so checkout
opens a one-field page served by the plugin (`/api/plugins/gateway-payu/pay`) that posts the
hash-signed form to PayU. The form travels encrypted in that link, so nothing is stored per checkout.
PayU posts the result back to the plugin, which sends the customer on to Steward, where the payment
is confirmed with PayU's Verify Payment API before anything is fulfilled. In the PayU dashboard
(**Developers → Webhooks**) create webhooks for successful and failed payments. Refund callbacks are
unsigned, so each refund request asks PayU to notify the webhook URL and the plugin then asks PayU
for the refund's status. Dispute notifications are ignored because PayU signs them only on request.
The newer v2 REST API, dual salt-v2 hashes, multi-currency pricing and standing instructions are not
used.

**Cashfree.** Checkout uses Payment Links, so neither Cashfree's JS SDK nor domain whitelisting is
needed. Cashfree requires a customer phone number and Steward does not collect one, so the plugin
sends the placeholder `9999999999` (Cashfree's API reference allows dummy customer details) and turns
the link's SMS and e-mail notifications off. When the customer returns, the plugin asks Cashfree which
order on the link was paid. In **Payment Gateway → Developers → Webhooks**, add an endpoint with
webhook version `2025-01-01` and subscribe to payment success, failure and user-dropped, refund
status and dispute events. The plugin calls API version `2025-01-01`.

These plugins are tested only against mocked HTTP responses: each has a `node --test` suite that
`npm test` runs, built on `createMockContext` with scripted provider responses. None has been run
against a Paddle, PayU or Cashfree sandbox or live account, so make a test-mode payment, refund and
webhook delivery before going live.

## Push notification plugins

Steward decides who receives a notification (one customer from their page, a bulk send under
**Marketing → Push notifications**, or an automatic alert chosen in **Settings → Notifications**),
stores it in the customer's notification center and records every delivery. Browser web push is built
in. A push plugin adds delivery to customers' phones and apps by registering a provider:

```js
export async function activate(ctx) {
  await ctx.push.register({
    key: 'acme-push',
    name: 'Acme Push',
    targets: 'users', // or 'devices' when your app registers device tokens with Steward
    async status() {
      return { configured: Boolean(await ctx.secrets.get('api_key')), message: 'Add your API key' };
    },
    async send(message) {
      // message: { notificationId, type, title, body, link, severity, recipients: [{ userId, externalId, devices }] }
      return { results: message.recipients.map((r) => ({ userId: r.userId, status: 'sent' })) };
    },
  });
}
```

`status()` is checked at most once a minute; Steward only uses providers that report themselves
configured. Return `skipped` for a customer with nothing to deliver to, `failed` for errors a retry
will not fix, and `invalidDeviceIds` for device tokens the provider rejects (Steward removes them).
Throw for rate limits and outages: the delivery is retried with backoff.

### Push notifications (bundled)

The **Push notifications** plugin delivers through OneSignal, Firebase Cloud Messaging or both.
Activate it in **Integrations → Plugins**, then:

- **OneSignal**: set the App ID in the plugin settings and the REST API key in its credentials. Your
  app calls `OneSignal.login(id)` with the Steward user id, or with your own user id if you choose
  that in the settings (the customer's external id in Steward).
- **Firebase**: paste the service account key file (JSON) into the credentials. Your app registers each
  install's FCM token with `steward.push.registerDevice({ provider: 'firebase', token, platform })`
  (`@steward/js`) or `POST /api/v1/users/:id/push-devices` from your backend. Invalid tokens are removed
  automatically.

Like the gateway plugins, it is tested against mocked provider responses only (`node --test`); send a
test notification to your own account before relying on it.

## Testing

```js
import { createMockContext } from '@steward/plugin-sdk';
import { activate } from '../index.js';

const ctx = createMockContext({ permissions: ['kv', 'events:user.created'] });
await activate(ctx);
await ctx.emit('user.created', { email: 'a@example.com' });
assert.equal(await ctx.kv.get('signups'), 1);
```

The mock context enforces permissions the same way the host does, so a missing permission fails
in tests, not in production. To test a gateway adapter, pass scripted responses as `fetch` and give
the gateway context a `fetch` that goes through `ctx.http.fetch`, as the host does; the Paddle, PayU
and Cashfree plugins' `test` folders show the pattern.

## Packaging, installing and updating

1. `npm pack` produces `my-plugin-1.2.0.tgz`.
2. **Integrations → Plugins → Upload** installs it (or install from the marketplace). The archive's
   SHA-256 is recorded; marketplace packages must match the published checksum and, when
   `MARKETPLACE_PUBLIC_KEY` is set, carry a valid Ed25519 signature.
3. Review the requested permissions and enable it.

Every installed version is kept: roll back from the plugin page if an update misbehaves.
Dependencies on other plugins (`"dependencies": {"other-plugin": "^1.0.0"}`) and the `engine`
range are checked before activation. All installs, updates, permission approvals, setting
changes and rollbacks are audited.
