# Feature checklist

Status of every requirement area, checked against the code at the end of this build.

| Mark | Meaning |
| --- | --- |
| ✅ | Implemented |
| 🧪 | Covered by automated tests (`npm test`) |
| 👁 | Exercised against the running app during this build: the console page rendered with live data, and write flows were run through the console or the live API |
| ◐ | Partial: see the note |
| ✗ | Not implemented |

## Verification summary

| Check | Result |
| --- | --- |
| Server tests (Vitest, PostgreSQL via PGlite) | 366 passed in 39 files |
| SDK tests | `@steward/node` 19, `@steward/js` 11 passed |
| Plugin tests (`node --test`, mocked HTTP) | `gateway-paddle` 15, `gateway-payu` 15, `gateway-cashfree` 11, `push-notifications` 6 passed |
| Console unit tests (API client, formatting, schema forms, chart scales, sidebar navigation, content helpers) | 28 passed |
| Workflow script against the running app | 27 of 27 checks: create a user and assign a plan, invoice and record payment, protected content refused then allowed, plan limits, automatic email delivery status, support ticket solved, role permissions and audit entries, plugins and gateway connection |
| Mobile app library tests | 7 passed; mobile typecheck clean |
| Typecheck | All workspaces and the mobile app: 0 errors |
| Console page sweep | All 57 console routes (lists and detail pages with real records) render with no crash, error state or console error, and no horizontal overflow at 1024 px and 375 px. After the type scale and sidebar update, all 38 menu pages plus 22 detail, account, report and settings pages were swept again at 1024, 768 and 375 px (no error state, no overflow), and every menu link was clicked at 1440 px |
| Production build | `npm run build` passes. The built server serves the built console with the strict CSP; deep links fall back to the app; first-run setup works; the PWA service worker registers |
| Not run here | Real PostgreSQL server (CI job provided), Docker image build (Dockerfile and compose provided), live payment/email provider accounts, the mobile app on a device or simulator, browsers other than Chromium |

## 3. Universal architecture

| Feature | Status | Notes |
| --- | --- | --- |
| Modular monolith: core engine plus 17 modules with dependencies, migrations, permissions, navigation, settings | ✅ 🧪 👁 | `apps/server/src/core`, `modules/*`; Integrations → Modules |
| Enable or disable modules at runtime; disabled routes answer `module_disabled` | ✅ 🧪 👁 | Required modules and dependents are protected |
| Core usable with optional modules off | ◐ 🧪 | Tests boot the platform with different module subsets; not every combination is tested |
| Extension points: hooks/filters, domain events, scheduled jobs | ✅ 🧪 | Used by modules and plugins alike |
| Mobile application interface | ✅ 🧪 | Bearer sessions for `client: "mobile"`, same admin API and permissions |
| Developer API and integration SDKs | ✅ 🧪 | `/api/v1`, `/api/client`, `@steward/node`, `@steward/js` |

## 4. Admin dashboard

| Feature | Status | Notes |
| --- | --- | --- |
| Users: total, active, new, suspended | ✅ 🧪 👁 | |
| MRR, ARR, net revenue; subscriptions, trials, renewals, cancellations, failed payments | ✅ 🧪 👁 | MRR history from daily snapshots |
| New purchases, refunds, chargebacks, outstanding invoices | ✅ 🧪 👁 | |
| API requests, usage events, quota limits reached, rate-limit violations | ✅ 🧪 👁 | Meters have different units, so usage appears as recorded events; per-meter totals are in Products & Plans → Usage |
| Affiliate referred revenue, commissions, commissions awaiting payout | ✅ 🧪 | |
| Recent registrations, payments, sign-ins, security events | ✅ 🧪 👁 | |
| System health, jobs, failed jobs, integration checks | ✅ 👁 | |
| Date presets with comparison to the previous period | ✅ 🧪 👁 | 7 / 30 / 90 days / 12 months; the API also takes a custom from/to (used by Reports) |
| Customizable widgets and saved per-admin layouts | ✅ 🧪 👁 | Choose and order KPI tiles and panels |
| Figures filtered by the admin's permissions; none for org-scoped admins | ✅ 🧪 | Revenue needs the payments permission, and so on |
| Exportable reports | ✅ 🧪 👁 | Reports page, CSV |

