# API reference

Steward exposes four API surfaces. Each has a generated OpenAPI 3.1 document, and the admin
console's **Developers → API explorer** renders them with a try-it panel.

| Surface | Base path | Who calls it | Authentication | OpenAPI |
| --- | --- | --- | --- | --- |
| Integration | `/api/v1` | Your backend | `Authorization: Bearer sk_live_…` secret API key with scopes | `/api/openapi/v1` |
| Client | `/api/client` | Your web or mobile front end | `Authorization: Bearer cs_…` customer session minted by your backend; CORS allowlist | `/api/openapi/client` |
| Admin | `/api/admin` | The admin console and mobile app | Session cookie + `x-csrf-token` on writes (web), bearer session (mobile) | `/api/admin/openapi.json` (admins only) |
| Public | `/api/public`, `/pay`, `/r` | Browsers, payment and email providers | None, or signed tokens and provider signatures | `/api/openapi/public` |

SDKs: [`@steward/node`](../packages/sdk-node/README.md) for the integration API and
[`@steward/js`](../packages/sdk-js/README.md) for the client API.

## Conventions

**Requests and responses** are JSON. Money is an integer amount in minor units plus an ISO 4217
`currency` (`{"amount": 1999, "currency": "EUR"}` is €19.99). Timestamps are ISO 8601 in UTC. IDs
are prefixed strings (`usr_…`, `org_…`, `sub_…`, `inv_…`).

**Lists** take `page` (default 1) and `pageSize` (default 25, max 200) and return:

```json
{ "data": [ … ], "page": 1, "pageSize": 25, "total": 342 }
```

**Errors** use HTTP status codes and a stable machine-readable code:

```json
{ "error": { "code": "validation_error", "message": "Invalid request", "details": [{ "path": ["body", "email"], "message": "Invalid email" }], "requestId": "req-1a2b" } }
```

| Status | Typical codes |
| --- | --- |
| 400 / 422 | `validation_error`, `ssrf_blocked`, domain-specific codes |
| 401 | `unauthorized`, `invalid_credentials`, `session_missing`, `mfa_required` |
| 402 | entitlement checks (SDK guards) when a feature is not in the plan |
| 403 | `forbidden`, `module_disabled`, `reauth_required`, `ip_blocked` |
| 404 | `not_found` |
| 409 | `conflict` and state errors (`setup_complete`, `admin_exists`, …) |
| 429 | `rate_limited` (with `Retry-After`), `account_locked`, quota denials |

Quote `requestId` when reporting a problem; it is also returned in the `x-request-id` header and
appears in the server log and the API request log.

**Rate limits** apply per API key (configurable per key, default in **Settings → API &
webhooks**) and per IP on authentication endpoints. Integration API responses include
`x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`.

**Idempotency**: usage, credit and checkout writes accept an `idempotencyKey`; repeating a call
with the same key returns the original result instead of applying it twice. The Node SDK adds
keys automatically to writes you do not key yourself.

**Scopes** limit what a key can do (`users:write`, `entitlements:read`, `usage:write`,
`checkout:write`, `customer_sessions:write`, `impersonation:verify`, `access:read`, `health:read`,
`lists:read`, `lists:write`, …; `resource:*` and `*` are accepted). The full list, with descriptions, is shown when creating a key. Keys can also be
restricted to IP ranges and to one organization (tenant-scoped keys only see that tenant).

## Integration API at a glance

