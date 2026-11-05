# Feature audit against aMember Pro

This audit compares Steward with the feature set of aMember Pro, as published on amember.com/features,
the affiliate, helpdesk and software-licensing feature pages, the payment-systems list, and the
docs.amember.com index and billing-plan docs. aMember marks some of these features as add-ons; they are
included here because the goal is a complete SaaS administration platform.

**Method.** Every feature was traced through the server module, its routes and permissions, the
database, and the console. "Implemented and verified" requires evidence from an automated test or a
workflow run against the running app; a page, button or form alone does not count. Section 4 records
the verification results.

| Status | Meaning |
| --- | --- |
| ✅ Verified | Implemented, and covered by an automated test or run end to end in the app |
| ◐ Partial | Some of the feature works; the gap is stated |
| ✗ Missing | Not implemented |
| ⇄ External | Needs a third-party provider or account; the integration point is described |
| — N/A | Does not apply to a SaaS administration platform; the reason is stated |

## 1. Audit at the start of this work

### A. Membership and user management

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Registration, login, logout, password recovery | ✅ | `identity` module, `/api/v1/identity/*`; identity tests |
| Email verification | ✅ | verify-email and resend endpoints; tests |
| Custom signup forms | ✗ | Registration accepts a fixed set of fields; no form definitions |
| Social and passwordless login | ✗ ⇄ | Needs OAuth apps at Google, GitHub and others |
| Custom user fields, profile management | ✅ | Custom field definitions; profile editing in the console and client API |
| Create, edit, delete, suspend, ban | ✅ | Users pages and API; tests and console sweep |
| Subscription and purchase history | ✅ | User Billing tab; verified with product invoices |
| Batch operations | ✅ | Bulk suspend, reactivate, ban, delete, tag, revoke sessions |
| CSV import | ✗ | Export only |
| Merge duplicate accounts | ✗ | |
| User groups | ✗ | Tags only; nothing can be granted to a group |
| Membership levels | ✅ | Plans, add-ons and entitlements |
| Sessions, sign-in history, IP rules, security events | ✅ | Sessions tab, login events, IP rules; tests |
| Notes, activity timeline, admin actions | ✅ | |
| Log in as the customer | ✅ | Impersonation with audit and visible status; tests |
| Saved searches | ✅ | Saved views |
| Member area | ◐ | The client API serves subscriptions, invoices, credits, usage, tickets and the affiliate area to the customer's app; no hosted pages |
| Team accounts (subusers) | ✅ | Organizations, members, invitations, seats |
| Single sign-on provider (OAuth 2.0) | ✗ | |
| Inactive-user archiving | ✗ | |
| Member directory | — | Community feature, outside SaaS administration |

### B. Products, plans and subscriptions

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Unlimited products and plans, several prices each | ✅ | Catalog; tests |
| One-time and recurring payments, lifetime plans | ✅ | Checkout and subscriptions; tests |
| Free trials, trial reminders | ✅ | |
| Paid trials and introductory prices | ✅ | `intro_amount` / `intro_cycles` |
| Installments (a fixed number of payments) | ✗ | Subscriptions renew until cancelled |
| Fixed-term access from one payment | ✗ | One-time purchases grant access for good |
| Upgrades and downgrades with proration, change at period end | ✅ | Tests |
| Renewals, expiry, cancellation, reactivation, pause | ✅ | Tests |
| Add-ons and price variants | ✅ | |
| Bundles | ◐ | Grant source `bundle` exists; no way to define one |
| Shopping cart, several products in one checkout | ◐ | Admin product invoices take several items; customer checkout takes one price |
| Coupons and discounts | ✅ | Percent or fixed, duration, limits, product rules; tests |
| Coupon batch generation | ✗ | |
| Administrator-created purchases, custom pricing | ✅ | Product invoices from the user profile; complimentary subscriptions; overrides |
| Stock limits | ✗ | |
| Purchase restrictions (requires or excludes a product) | ✗ | Only "one plan at a time" |
| Gift vouchers | ✗ | |
| One-click upsell | ✗ | Optional |
| Pricing tables and buy buttons | ◐ | `/api/client/plans` and checkout API; no embeddable widget |
| Multiple currencies | ✅ | |

