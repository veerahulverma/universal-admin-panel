# Configuration

There are two layers:

1. **Environment variables** for infrastructure and secrets the application needs before it can
   reach the database. See [`.env.example`](../.env.example) for every variable with comments.
2. **Settings** stored in the database and edited in **System → Settings**. Each module
   registers typed sections (validated with zod); changes are audited and apply to every instance
   within seconds. Sections marked as overridable can also be set per organization.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enforces encryption keys and secure cookies |
| `HOST` / `PORT` | `0.0.0.0` / `4000` | |
| `APP_URL` | `http://localhost:4000` | Public URL used in links, redirects and webhooks |
| `ADMIN_URL` | `APP_URL` | Only when the admin UI runs on another origin (Vite in development) |
| `DATABASE_URL` | `pglite://./data/pglite` | `postgres://…` in production |
| `DB_POOL_MAX` | `10` | Connections per instance |
| `DATA_DIR` | `./data` | Root for storage, plugins and the development key |
| `STORAGE_DIR` / `PLUGINS_DIR` | under `DATA_DIR` | Share between instances when scaling out |
| `ENCRYPTION_KEYS` | generated in development | Required in production: `id:base64key[,id:base64key]` |
| `ENCRYPTION_ACTIVE_KEY` | last key | Key id used for new encryptions |
| `TRUST_PROXY` | off | `true`, a hop count or proxy CIDRs |
| `COOKIE_SECURE` | `true` in production | |
| `FORCE_HTTPS` | `false` | Redirect HTTP to HTTPS |
| `WORKER` / `WORKER_CONCURRENCY` | `true` / `5` | Run jobs in the web process |
| `LOG_LEVEL` | `info` | Structured JSON logs (pino) |
| `SETUP_TOKEN` | random, logged | One-time token for `/setup` |
| `PLUGIN_SANDBOX` | `true` | Run uploaded plugins in restricted child processes |
| `MARKETPLACE_URL` / `MARKETPLACE_PUBLIC_KEY` | unset | Plugin marketplace index and Ed25519 signing key |
| `ALLOW_PRIVATE_NETWORK` | `true` outside production | Allow outbound calls to private networks |
| `ADMIN_DIST_DIR` / `BUNDLED_PLUGINS_DIR` | repository paths | Override asset locations |

## Settings sections

| Section | Fields |
| --- | --- |
| General | Application name and URL, support email, logo and favicon URLs, locale, time zone, date format, default currency, enabled currencies |
| Data retention | Days to keep audit logs, login events, API request logs, webhook deliveries, events, finished jobs, email logs |
| Admin sign-in & sessions | Idle and maximum session length, mobile session days, require 2FA, lockout threshold and minutes, password minimum length and mixed characters, re-authentication window, admin IP allowlist |
| Security | Automatic IP blocking (threshold, window, duration), geolocation header from your CDN, new-device alerts, customer lockout policy |
| Customers | Impersonation URL (`{token}` placeholder), impersonation duration, whether write-mode impersonation is allowed, privacy request due days |
| API & webhooks | Default rate limit per minute, client origins (CORS for the browser SDK), customer session minutes, webhook attempts, timeout and auto-disable threshold, API version |
| Plans & entitlements | Default plan for customers without a subscription, policy for meters without a feature (allow or deny) |
| Usage engine | Default and maximum reservation lifetimes |
| Billing | Invoice, credit note and order prefixes; seller name, address, email, tax id and country; tax on/off; invoice due days; dunning retry days and final action; refund approval threshold; checkout expiry; downgrade timing; proration; suspend on chargeback; trial reminder days; base currency |
| Identity | Open registration, required email verification, session days, password length, reset and verification page URLs, allowed and blocked email domains |
| Email | Default sender and locale, brand colour and footer, delivery attempts, development log fallback, automatic receipts, payment-failed, trial-ending, cancellation, usage-alert and checkout-recovery emails |
| Notifications | Web push on/off, VAPID subject, allowed push services, which events notify customers |
| Support | Auto-close days, first-response and resolution targets per priority, attachment size and types, closed-ticket retention, customer-set priority, users from inbound email |
| Affiliates | Auto-approval, cookie days and first/last-click attribution, percent or fixed commission, recurring months, hold days, minimum payout, payout approval threshold, landing URL and allowed redirect hosts, fraud velocity thresholds, click retention, terms URL |
| Marketing | Batch size and delay, abandoned-checkout, win-back and upsell automations with delays and links, attribution window |

Every change is written to the audit log with a field-level diff of the old and new values.
