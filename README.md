# Steward

A self-hosted, modular, white-label **administration platform for SaaS products**. Steward runs
next to your application and gives your team one place to manage customers, plans and
entitlements, usage limits, billing and payment gateways, developers' API access, support,
affiliates, marketing email, security and reporting, on the web and on iOS and Android.

It is built to be connected to an **existing** product: your app keeps its database, its
authentication and its code, and talks to Steward through a typed SDK, webhooks and adapters.

## What's inside

| Area | Highlights |
| --- | --- |
| Customers | Users and organizations, search and saved filters, bulk actions, notes, timeline, custom fields, audited impersonation, privacy export and erasure |
| Plans & entitlements | Plans, add-ons, one-time products, credit packs, multi-currency prices, trials, intro pricing, features and quotas, coupons |
| Usage engine | Atomic, idempotent metering for any resource, reservations, gauges, soft/hard/overage limits, credits, forecasts |
| Billing | Subscriptions with proration, invoices and credit notes, taxes (VAT/GST, reverse charge), dunning, refunds with approvals, disputes, hosted checkout |
| Payment gateways | Pluggable adapters with declared capabilities: Stripe, PayPal, Razorpay, a sandbox and manual payments built in; more as plugins |
| Developers | Scoped API keys, signed webhooks with replay, request logs, OpenAPI explorer, Node and browser SDKs |
| Growth | Affiliates with fraud checks and payouts, segments and email campaigns with consent, transactional email with failover providers |
| Support | Ticket inbox with SLAs, internal notes, attachments and CSAT |
| Security | 2FA, RBAC, re-authentication, separation of duties, IP rules, hash-chained audit log, security events |
| Platform | Runtime-switchable modules, typed settings, sandboxed plugins with a marketplace, white-label themes per tenant or domain |
| Reports | Dashboard KPIs, revenue/MRR/churn/LTV/usage reports, CSV export, scheduled reports |
| Apps | Responsive web console (installable PWA, dark mode) and a native mobile app |

## Quick start

```bash
npm install
npm run seed   # optional demo data; prints the admin login
npm run dev    # API http://localhost:4000 · console http://localhost:5173
```

No database install is needed in development (PGlite). Production uses PostgreSQL:

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, ENCRYPTION_KEYS, APP_URL
docker compose up -d --build
```

## Documentation

| Guide | |
| --- | --- |
| [Architecture](docs/architecture.md) | Modular monolith, core engine, modules, request pipeline, scaling |
| [Installation & deployment](docs/installation.md) | Local development, Docker, reverse proxy, upgrades, backups |
| [Configuration](docs/configuration.md) | Environment variables and settings sections |
| [Integration guide](docs/integration.md) | Connecting an existing SaaS product in seven steps |
| [API reference](docs/api.md) | API surfaces, conventions, errors, webhooks |
| [Plugins](docs/plugins.md) | Manifest, permissions, sandbox, gateway plugins, testing |
| [Themes](docs/themes.md) | Design tokens, white-labelling, per-tenant themes |
| [Security](docs/security.md) | Controls and the operator checklist |
| [Node SDK](packages/sdk-node/README.md) · [Browser SDK](packages/sdk-js/README.md) | SDK usage |
| [Mobile app](apps/mobile/README.md) | Running and building the iOS/Android app |
| [Example integration](apps/example-saas/README.md) | A small SaaS app wired to Steward |
| [Feature checklist](FEATURES.md) | What is implemented, tested and verified, and known gaps |

## Repository

```
apps/server         API, worker, CLI (Fastify, TypeScript, PostgreSQL)
apps/admin          Web console (React, Vite, Tailwind)
apps/mobile         iOS and Android app (Expo, React Native)
apps/example-saas   Example integration
packages/sdk-node   @steward/node
packages/sdk-js     @steward/js
packages/plugin-sdk @steward/plugin-sdk
plugins/            Bundled reference plugins
docs/               Guides
```

## Development

```bash
npm run typecheck   # all workspaces
npm test            # server, SDK and plugin tests (no external services needed)
npm run build       # admin UI + server for production
```