## 5. User and customer management

| Feature | Status | Notes |
| --- | --- | --- |
| Directory: search, filters (status, plan, subscription, verified, country, source, tag, activity, signup dates), sorting, pagination | ✅ 🧪 👁 | Filters live in the URL; saved views |
| Bulk actions: suspend, reactivate, ban, tag, untag, sign out, delete | ✅ 🧪 👁 | Per-action permission checks on the server |
| Plan, subscription status, lifetime revenue, source, last activity in the list | ✅ 🧪 👁 | |
| Profile: personal data, custom fields, organizations, subscriptions, invoices, payments, credits, usage and quotas, sessions, sign-in history with IPs, support tickets, notes, tags, email history, referral, verification and status | ✅ 🧪 👁 | Tabs on the user page |
| Create, edit, suspend, ban, unban, delete, restore | ✅ 🧪 👁 | |
| Verify email, password reset, revoke sessions | ✅ 🧪 👁 | Reset is emailed by the identity module or sent to your app as a webhook |
| Assign plans, grant credits, adjust quotas, extend subscriptions, complimentary subscriptions, refunds | ✅ 🧪 👁 | Plan & access tab (grants, overrides), Usage tab, Revenue pages |
| Impersonation: permission, re-auth, written reason, time limit, read-only default, audit, visible status | ✅ 🧪 👁 | |
| Soft delete, data export, privacy erasure requests | ✅ 🧪 👁 | Erasure anonymizes and keeps financial records |
| A customer's API keys shown on the user page | ◐ | Customer-issued keys are listed under Developers → API keys |

## 6. Plans, subscriptions and entitlements

| Feature | Status | Notes |
| --- | --- | --- |
| Free, trial, paid, lifetime, custom plans | ✅ 🧪 👁 | |
| Any interval: day, week, month, year with counts (quarterly = 3 months) | ✅ 🧪 | |
| Recurring and one-time purchases, credit packs, add-ons | ✅ 🧪 👁 | |
| Flat, per-seat, usage-based, tiered and hybrid pricing; overage | ✅ 🧪 👁 | |
| Trials, grace periods, renewal policies | ✅ 🧪 | |
| Upgrade, downgrade, cancel, pause, resume, reactivate | ✅ 🧪 👁 | |
| Proration and scheduled changes | ✅ 🧪 👁 | No proration preview endpoint; the console reports the server's result |
| Coupons (once/repeating/forever), intro pricing, promotions | ✅ 🧪 👁 | |
| Bundles | ◐ | No bundle product type; combine a plan with add-ons |
| Lifetime access, manual grants and admin overrides (optionally time-limited) | ✅ 🧪 👁 | Plan & access tab, verified end to end in the console |
| Entitlement resolution from plans, purchases, add-ons, organization, overrides | ✅ 🧪 | |
| Custom entitlement rules without core changes | ✅ 🧪 | `entitlements.resolve` hook (plugins) |

## 7. Usage and limits engine