| Area | Endpoints |
| --- | --- |
| Users | `POST /users` (upsert by `externalId`), `GET/PATCH/DELETE /users/:id`, `GET /users/external/:externalId`, `/users/:id/status`, `/suspend`, `/sessions/revoke`, `/activity`, `POST /users/:id/login-events` (report a login from your own auth) |
| Organizations | `POST /organizations`, `GET/PATCH /organizations/:id`, members `PUT/DELETE /organizations/:id/members/:userId` |
| Entitlements | `GET /entitlements`, `POST /entitlements/check`, `POST /entitlements/grants` |
| Usage and credits | `POST /usage/consume`, `/usage/record`, `/usage/reserve`, `/usage/reservations/:id/commit` and `/release`, `PUT /usage/gauges/:meter`, `GET /usage`; `GET /credits`, `POST /credits/grant`, `/credits/consume` |
| Billing | `GET /plans`, `POST /checkout/sessions`, `GET /checkout/sessions/:id`, `POST /checkout/cart` (several products, one invoice), `POST /vouchers/redeem`, `GET /subscriptions`, `POST /subscriptions/:id/:action`, `GET /invoices`, `GET /invoices/:id/pdf`, `PUT /billing-profile` (EU VAT numbers are format-checked; no VIES lookup) |
| Content access | `POST /access/check` (a resource id, path or URL: `allowed`, a `reason` such as `no_access` or `not_yet_available`, and `availableAt` for drip content), `GET /access/resources` (every protected resource with its state for a user or organization) |
| Agreements | `GET /users/:id/agreements`, `POST /users/:id/agreements/accept` (record acceptance from your own screens, with IP and user agent) |
| Mailing lists | `GET /lists`, subscribe and unsubscribe users with optional consent evidence (double opt-in lists send a confirmation email) |
| Integration health | `GET /integration-health` (webhooks, API keys, gateways, email providers, plugins) |
| Notifications and push | `POST /notifications` (notification center plus push to the customer's browsers and apps; `push: false` for the center only), `GET /notifications`, `POST /users/:id/push-devices` and `/push-devices/remove` (app device tokens for a push provider such as Firebase) |
| Sessions and keys | `POST /customer-sessions` (for the browser SDK), `POST /customer-keys` and `/customer-keys/verify` (API products you sell to your customers), `POST /impersonation/verify` |
| Events and webhooks | `POST /events` (custom activity), `GET /events`, `GET/POST /webhook-endpoints` |
| Other modules | `/referrals` (affiliates; `subId` for sub-ID tracking), `/support/tickets`, `/notifications`, `/identity/*` (built-in auth, social sign-in) |

`GET /api/v1/ping` checks a key and returns its id, mode, scopes, organization scope and the API version.

## Client and public endpoints added by optional modules

| Area | Client API (`/api/client`, customer session) | Public (`/api/public`) |
| --- | --- | --- |
| Members-only content | `GET /content`, `GET /content/:id` (sanitized page HTML, link or files), `POST /content/:id/files/:fileId/link` (signed, short-lived download URL) | `GET /downloads/:token`: access and the download limit are checked again; altered links answer 404, expired 410, used-up limits 429 with `Retry-After` |
| Carts and vouchers | `POST /cart/checkout`, `POST /vouchers/redeem` | |
| Push notifications | `POST /push/subscriptions` and `/push/subscriptions/remove` (browser web push), `POST /push/devices` and `/push/devices/remove` (app device tokens) | `GET /push/vapid-public-key` |
| Agreements | `GET /agreements`, `POST /agreements/:versionId/accept` | `GET /agreements/:key` (current version) |
| Signup forms | | `GET /signup-forms/:key` |
| Knowledge base | `GET /kb/...` (categories, articles, search, votes; product-restricted articles for customers who hold the product) | `GET /kb/...` (public articles only; restricted and draft ones answer 404) |
| Mailing lists | `GET /lists`, `PUT /lists/:list` (subscribe or leave) | `/lists/confirm/*` (double opt-in confirmation page) |
| Affiliates | `GET /affiliate/sub-ids`, `GET /affiliate/materials`, `GET /affiliate/materials/:id/download` | `GET /affiliate-assets/:id` (banner images) |

## Webhooks

Each delivery is a `POST` with a JSON body
`{ "id": "evt_…", "type": "subscription.updated", "created": "…", "apiVersion": "…", "data": { … }, "userId": "usr_…", "orgId": null }` and a
`Steward-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` header.
Verify the signature over the raw body with a constant-time comparison and reject timestamps
older than five minutes (`steward.webhooks.verify` does both). Respond with any 2xx within the
timeout; other responses are retried with exponential backoff, and endpoints that keep failing are
disabled automatically after the configured number of consecutive failures. Deliveries can be
inspected and replayed in the console; rotate a secret by adding the new one to your verifier
before switching.

Event types include `user.*` (created, updated, suspended, banned, reactivated, deleted, restored,
anonymized, email_verified, sessions_revoked, impersonation_started/ended), `organization.*`
(including member and ownership changes), `subscription.*` (created, updated, renewed,
trial_will_end, past_due, paused, resumed, canceled), `checkout.*`, `order.paid`, `invoice.*`,
`payment.succeeded`, `payment.failed`, `refund.succeeded`, `dispute.*`, `usage.limit_warning`,
`usage.limit_reached`, `credits.granted`, `entitlements.updated`, `ticket.*`, `affiliate.*`,
`referral.*`, `commission.*`, `campaign.*`, `access_resource.*`, `access_file.*`, `user_group.*`,
`voucher.redeemed`, `payment_method.expiring`, `agreement.*`, `user.merged`,
`user.archived`, `ticket.assigned`, `kb.article_*`, `email.sequence_*`, `list.member_*` and `integration.*`; `GET /api/admin/event-types` (or
**Developers → Event log**) lists them all with descriptions.
