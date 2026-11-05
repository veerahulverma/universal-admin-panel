# Architecture

Steward is a **modular monolith**: one deployable Node.js service (API, admin UI, background
worker) over one PostgreSQL database, split into modules with explicit contracts. It runs as a
standalone admin platform next to an existing SaaS product and integrates with it through APIs,
SDKs, webhooks and adapters instead of replacing its code or database.

```
                ┌────────────────────────────── Steward ──────────────────────────────┐
Admin web UI ──►│  /api/admin  (cookie session + CSRF, RBAC, re-auth, approvals)       │
Mobile app ────►│  /api/admin  (bearer session token)                                  │
Your backend ──►│  /api/v1     (secret API key, scopes, rate limits, idempotency)      │──► PostgreSQL
Your frontend ─►│  /api/client (short-lived customer session token, CORS allowlist)   │
Gateways ──────►│  /api/public (signed webhooks, hosted checkout /pay, theme, branding)│
                │                                                                       │
                │  modules ─ hooks/filters ─ events (outbox) ─ jobs ─ settings ─ audit  │
                └──────────────┬──────────────────────────────┬────────────────────────┘
                               │ signed webhooks              │ sandboxed plugins
                               ▼                              ▼
                        your application              child processes (node --permission)
```

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/server` | Fastify 5 + TypeScript API, worker and CLI. `src/core` is the engine, `src/modules/*` the features. |
| `apps/admin` | React 19 + Vite + Tailwind 4 admin console (responsive, installable PWA, dark mode). |
| `apps/mobile` | Expo / React Native admin app for iOS and Android (native screens, not a web view). |
| `apps/example-saas` | A small existing-style SaaS app integrated through `@steward/node`. |
| `packages/sdk-node` | `@steward/node`: server SDK (users, entitlements, usage, billing, carts and vouchers, content access checks, agreements, integration health, webhooks, guards). |
| `packages/sdk-js` | `@steward/js`: browser SDK for self-service features with customer session tokens (plans, usage, subscriptions, invoices, carts, vouchers, members-only content and downloads, agreements). |
| `packages/plugin-sdk` | Types and a mock context for building and unit-testing plugins. |
| `plugins/*` | Bundled reference plugins (hello world, Slack notifications, a payment gateway). |

## The core engine (`apps/server/src/core`)

| Piece | Responsibility |
| --- | --- |
| `db.ts`, `sql.ts` | PostgreSQL via `pg` (production) or PGlite (development/tests). A tagged-template SQL builder that only produces parameterized queries; transactions; guards against using the root pool inside a transaction. |
| `migrate.ts` | Per-module, ordered, checksummed migrations applied once at startup inside transactions. |
| `modules.ts` | Module registry: dependencies, enable/disable at runtime, required modules, navigation and permissions contributed by each module. |
| `http.ts` | Route registration with zod validation, auth mode (`admin`, `api_key`, `client`, `public`), permission, scopes, rate limit, sensitive (re-auth) flag, OpenAPI metadata, request logging. |
| `permissions.ts` | Permission registry (`module.resource.action`) with wildcards. |
| `audit.ts` | Append-only, hash-chained audit log (a database trigger rejects updates and deletes). |
| `events.ts` | Domain events written in the same transaction as the change (transactional outbox) and fanned out to handlers, webhooks and plugins as jobs. |
| `jobs.ts` | PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`), retries with backoff, dead-letter state, scheduled tasks. No Redis required. |
| `ratelimit.ts` | Fixed-window rate limiter stored in PostgreSQL, shared by every instance. |
| `settings.ts` | Typed settings sections (zod schemas) with global and per-organization overrides, cached and refreshed. |
| `secrets.ts`, `crypto.ts` | AES-256-GCM encryption with additional authenticated data and key rotation; scrypt password hashing; HMAC helpers. |
| `hooks.ts` | Typed filters and actions (`admin.nav`, `entitlements.resolve`, `customers.user.profile`, `reports.dashboard.kpis`, `system.health`, `admin.search`, `privacy.export`, `privacy.anonymize`, `billing.tax_id.validate`...). Modules and plugins extend each other only through these. |
| `net.ts` | Outbound HTTP with SSRF protection (private ranges blocked in production, DNS pinning, size and time limits). |
| `openapi.ts` | OpenAPI 3.1 documents generated from the route definitions (`/api/openapi/:surface`). |

## Modules

| Module | Purpose |
| --- | --- |
| `core` | Health, settings, modules, jobs, scheduled tasks, audit log API, events, search, notifications, saved views. |
| `security` | IP allow/block rules, security events, suspicious-login detection, login history, account-sharing detection (IP addresses as a signal, never proof), retention. |
| `iam` | Administrators, invitations, roles and permissions, sessions, TOTP 2FA, re-authentication, approvals (separation of duties). |
| `customers` | Users, organizations and memberships, custom fields, notes, timeline, impersonation, privacy requests (export/erasure), CSV import, merging duplicate accounts, signup forms, versioned agreements with acceptance records, inactive-user archiving. |
| `developers` | API keys (scopes, IP allowlists, test/live, org scoping), webhooks with signed deliveries and replay, API request logs, customer session tokens, customer-issued API keys, integration health monitoring and alerts. |
| `catalog` | Products (plans, add-ons, one-time, credit packs, bundles), prices (including installments and fixed-term access), features, meters, entitlements, purchase rules and stock limits, coupons and coupon batches. |
| `usage` | Atomic metering, quotas, reservations, overage, credits, forecasts. |
| `billing` | Subscriptions, invoices, payments, refunds, credit notes, disputes, taxes and EU VAT number format checks, currencies, dunning, hosted checkout and multi-product carts, gift vouchers, card-expiry warnings, gateway adapters. |
| `reports` | Dashboard KPIs, report catalog, CSV exports, saved and scheduled reports, metric snapshots. |
| `plugins` | Plugin host: manifests, consent, sandboxing, versions/rollback, marketplace, circuit breaker. |
| `themes` | White-label design tokens, logos, custom CSS, per-organization and per-domain themes. |
| `identity` | Optional built-in authentication for apps that have none (register, login, verification, password reset, social sign-in through Google, GitHub, Microsoft or any OpenID Connect provider). |
| `access` | Content protection: user groups, protected URLs, folders, pages, links and downloads by plan, product or group, drip release, signed download links with limits, access log, access checks for your apps. |
| `affiliates`, `support`, `email`, `notifications`, `marketing` | Growth and customer-operations features (affiliates include multi-level commissions, marketing materials and sub-ID tracking). |

A module is a plain object:

```ts
export const exampleModule: ModuleDefinition = {
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  dependencies: ['core', 'customers'],
  migrations: [{ id: '001', name: 'tables', up: `CREATE TABLE ...` }],
  permissions: [{ key: 'example.things.view', label: 'View things' }],
  nav: [{ id: 'things', label: 'Things', path: '/example/things', icon: 'package', section: 'catalog', permission: 'example.things.view' }],
  setup(app) { /* register settings, hooks, event handlers, jobs */ },
  routes(r, app) { /* r.route({ method, url, auth, permission, body, handler }) */ },
};
```

Disabling a module hides its navigation, rejects its routes with `403 module_disabled`, stops its
handlers and jobs, and keeps its data. Required modules cannot be disabled; modules whose
dependents are enabled cannot be disabled either.

## Request pipeline

1. Security headers, request id, optional HTTPS redirect, trusted-proxy aware client IP.
2. IP allow/block rules for the admin, API and auth surfaces.
3. Authentication by surface: admin session cookie (+ `x-csrf-token` on writes) or bearer session
   for the mobile app; secret API key for `/api/v1`; customer session token for `/api/client`.
4. Module-enabled check, permission (admins) or scope (API keys), tenant scope (org-scoped
   admins and keys only see their organizations), rate limit.
5. Sensitive routes require a re-authentication within the configured window; some actions above
   thresholds create an approval request instead of executing.
6. zod validation of params, query and body; handler; audit entry and domain events written in
   the same transaction as the change.

## Data conventions

- Prefixed, time-sortable ids (`usr_…`, `org_…`, `inv_…`).
- Money is stored as integers in minor units with an ISO currency code. Exchange rates are
  stored with their date; reports convert into the base currency.
- Timestamps are `timestamptz` in UTC; display time zones come from settings or the viewer.
- Soft deletes for customers; erasure anonymizes personal data and keeps financial records.
- Every table that holds customer data carries the owning user or organization so tenant filters
  apply in SQL, not in application memory.

## Background work

The worker runs in the web process by default (`WORKER=true`) or as separate processes
(`node apps/server/dist/cli.js worker`). Jobs are claimed with `SKIP LOCKED`, so any number of
workers can run against the same database. Scheduled tasks (renewals, dunning, metric snapshots,
retention, scheduled reports, credit expiry, webhook retries) are rows in `scheduled_tasks`,
editable from **System → Jobs & health**.

## Scaling

The service is stateless apart from PostgreSQL and the storage directory (uploaded plugins,
files, generated documents). Run several web instances behind a load balancer with a shared
database and a shared volume or object-storage mount for `STORAGE_DIR` and `PLUGINS_DIR`.
Rate limits, jobs, sessions and settings live in the database, so they are consistent across
instances. A Redis adapter is not included; PostgreSQL covers queues and rate limiting.