| Feature | Status | Notes |
| --- | --- | --- |
| Any resource as a meter (counters and gauges), configurable in the console | ✅ 🧪 👁 | |
| Unlimited, fixed and per-seat (dynamic) quotas; per user, organization, plan, feature | ✅ 🧪 | |
| Reset periods: day, week, month, year, billing period, rolling window, lifetime | ✅ 🧪 | |
| Soft, hard and overage enforcement; warnings; grace units | ✅ 🧪 | |
| Temporary increases, admin overrides, manual adjustments, complimentary credits | ✅ 🧪 👁 | |
| Weights and multipliers | ✅ 🧪 | |
| Usage history, analytics, forecasts | ✅ 🧪 👁 | |
| Atomic reservations; race-free, idempotent consumption | ✅ 🧪 | Row locks and idempotency keys; concurrent-request tests |
| Server-side validation only (no client-supplied usage) | ✅ 🧪 | Metering requires a secret key |
| SDK for checks, recording and enforcement | ✅ 🧪 | `@steward/node` with Express, Fastify and Fetch guards |

## 8. Plugins and modules

| Feature | Status | Notes |
| --- | --- | --- |
| Upload, install, activate, deactivate, update, uninstall | ✅ 🧪 | Console pages built; uploaded-plugin activation not exercised in the browser |
| Versioning, compatibility (`engine`), dependencies, rollback | ✅ 🧪 | Every installed version is kept |
| Update notices | ◐ | "Update available" badge from the marketplace index; no push notification |
| Configuration screens and permission consent | ✅ 🧪 👁 | Settings from the manifest's JSON Schema |
| Enable or disable individual plugin features | ◐ | Only through the plugin's own settings |
| Health, error logs, circuit breaker | ✅ 🧪 | |
| Marketplace with checksum and optional Ed25519 signature | ✅ 🧪 | No marketplace was configured for the browser check |
| Sandboxed execution with declared permissions | ✅ 🧪 | Node permission model plus module and fetch interception; add egress controls for untrusted plugins |
| Module settings, versions, dependencies | ✅ 🧪 👁 | |
| Module access by role | ✅ 🧪 | Permissions per module |
| Module access by plan or organization | ✗ | Modules are platform-wide; per-plan feature access goes through entitlements |
| Plugins register navigation, routes, events, scheduled jobs, admin pages, gateways | ✅ 🧪 | Plugin pages render in a sandboxed iframe |
| Plugin SDK, docs and example plugins | ✅ 🧪 | `packages/plugin-sdk`, `docs/plugins.md`, `plugins/*` |

## 9. Themes and white-label

| Feature | Status | Notes |
| --- | --- | --- |
| Create, import, activate, preview, update, delete; presets | ✅ 🧪 👁 | |
| Light, dark and system appearance | ✅ 👁 | |
| Colours, typography, radius, density, shadow, custom CSS (sanitized) | ✅ 🧪 👁 | Editor shows WCAG contrast checks |
| Logo, favicon, name, login/checkout/email branding, asset uploads | ✅ 🧪 👁 | Uploads are content-checked and served with a sandbox CSP |
| Per-organization and per-domain themes | ✅ 🧪 | |
| Draft, preview before publishing, version history and restore | ✅ 🧪 👁 | |
| Customizable navigation | ◐ | Modules and plugins add items; no drag-and-drop editor |

## 10. Payment gateways

| Feature | Status | Notes |
| --- | --- | --- |
| Gateway abstraction with declared capabilities | ✅ 🧪 | |
| Several gateways at once; gateway plugins | ✅ 🧪 👁 | `plugins/gateway-mockpay` is a complete example |
| Stripe, PayPal, Razorpay adapters | ◐ 🧪 | Unit-tested with mocked HTTP responses; not run against live accounts |
| Paddle, PayU, Cashfree gateway plugins | ◐ 🧪 | Bundled plugins `gateway-paddle`, `gateway-payu` (PayU India), `gateway-cashfree`: checkout, signed webhooks, full and partial refunds; Paddle and Cashfree also report chargebacks. No saved methods or off-session charges. Unit-tested with mocked HTTP responses only; not run against sandbox or live accounts. See `docs/plugins.md` for setup |
| Sandbox gateway, manual payments, complimentary orders, admin invoices | ✅ 🧪 👁 | |
| Test and live mode, credentials (encrypted, write-only), webhook URLs | ✅ 🧪 👁 | Going live requires typing LIVE |
| Checkout, one-time, recurring (platform-managed renewals) | ✅ 🧪 | |
| Gateway-native subscriptions (PayPal or Paddle subscription objects) | ✗ | Renewals are charged by Steward with saved payment methods |
| Status tracking, reconciliation, amount-mismatch alerts | ✅ 🧪 | |
| Failed payments, dunning and retry policy | ✅ 🧪 | |
| Refunds, partial refunds, chargebacks | ✅ 🧪 👁 | Large refunds need a second approver |
| Webhook idempotency | ✅ 🧪 | Inbox keyed by provider event id |