### C. Billing and invoices

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Invoice from the user profile | ✅ | Billing tab → Add invoice: products, coupon, discounts; tests and browser runs |
| Pending invoices, recorded payments | ✅ | Access granted on payment; tests and browser runs |
| Payment links and invoice email | ✅ | Gateway checkout and hosted pay page; browser run with the sandbox gateway |
| Invoice history and payment status | ✅ | |
| PDF invoices, numbering prefixes | ✅ | |
| Taxes: VAT, GST, inclusive/exclusive, reverse charge | ✅ | Tests |
| VAT ID validation | ◐ ⇄ | IDs stored and used for reverse charge; no VIES check |
| Refunds, credit notes, chargebacks | ✅ | Tests |
| Failed payments, retries, dunning | ✅ | Tests |
| Card expiry warnings | ✗ | |
| Reconciliation and transaction reports, CSV exports | ✅ | |
| Accounting sync (Xero, Quaderno) | ⇄ | CSV exports only |

### D. Payment gateways

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Several gateways | ✅ | Stripe, PayPal, Razorpay, manual, sandbox built in; Paddle, PayU, Cashfree as plugins; mocked-API tests. Live accounts ⇄ |
| Install and configure through plugins | ✅ | Gateway plugin contract; billing core unchanged by new gateways |
| One-time and recurring capabilities | ✅ | Declared per adapter |
| Webhooks and reconciliation | ✅ | Signed webhooks, idempotent inbox; tests |
| Automatic retries | ✅ | Dunning schedule; tests |
| Fallback and alternative methods | ◐ | Customers can pay an open invoice through any enabled gateway; no automatic fallback after a decline |
| Refunds and gateway limitations | ✅ | |

### E. Content protection and access control

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Protect pages, files, folders, links, URLs | ✗ | |
| Access by product, plan or user group | ◐ | Entitlements by plan and feature exist; no content rules |
| Revoke access on expiry or cancellation | ✅ | Entitlements are recomputed from subscriptions and grants |
| Drip (scheduled release) | ✗ | |
| Protected downloads, download limits | ✗ | Core storage exists |
| Account sharing prevention | ✗ | |
| Access checks from external apps | ◐ | Entitlements API and SDKs; no resource-level check |

### F. Email and automation

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Templates, editable notifications | ✅ | |
| Mailing lists with opt-in | ◐ | One marketing consent flag; no lists |
| Welcome email | ✗ | |
| Autoresponders and onboarding sequences | ✗ | |
| Receipts, payment failures, trial ending, cancellation | ✅ | Automations; tests |
| Renewal and expiry reminders | ✗ | |
| Scheduled broadcasts | ✅ | Campaigns with schedule and throttling; tests |
| Segmentation | ✅ | Segments by plan, activity and attributes |
| Queues, throttling, provider failover | ✅ | |
| Unsubscribe, bounce, complaint handling | ✅ | Suppressions; tests |
| Newsletter services (Mailchimp and others) | ⇄ | |

