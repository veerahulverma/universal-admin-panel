# Security

This page lists the controls built into Steward and what operators must still do.

## Administrator access

- Passwords are hashed with scrypt; the policy (length, mixed characters) is configurable.
  Repeated failures lock the account temporarily and raise a security event.
- TOTP two-factor authentication with one-time recovery codes (stored hashed). Codes cannot be
  replayed. Policy can require 2FA for every administrator; new administrators are then made to
  enroll before they can do anything else.
- Sessions are random opaque tokens stored hashed. The web console uses an `HttpOnly`,
  `SameSite=Strict`, `Secure` cookie plus a CSRF token header on every write. Idle and absolute
  lifetimes are configurable; administrators can see and end their sessions, and changing a
  password ends all other sessions.
- **Sensitive actions** (role changes, API key creation, refunds, 2FA changes, impersonation…)
  require re-entering the password (and 2FA code) within a short window.
- **Separation of duties**: refunds and affiliate payouts above configurable thresholds create
  approval requests that a different administrator must approve.
- Role-based access control with permissions per module and action. Administrators cannot grant
  permissions they do not hold or edit someone with more power, and the last active super
  administrator cannot be removed. Administrators can be limited to specific organizations.
- Optional IP allowlist for the admin surface.

## Integration access

- Secret API keys are shown once and stored as SHA-256 hashes. Keys have scopes, optional IP
  allowlists, expiry dates, per-key rate limits and optional organization scoping; every request
  is logged with status and latency.
- The browser SDK never sees secret keys: it uses short-lived customer session tokens minted by
  your backend, and only origins on the CORS allowlist may call the client API.
- Outgoing webhooks are signed with HMAC-SHA256 including a timestamp; secrets can be rotated.
- Incoming gateway and email-provider webhooks are signature-verified by each adapter and
  processed idempotently, so replays do not double-apply payments.

## Data protection

- Gateway credentials, email-provider credentials, plugin secrets and TOTP seeds are encrypted
  with AES-256-GCM, bound to their record with additional authenticated data. Keys are rotated
  with `rotate-keys`. Stored secrets are never returned to the browser.
- Card data never touches Steward: payments go through the gateway's hosted pages or tokens;
  only references, brand and last four digits are stored.
- Usage values are never taken from untrusted clients: metering endpoints require a secret key
  and are idempotent and atomic.
- Organization-scoped administrators and API keys are restricted to their organizations by the
  SQL filters of the customer, billing, usage, support, webhook and reporting endpoints. They
  cannot widen their own or anyone's scope, change global settings or another organization's
  settings, or see platform-wide dashboard figures; the tests cover these cross-tenant attempts.
- Dashboard figures and recent-activity lists are shown only to administrators holding the view
  permission of the underlying data (for example, revenue requires the payments permission).
- Privacy requests: data export (JSON) and erasure (anonymization that keeps legally required
  financial records). Marketing email respects consent, unsubscribe links and suppression lists.

## Auditing and monitoring

- Every administrative change is written to an append-only audit log in the same transaction as
  the change. Entries are hash-chained; a database trigger rejects updates and deletes, and
  `verify-audit` (or **System → Audit log → Verify**) detects tampering. Retention
  deletes old entries only through a guarded path.
- Login history for administrators and customers, security events (lockouts, unusual locations,
  new devices, 2FA changes, recovery-code use, auto-blocks) and notifications for critical ones.
- **IP addresses are treated as signals, never as proof** of identity or malice: they can be
  shared, dynamic or behind VPNs. Automatic blocking is optional, time-limited and reviewable.

## Impersonation

Starting an impersonation requires the permission, re-authentication and a written reason. It is
time-limited, read-only by default, uses a one-time token, is audited from start to end, shows up
on the customer's record and emits events, and the customer-facing app is expected to show a
visible banner (the SDK exposes the read-only flag). Administrators can end it at any time.

## Web security

- Strict Content-Security-Policy (`script-src 'self'`, no inline scripts), `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and HSTS when cookies are secure.
- Input validation with zod on every route; SQL is always parameterized.
- Outbound HTTP (webhooks, plugins, gateway calls) is SSRF-protected: private, loopback and
  link-local addresses are refused after DNS resolution, with size and time limits.
- CSV exports neutralize spreadsheet formulas; email templates HTML-escape variables; custom
  theme CSS is sanitized; plugin admin pages and email previews render in sandboxed iframes.

## Plugins

Uploaded plugins run in a separate, permission-restricted Node.js process with only the
capabilities an administrator approved. See [plugins.md](plugins.md#isolation) for details and
the recommendation to add network-level egress controls for untrusted plugins.

## Operator checklist

- [ ] Serve over HTTPS; keep `COOKIE_SECURE=true`; set `TRUST_PROXY` correctly.
- [ ] Generate `ENCRYPTION_KEYS` and keep them in a secret manager, separate from database backups.
- [ ] Require 2FA for administrators (**Settings → Admin sign-in & sessions**).
- [ ] Give administrators the narrowest role that works; review the team regularly.
- [ ] Set refund and payout approval thresholds that fit your business.
- [ ] Restrict API keys by scope and IP; rotate them when people leave.
- [ ] Back up the database and `DATA_DIR`; test restores; run `verify-audit` afterwards.
- [ ] Add egress controls if you install third-party plugins.
- [ ] Keep Node.js, PostgreSQL and Steward up to date.