## 11. Orders, invoices and finance

| Feature | Status | Notes |
| --- | --- | --- |
| Orders and line items | ✅ 🧪 👁 | No order detail endpoint; the console shows a summary dialog |
| Invoices: gapless numbering, PDF | ✅ 🧪 👁 | |
| Invoice a user from their profile (Billing tab → Add invoice): plans and products picked with their prices and intervals, a coupon, extra discounts on the first payment and on renewals; add as pending, record a payment, email the pay link, or create a payment link on a chosen gateway | ✅ 🧪 👁 | Needs `billing.invoices.manage`. Backed by a pending order: the plan starts and products are granted only when the invoice is paid, however it is paid. One currency and one recurring price per invoice. Invoices → New invoice still bills free-text lines |
| Taxes: VAT, GST, regional rates, inclusive/exclusive, B2B reverse charge | ✅ 🧪 👁 | |
| Billing profiles and addresses | ✅ 🧪 👁 | |
| Reconciliation and transaction history | ✅ 🧪 👁 | |
| Refunds and credit notes | ✅ 🧪 👁 | |
| Discounts and coupons | ✅ 🧪 👁 | |
| Failed payments and outstanding balances | ✅ 🧪 👁 | |
| Revenue reports and financial exports | ✅ 🧪 👁 | CSV |
| Multi-currency prices and conversion | ✅ 🧪 👁 | Exchange rates per date |
| No raw card data stored | ✅ | Only gateway references, brand and last four digits |
| Dispute evidence submission | ✗ | Respond in the gateway's dashboard |

## 12. Email and notifications