### G. Affiliates

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Registration and approval | ✅ | Tests |
| Referral links, cookies, attribution | ✅ | |
| First-payment and recurring commissions | ✅ | Recurring months |
| Rates per product and per affiliate | ✅ | Commission overrides |
| Performance tiers (sales volume) | ✅ | Revenue and conversion thresholds |
| Multi-level commissions (referrer's referrer) | ✗ | |
| Approval, hold period, payouts | ✅ | Tests |
| Refund and chargeback reversals | ✅ | Tests |
| Reports and fraud checks | ✅ | |
| Marketing materials (banners, links) | ✗ | |
| Sub-ID tracking | ✗ | |
| Affiliate coupons | ✅ | Coupons linked to affiliates |

### H. Help desk

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Tickets, assignment, categories, priorities, statuses | ✅ | Tests |
| Customer billing context beside the ticket | ✅ | |
| Internal notes, saved replies | ✅ | |
| Notifications to customers and staff | ✅ | Templates registered; tests |
| FAQ and knowledge base | ✗ | |
| Custom ticket fields | ✗ | |
| Attachments | ✅ | Size and type limits |
| Automatic assignment (default owner, round-robin) | ✗ | |
| SLA targets, escalation, auto-close, tickets by email | ✅ | |
| History and reporting | ✅ | Support workload report |

### I. Software licensing

| Feature | Status |
| --- | --- |
| Key generation, activation API, limits and devices, expiry with the subscription, update downloads, policies, revocation, activation history | ✗ (none) |

### J. Teams and organizations

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Team accounts, owners and members, invitations | ✅ | Tests |
| Seat-based subscriptions | ✅ | Per-seat prices |
| Organization billing and usage limits | ✅ | |
| Shared resources and team permissions | ◐ | Member roles (owner, admin, member); no per-resource sharing |

### K. Credits and usage-based billing

| Feature | Status |
| --- | --- |
| Credit purchases, balances, deductions, refunds; usage tracking and quotas; daily, monthly, lifetime and billing-period limits; custom resources; allocation on purchase and renewal; history; admin adjustments; unlimited and overage plans | ✅ (usage and billing tests) |

### L. Plugins, themes, modules and integrations

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Plugin install, activation, configuration, updates, rollback, compatibility checks | ✅ | Tests |
| Modules with dependency checks | ✅ | |
| Themes and white-label branding | ✅ | |
| API keys, webhooks, SDKs | ✅ | |
| Integration health | ◐ | Webhook delivery health and the jobs page; no per-integration checks |
| Plugin development interface | ✅ | Manifest, hooks, sandboxed admin pages |

### M. Administration and security

| Feature | Status |
| --- | --- |
| Admin accounts and invitations, custom roles, granular permissions, organization scope, 2FA, IP rules, session management, security alerts, hash-chained audit log, re-authentication for sensitive actions, retention and privacy controls | ✅ (iam and security tests) |

### N. Reports and system management

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Revenue, subscriptions, acquisition, retention, payments, refunds, affiliates, email, usage | ✅ | Report catalog; tests |
| Custom reports and exports | ◐ | Filters, saved reports and CSV; no report builder |
| Scheduled reports by email | ✅ | Saved report schedules |
| Settings, localization, timezones | ✅ | |
| Jobs, errors, system health | ✅ | |

### O. Other aMember features

| Feature | Status | Evidence or gap |
| --- | --- | --- |
| Terms and agreements with versioned acceptance | ✗ | |
| GDPR export and deletion | ✅ | Privacy requests |
| REST API, webhooks for Zapier or Make | ✅ | |
| WordPress, forums, Telegram, GitLab | ⇄ | Access API and SDKs are the integration point |
| Interface languages | ◐ | Locale, currency, date and timezone settings; English console |
| PDF stamping, A/B tests of signup forms | — | Optional add-ons outside this scope |

## 2. Missing and incomplete features

**Missing:** custom signup forms, CSV import, merging accounts, user groups, installments, fixed-term
access, stock limits, purchase restrictions, bundle definitions, customer shopping cart, coupon batches,
gift vouchers, card expiry warnings, all content protection (resources, rules, drip, downloads, account
sharing), welcome and expiry emails, autoresponders, mailing lists, multi-level affiliate commissions,
affiliate marketing materials and sub-IDs, knowledge base, custom ticket fields, automatic ticket
assignment, software licensing, terms acceptance, inactive-user archiving, single sign-on provider,
social login.

**Partial:** member area (API only), shopping cart (admin side only), bundles (schema only), mailing
lists (single consent), fallback gateways, integration health, team resource sharing, custom reports,
interface languages.

## 3. Implementation plan, by priority

Priority 1 covers billing, access control, security and user management; priority 2 business features;
priority 3 external integrations, which get an integration point and configuration only. Every package
enforces permissions on the server, writes audit entries for admin changes, adds migrations without
changing existing rows, and ships tests.

| # | Package | Features | Backend and database | Console | API and integration | Permissions | Depends on | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Content and access (new `access` module) | User groups; protected pages, URLs, folders, links and files; rules by product, plan or group; drip release; protected downloads with limits; access log | Tables for groups and members, resources, rules, files, download tokens, access log; entitlements and grants decide access; files in core storage | Content & Access menu; user group admin; profile panel | `/api/v1/access/check`, `/api/v1/access/resources`, client "my content" and downloads, signed download links | `access.*`, `customers.groups.*` | Entitlements, core storage | Access granted and refused by plan, group, drip day and expiry; download limits; tenant isolation |
| 2 | Commerce (catalog and billing) | Installments, fixed-term access, stock limits, purchase restrictions, bundles, customer cart checkout, coupon batches, gift vouchers | Price columns for payment count and access days; product rules, stock, bundle items; vouchers; cart checkout builds a product invoice and pays it through the invoice checkout | Product and price forms; coupon batch dialog; vouchers page | `/api/client/cart/checkout`, `/api/v1/checkout/cart`, voucher redemption | `catalog.*`, `billing.*` | Product invoices | Installment schedule ends after N payments; stock and rules enforced everywhere a sale starts; bundle grants; cart paid end to end |
| 3 | Software licensing (new `licensing` module) | Schemes, keys, activations, limits and bindings, check-ins, expiry with subscriptions, revocation on refund, releases and update downloads, history | Tables for schemes, keys, activations, releases; listens to order, subscription and refund events | Licenses menu; key detail; profile panel | Public activation API, `/api/v1/licenses`, client licenses | `licensing.*` | Billing events, core storage | Key issued on payment, activation limit, deactivation, refund revokes, renewal extends |
| 4 | Help desk and email | Knowledge base; custom ticket fields; default owner and round-robin assignment; mailing lists; autoresponders; welcome, renewal, expiry and card-expiry emails | KB tables; category fields and assignment; lists and members; sequences and scheduled sends | KB editor; list and sequence pages | Public and client KB search; list subscribe and unsubscribe | `support.*`, `email.*`, `marketing.*` | Email queue | Article visibility; assignment rotation; list auto-join and leave; sequence timing |
| 5 | User management, security and affiliates | CSV import; merge accounts; custom signup forms; account sharing prevention; terms acceptance; inactive archiving; multi-level commissions; marketing materials; sub-IDs | Import jobs; merge service; form definitions; IP tracking and alerts; agreement versions and acceptances; affiliate parent and materials | Import wizard; merge dialog; forms; sharing alerts; agreements; affiliate materials | Signup form API used by identity registration; agreement acceptance API | `customers.*`, `security.*`, `affiliates.*` | Identity, customers | Import dry run and commit; merge moves records; sharing threshold alerts; tiered commissions |
| 6 | External integrations | Social login, newsletter services, VIES, accounting | Provider configuration and plugin hooks only, clearly marked as not connected | Settings | | | | Configuration validation |

## 4. Results

Packages 1 to 5 were implemented; package 6 got integration points only. Software licensing (package 3)
was built and tested, then **removed from the code at the owner's request** on 5 November 2026.

### Verification

| Check | Result |
| --- | --- |
| Server tests (Vitest, full suite) | 356 passed in 38 files |
| SDK tests | `@steward/node` 18, `@steward/js` 10 passed |
| Console unit tests | 28 passed |
| Gateway plugin tests | `gateway-paddle` 15, `gateway-payu` 15, `gateway-cashfree` 11 passed |
| Typecheck | Server, console and both SDKs: 0 errors |
| Production build | Console builds |
| Workflow script against the running app | 27 of 27 checks passed: workflows 1, 2, 3, 5, 6, 8, 9, 10 and 11 through the endpoints the console uses |
| Console runs | Protected content created and tested in the console; Email settings saved, with a test send that reported the real SMTP error; new pages rendered at desktop size; the Email settings page has no horizontal overflow at 375 px |

### The twelve workflows

| # | Workflow | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Create a user and assign a plan | ✅ | Workflow script: user created, Starter granted, Starter in the resolved plans; `customers` tests |
| 2 | Invoice from the user profile | ✅ | Script: pending Pro invoice, nothing granted before payment, invoice in the user's billing history; `billing` tests |
| 3 | Record a payment and verify access | ✅ | Script: payment recorded, invoice paid, Pro granted through its subscription, protected content opens |
| 4 | Recurring subscription and renewal | ✅ 🧪 | `billing` tests: renewals, dunning, cancellation, and the card-required trial now charged once. Not run against the live app, because it needs time to pass |
| 5 | Plan limits and access restrictions | ✅ | `usage` tests (quota enforcement, concurrent consumption); script shows the Pro quotas; Starter is refused Pro content |
| 6 | Protect content and block unauthorized users | ✅ | `/members` protected for Pro in the console; Pro customer allowed, Free and Starter refused, a `..`/percent-encoded detour refused, unprotected paths allowed; `access` tests |
| 7 | Affiliate referral and commission | ✅ 🧪 | `affiliates` tests (29), including multi-level commissions and own purchases held for review. Not run against the live app (needs an API key and a sandbox checkout) |
| 8 | Automated emails and delivery status | ✅ | Script: the receipt for the paid invoice was queued and sent, with its status in the email log; `email` tests (settings, lifecycle, sequences) |
| 9 | Support ticket created and resolved | ✅ | Script: ticket opened, answered and solved; `support` tests (knowledge base, fields, assignment) |
| 10 | Role permissions and audit logs | ✅ | Script: support role reads content access but cannot change it; audit entries for the user, grant, invoice and payment; `iam` and `security` tests |
| 11 | Plugin activation and gateway configuration | ✅ | Script: plugins listed with their state, sandbox gateway connection test passes; `plugins` and `gateways` tests |
| 12 | All of the above on desktop and mobile | ◐ | New pages checked at desktop size and the Email settings page at 375 px. A full 375 px sweep of every new page was not completed: the browser pane was hidden during the final pass |

### Feature status after this work

Features marked ✅ in section 1 are unchanged. Changed rows:

| Area | Feature | Status | Evidence or gap |
| --- | --- | --- | --- |
| A | Custom signup forms | ✅ | `customers/signup.test.ts`; registrations validated against the form |
| A | Social login | ✅ ⇄ | Google, GitHub, Microsoft and any OpenID Connect provider; `identity/social.test.ts` against a fake provider. Needs each provider's credentials |
| A | Passwordless login | ✗ | |
| A | CSV import | ✅ | `customers/import.test.ts`: column mapping, dry run, background commit |
| A | Merge duplicate accounts | ✅ | `customers/merge.test.ts`: every user reference found from the database catalog |
| A | User groups | ✅ | `access/access.test.ts`: manual and automatic (by product) membership |
| A | Inactive-user archiving | ✅ | `customers/archive.test.ts`; off by default |
| B | Installments | ✅ | `billing/commerce.test.ts` |
| B | Fixed-term access from one payment | ✅ | `billing/commerce.test.ts` |
| B | Bundles | ✅ | `catalog/commerce.test.ts` |
| B | Shopping cart | ✅ | `billing/commerce.test.ts`: customer and API cart checkout |
| B | Coupon batches | ✅ | `catalog/commerce.test.ts` |
| B | Stock limits, purchase restrictions | ✅ | `billing/commerce.test.ts`: enforced wherever a sale starts |
| B | Gift vouchers | ✅ | `billing/commerce.test.ts` |
| B | One-click upsell | ✗ | Optional; not built |
| C | VAT ID validation | ◐ ⇄ | EU format check per member state; a VIES lookup plugs into the `billing.tax_id.validate` filter. Not connected to VIES |
| C | Card expiry warnings | ✅ | `billing/commerce.test.ts`: one warning per card |
| C | Card-required trials (bug) | ✅ | Were charged at checkout and again at trial end; the checkout payment now covers the first period after the trial. `billing.test.ts` |
| E | Protect pages, files, folders, links, URLs | ✅ | `access/access.test.ts` (19 tests) and the console run |
| E | Access by product, plan or user group | ✅ | `access/access.test.ts` |
| E | Drip (scheduled release) | ✅ | `access/access.test.ts`: days after access starts, fixed dates, access windows |
| E | Protected downloads, download limits | ✅ | Signed, expiring links; limits counted atomically; `access/access.test.ts` |
| E | Account sharing prevention | ✅ | `security/account-sharing.test.ts`; IP addresses are treated as a signal, never as proof |
| E | Access checks from external apps | ✅ | `POST /api/v1/access/check`; SDK tests |
| F | Mailing lists with opt-in | ✅ | `marketing/lists.test.ts`: double opt-in, consent history, rule-based membership |
| F | Welcome email | ✅ | `email/lifecycle.test.ts`; off by default, never for imported users |
| F | Autoresponders | ✅ | `email/sequences.test.ts`; marketing email, so consent decides delivery |
| F | Renewal and expiry reminders | ✅ | `email/lifecycle.test.ts` |
| F | Email system configuration | ✅ | Settings → Email: sender addresses, sending method (SMTP, Amazon SES, SendGrid, Postmark, Mailgun, Mailjet, Resend), test send, throttle, log retention, admin notification copies. `email/settings.test.ts` and the console run |
| F | Newsletter services | ⇄ | `marketing.list_providers` plugin hook and `list.*` events; no provider bundled |
| G | Multi-level commissions | ✅ | `affiliates.test.ts` |
| G | Marketing materials, sub-ID tracking | ✅ | `affiliates.test.ts` |
| H | FAQ and knowledge base | ✅ | `support/kb.test.ts`; public and customer APIs, no hosted help-center pages |
| H | Custom ticket fields | ✅ | `support/assignment.test.ts` |
| H | Automatic assignment | ✅ | `support/assignment.test.ts`: category default agent and round-robin |
| I | Software licensing | — | Removed from the code at the owner's request |
| L | Integration health | ✅ | `developers/health.test.ts`: per-integration checks and alerts |
| M | Organization scope on security views (bug) | ✅ | Org-scoped admins saw every sign-in and alert; now only their organizations' customers. `security/scope.test.ts` |
| M | Sign-out everywhere (bug) | ✅ | Now also ends the customer's app (browser SDK) sessions. `developers.test.ts` |
| O | Terms and agreements with versioned acceptance | ✅ | `customers/signup.test.ts` |

### Final checklist

**Implemented and verified:** everything marked ✅ above, plus the section 1 features that were already
verified.

**Not implemented:** passwordless login, single sign-on provider (OAuth 2.0 server), one-click upsell,
embeddable pricing tables and buy buttons, hosted member-area and help-center pages (the client API
serves both), automatic gateway fallback after a decline, per-resource team sharing, a report builder,
interface translations, and the PHP mail(), Gmail OAuth and Campaign Monitor sending methods (use SMTP).

**External, integration point built but not connected:** social sign-in (provider credentials), VIES
(`billing.tax_id.validate`), newsletter services (`marketing.list_providers`), accounting sync (CSV
exports), and every live payment and email provider account (all tested against mocked APIs).

**Removed at the owner's request:** software licensing.

**Known limitations of the new features:**

- Protected downloads are served from memory: no streaming or resumable downloads, and uploads are capped at 512 MB.
- Automatic group membership does not see products that plugins add as entitlement sources. Drip does not restart when a subscription changes plan.
- Vouchers ignore purchase rules and stock. A cart holds at most one recurring price and starts no trials.
- A card-required trial charges the first period at signup. Charging only when the trial ends needs a card-only checkout mode in each gateway.
- Social sign-in cannot link a provider to an account that is already signed in.
- Mailgun, Mailjet and Amazon SES report bounces only through the generic signed event endpoint, not their native webhooks.
- Knowledge base search uses PostgreSQL's English text search. Anonymous article votes count once per IP address.
- Upline affiliate commissions are always a percentage of the sale.