| Feature | Status | Notes |
| --- | --- | --- |
| Providers: SMTP, SendGrid, Postmark, Resend, development log; priority and failover | ✅ 🧪 👁 | SES and Mailgun work over SMTP |
| Templates with variables, sample data, live preview, translations | ✅ 🧪 👁 | Previews render in a sandboxed iframe |
| Visual (WYSIWYG) editor | ◐ | HTML editor with variable chips and live preview |
| Account, security, billing, usage and affiliate emails | ✅ 🧪 | Affiliate and support templates registered during this build |
| Campaigns and scheduled sends with consent rules | ✅ 🧪 👁 | Opt-ins and suppressions honoured; skipped recipients reported |
| Queue, retries, delivery tracking, logs, deliverability analytics | ✅ 🧪 👁 | |
| Bounces, complaints, unsubscribes, suppression list | ✅ 🧪 👁 | Provider events parsed generically |
| Test emails and connection tests | ✅ 🧪 👁 | |
| Preferences and consent | ✅ 🧪 | Client API and SDK |
| In-app notification center (admins and customers) | ✅ 🧪 👁 | |
| Web push | ◐ 🧪 | VAPID signing and subscriptions are tested; delivery to real push services not verified |
| Push notifications: send to one customer from their page, bulk sends under Marketing (everyone, a segment or a plan's customers; marketing sends only to consenting customers; scheduling and cancelling; delivery figures), automatic notifications for payments, renewals, trials, cancellations and usage | ✅ 🧪 👁 | `notifications` tests; checked against the running app |
| Push notification plugin: OneSignal (by customer id) and Firebase Cloud Messaging (app device tokens) | ◐ 🧪 | Plugin and host tests with mocked provider APIs; not run against real OneSignal or Firebase accounts |

## 13. API management and developer tools

| Feature | Status | Notes |
| --- | --- | --- |
| Keys: create, roll with grace period, revoke, expire; secret shown once | ✅ 🧪 👁 | |
| Scopes, IP allowlists, per-key rate limits, organization keys | ✅ 🧪 👁 | |
| Request logs and metrics (by endpoint, key, API) | ✅ 🧪 👁 | Metadata only; bodies are not stored |
| Customer-issued API keys with usage quotas | ✅ 🧪 | For SaaS products that sell API access |
| API version setting | ◐ | Version is reported and sent with webhooks; no multi-version routing |
| Webhooks: events, signing, retries, delivery history, replay, auto-disable and alerts | ✅ 🧪 👁 | |
| OpenAPI documents and interactive explorer | ✅ 👁 | All four API surfaces |
| OAuth2 and service accounts | ✗ | Secret API keys and customer sessions instead |
| Sandbox and test credentials | ◐ | Sandbox gateway and test-labelled keys; data is not partitioned by key mode |
| SDKs and examples | ◐ 🧪 | Node and browser SDKs, example app; other languages via the OpenAPI documents |

## 14. Affiliates and referrals

| Feature | Status | Notes |
| --- | --- | --- |
| Applications and approval; links and codes; cookie windows | ✅ 🧪 👁 | |
| First-click or last-click attribution | ✅ 🧪 | |
| Commission rates, tiers, recurring or one-time | ✅ 🧪 👁 | |
| Referral tracking, conversions, reports | ✅ 🧪 👁 | Also in the report catalog |
| Approval, payouts (second approver above a threshold), history | ✅ 🧪 👁 | |
| Reversal on refunds and lost chargebacks | ✅ 🧪 | Manual reversal is a negative adjustment |
| Fraud signals and review | ✅ 🧪 👁 | |
| Thresholds, terms, tax and payout details (encrypted) | ✅ 🧪 👁 | |
| Affiliate-facing dashboard data | ✅ 🧪 | `/api/client/affiliate` for your app's UI |

## 15. Admin team and permissions

| Feature | Status | Notes |
| --- | --- | --- |
| The eight default roles | ✅ 🧪 👁 | System roles are read-only and can be duplicated |
| Custom roles; permissions by module, resource and action, with wildcards and denies | ✅ 🧪 👁 | |
| Organization scope for admins and keys | ✅ 🧪 👁 | Escalation guards tested |
| Invitations, role assignment, sessions, 2FA, IP restrictions | ✅ 🧪 👁 | |
| Sensitive-action re-authentication | ✅ 🧪 👁 | |
| Separation of duties (refunds, payouts) | ✅ 🧪 👁 | |
| Activity log | ✅ 🧪 👁 | Audit log with hash-chain verification and CSV export |

## 16. Security and monitoring

| Feature | Status | Notes |
| --- | --- | --- |
| Sign-ins and failures, sessions and devices, IP history | ✅ 🧪 👁 | IPs are presented as signals, never proof |
| Approximate location | ◐ | From your CDN's country header; no GeoIP database bundled |
| Suspicious activity (lockouts, unusual location, new device, auto-block) | ✅ 🧪 👁 | |
| Bans, IP blocking, rate limits, lockout, 2FA, password reset, session expiry and revocation | ✅ 🧪 👁 | 2FA is for administrators; customer 2FA belongs to your app (or a plugin) |
| CSRF, XSS, SQL injection, SSRF protections; secure cookies; HTTPS enforcement | ✅ 🧪 | |
| Encryption of secrets with key rotation | ✅ 🧪 | |
| Security alerts and audit trail | ✅ 🧪 👁 | |
| Retention policies | ✅ 🧪 | |

## 17. Organizations and multi-tenancy

| Feature | Status | Notes |
| --- | --- | --- |
| Organizations, owners, admins, members, invitations and approval, ownership transfer | ✅ 🧪 👁 | |
| Team subscriptions, seats, organization quotas, shared credits | ✅ 🧪 👁 | |
| Organization API keys, branding, settings overrides, activity | ✅ 🧪 👁 | |
| Custom per-organization member roles | ◐ | Owner, admin and member roles |
| Tenant isolation in queries, APIs, event delivery and file access | ✅ 🧪 | Three isolation bugs were found and fixed during this build (webhooks, admin scope, settings) |

## 18. Customer support and CRM

| Feature | Status | Notes |
| --- | --- | --- |
| Tickets, categories, priorities, statuses, assignment | ✅ 🧪 👁 | |
| Replies and internal notes, attachments, saved replies | ✅ 🧪 👁 | Ticket text shown as plain text |
| Email to ticket | ✅ 🧪 | Inbound provider webhook in JSON form |
| SLA tracking and escalation; CSAT; support reports | ✅ 🧪 👁 | |
| Tags and custom fields; customer timeline | ✅ 🧪 👁 | |

## 19. Marketing and growth

| Feature | Status | Notes |
| --- | --- | --- |
| Coupons, referral program, segments, email campaigns | ✅ 🧪 👁 | |
| Trial conversion tracking | ✅ 🧪 👁 | Trial conversion report: converted, dropped, still running |
| Abandoned checkout recovery, win-back, upsell automations | ✅ 🧪 | Upsell is rule-light: cooldown and link |
| Campaign attribution and analytics | ✅ 🧪 👁 | |
| Promotional landing page builder | ✗ | Affiliate landing URLs only |
| Consent and preferences respected | ✅ 🧪 | |

## 20. Reporting and analytics

| Feature | Status | Notes |
| --- | --- | --- |
| Revenue, revenue by product, MRR by plan, subscription growth, churn, LTV, payment recovery, trial conversion, retention cohorts, acquisition, top customers, signups by source, usage, API reliability | ✅ 🧪 👁 | |
| Affiliate performance, email delivery and engagement, support workload and resolution | ✅ 🧪 👁 | Added to the catalog during this build, with trial conversion |
| Custom ranges, grouping, saved and scheduled reports (signed download links), CSV | ✅ 🧪 👁 | |
| Spreadsheet (XLSX) export | ◐ | CSV opens in spreadsheet apps |
| Drill-down | ◐ | Dashboard and lists link to records; report rows do not |
| Other modules can add reports | ✅ | `reports.catalog` hook |

## 21. Settings and integrations

| Feature | Status | Notes |
| --- | --- | --- |
| Every section rendered from its schema with validation, defaults reset, organization overrides | ✅ 🧪 👁 | |
| General, auth, email, gateways, plugins, modules, API, billing and tax, security, retention, jobs and scheduled tasks | ✅ 🧪 👁 | |
| Connection tests and error reporting for gateways, email providers, webhooks | ✅ 🧪 👁 | |
| Cache, storage and queue configuration | ◐ | Environment variables; no cache layer to configure |

## 22. Responsive web and mobile

| Feature | Status | Notes |
| --- | --- | --- |
| Collapsible sidebar, mobile drawer, responsive tables (cards on phones), responsive charts | ✅ 👁 | |
| Type scale and grouped navigation: body text follows the theme's base font size; 10 parent menus with expandable submenus, the current page highlighted and its menu opened; icon rail with flyout menus when collapsed | ✅ 🧪 👁 | Checked at 1440, 1280, 1024, 768 and 375 px; keyboard toggles and deep links verified |
| No horizontal overflow | ✅ 👁 | Swept at 1024, 768 and 375 px; fixed table and grid overflow found by the sweep |
| Accessible dialogs, menus, forms; keyboard navigation and shortcuts | ✅ 👁 | Radix primitives; not audited with assistive technology |
| Code-split pages, installable PWA | ✅ 👁 | |
| Cross-browser | ◐ | Checked in Chromium only |
| Native mobile app (Expo / React Native): login, 2FA, biometrics, dashboard, users, subscriptions, payments and refunds, alerts, audit log, RBAC, bans | ◐ 🧪 | Typecheck and library tests pass; not run on a device or simulator |

## 23. Integration into any SaaS application

| Feature | Status | Notes |
| --- | --- | --- |
| Standalone app; REST APIs with OpenAPI | ✅ 🧪 👁 | |
| Auth middleware, backend SDK, frontend SDK, webhooks | ✅ 🧪 | |
| Plugin, metering and entitlement interfaces | ✅ 🧪 | |
| Migration tooling | ✅ 🧪 | CLI `migrate`, checksummed migrations |
| Existing authentication and user records kept (`externalId`, login reporting) | ✅ 🧪 | |
| Seven-step integration guide; example application | ✅ | `docs/integration.md`, `apps/example-saas` |

## 24–25. Technical requirements and database

| Feature | Status | Notes |
| --- | --- | --- |
| Typed backend and frontend | ✅ | TypeScript strict everywhere |
| PostgreSQL | ✅ 🧪 | Tests use PGlite (PostgreSQL compiled to WebAssembly); the `pg` driver path is exercised by the CI job, not here |
| Queues and distributed rate limits | ✅ 🧪 | PostgreSQL-backed (no Redis needed); no Redis adapter |
| Background workers, scheduled tasks | ✅ 🧪 | Run in-process or as separate workers |
| Migrations and versioned schema; constraints, indexes, idempotency keys | ✅ 🧪 | |
| No plaintext secrets, passwords or tokens | ✅ 🧪 | Hashes for passwords, sessions, keys; encryption for credentials |
| CI/CD | ◐ | GitHub Actions workflow and Dockerfile written; not executed here |
| Centralized logging | ✅ | Structured JSON logs with request ids |
| Error monitoring service integration (Sentry and similar) | ✗ | Logs, health checks and admin notifications only |

## 26. UI and UX

| Feature | Status | Notes |
| --- | --- | --- |
| Design system, typography, spacing, icons; light, dark, system | ✅ 👁 | |
| Empty states, skeleton loaders, clear errors, confirmations, toasts | ✅ 👁 | |
| Searchable navigation, global search (Ctrl/⌘ K), keyboard shortcuts | ✅ 👁 | |
| Contextual help | ◐ | Field hints and page descriptions; no help center |
| Accessible forms and controls | ✅ 👁 | Labelled controls, focus states |

## 27. Testing and quality

| Area | Status | Notes |
| --- | --- | --- |
| Authentication, permissions, admin permissions, security-sensitive actions | ✅ 🧪 | `iam`, `customers`, `developers`, `core/http` tests |
| User management, subscription lifecycle, payments and webhook idempotency | ✅ 🧪 | `customers`, `billing`, `gateways` tests |
| Usage limits and concurrent requests | ✅ 🧪 | `usage` tests |
| Plugin activation and failure handling | ✅ 🧪 | `plugins` tests (sandbox, circuit breaker) |
| API authorization and tenant isolation | ✅ 🧪 | Several modules test cross-tenant access |
| Mobile responsiveness | ◐ 👁 | Scripted browser sweep during this build; not in the automated suite |
| End-to-end UI tests (every button) | ✗ | Write flows are covered at the API level; there is no browser E2E suite |

## 28. Deliverables

| Deliverable | Where |
| --- | --- |
| Source code | `apps/`, `packages/`, `plugins/` |
| Migrations and seed data | Module migrations; `npm run seed` |
| Admin interface | `apps/admin` |
| APIs and authentication | `apps/server` |
| Plugin and module architecture | `core/modules.ts`, `modules/plugins`, `packages/plugin-sdk` |
| Payment gateway framework | `modules/billing/gateways` |
| Subscription and usage engines | `modules/billing`, `modules/usage`, `modules/catalog` |
| Admin and customer management | `modules/iam`, `modules/customers` |
| Mobile application | `apps/mobile` |
| Automated tests | `npm test`, `apps/mobile` tests |
| API, plugin SDK, integration, installation, configuration, security and backup docs | `docs/` and package READMEs |
| Example plugins, themes, gateway | `plugins/*`, theme presets, `plugins/gateway-mockpay` |

## 29. Feature parity with aMember Pro

Audit, plan and results: [docs/feature-audit.md](docs/feature-audit.md).

| Feature | Status | Notes |
| --- | --- | --- |
| Content protection: protected URLs, folders, pages, links and downloads by plan, product or user group; drip release; signed download links with limits; access log; access checks for your apps | ✅ 🧪 👁 | `access` module; protected a folder in the console and checked allowed and refused customers |
| User groups (manual and automatic by product) | ✅ 🧪 | |
| Installments, fixed-term access, bundles, stock limits, purchase restrictions, cart checkout, coupon batches, gift vouchers, card-expiry warnings | ✅ 🧪 | `billing` and `catalog` commerce tests |
| EU VAT number format check | ◐ 🧪 | No VIES lookup; plug one into `billing.tax_id.validate` |
| CSV import, merging duplicate accounts, signup forms, versioned agreements, inactive-user archiving | ✅ 🧪 | |
| Account-sharing detection (IP addresses as a signal, never proof) | ✅ 🧪 | |
| Social sign-in (Google, GitHub, Microsoft, OpenID Connect) | ✅ 🧪 | Tested against a fake provider; needs provider credentials |
| Knowledge base, custom ticket fields, automatic ticket assignment | ✅ 🧪 | API only; no hosted help center |
| Mailing lists with double opt-in, autoresponders, welcome, renewal and expiry emails | ✅ 🧪 | Lifecycle emails are off by default |
| Email settings page: sender addresses, sending method (SMTP, Amazon SES, SendGrid, Postmark, Mailgun, Mailjet, Resend, disabled), test send, throttle queue, log retention, copies of admin notifications | ✅ 🧪 👁 | Mailgun, Mailjet and SES tested against mocked APIs |
| Multi-level affiliate commissions, marketing materials, sub-ID tracking | ✅ 🧪 | Own purchases are held for review by default |
| Integration health monitoring and alerts | ✅ 🧪 | |
| Software licensing | — | Built, then removed from the code at the owner's request |
| Fixes found during the audit: card-required trials charged twice; security views ignoring organization scope; sign-out everywhere leaving app sessions open; email provider updates resetting fields that were not sent | ✅ 🧪 | Regression tests for each |

## Known gaps, in one place

- Stripe, PayPal, Razorpay, Paddle, PayU and Cashfree are tested only against mocked HTTP; none has run against a provider sandbox or live account.
- Paddle checkout needs a default payment link page that loads Paddle.js. PayU asks customers for a mobile number on a plugin page and ignores dispute notifications. Cashfree is sent a placeholder customer phone number.
- When a bundled (in-process) gateway plugin rejects a webhook signature, the endpoint answers 500 instead of 400 and the failure counts toward the plugin's circuit breaker. Sandboxed plugins answer 400.
- Gateway-native subscription objects, dispute evidence submission, and a proration preview are missing.
- OAuth2/service accounts, multi-version API routing, and non-JavaScript SDKs are missing.
- No WYSIWYG email editor and no landing-page builder. Web push delivery is unverified.
- Module access by plan or organization and per-organization custom member roles are not available.
- There is no Redis adapter and no external error-monitoring integration.
- No browser E2E test suite exists. The mobile app has not run on a device. Only Chromium was checked.
- Real PostgreSQL, Docker and CI have not been run in this environment.
