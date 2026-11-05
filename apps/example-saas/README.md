# Example SaaS integration

A dependency-free Node app (`node:http`) that keeps its own users and passwords, like most existing SaaS products, and uses Steward through `@steward/node` for everything else:

| Flow | What the app does |
| --- | --- |
| Signup / login | `users.upsert` with its own id as `externalId`; `users.recordLogin` feeds login history and suspicious-activity detection; `users.status` blocks banned or suspended accounts |
| Feature gate | `gate()` checks account status and the plan feature (`DEMO_FEATURE`, default `sso`) → 402 when not in the plan |
| Metering | `usage.consume` on `DEMO_METER` (default `api_calls`) with a per-click idempotency key → 429 when the quota is used up; retries count once |
| Upgrade | `checkout.create` → redirect to the hosted checkout (`DEMO_PRICE_ID`) |
| Browser SDK | `/api/steward-session` mints a short-lived customer session; the page reads entitlements straight from Steward |
| Webhooks | `/webhooks/steward` verifies the signature; `user.banned`, `user.suspended`, `user.deleted` and `user.sessions_revoked` end local sessions |
| Impersonation | `/impersonate?token=imp_...` verifies the one-time token, shows a visible banner and blocks writes in read-only mode |

## Run it

1. Start Steward (`npm run dev` at the repo root) and finish the first-run setup.
2. In the admin panel:
   - **Products & Plans**: create a meter `api_calls`, a quota feature on it, a `sso` boolean feature, and a `free` plan with an `api_calls` limit (the `free` key is the default plan).
   - **Developers → API keys**: create a key with scopes `users:write`, `events:write`, `entitlements:read`, `usage:write`, `checkout:write`, `customer_sessions:write`, `impersonation:verify` (or `*` for a demo).
   - **Developers → Webhooks**: add `http://localhost:3000/webhooks/steward` for `user.*`. Copy the signing secret. (Private-network webhook targets are allowed in development only.)
   - **Settings → Customers**: set the impersonation URL to `http://localhost:3000/impersonate?token={token}`.
   - **Settings → API & webhooks**: add `http://localhost:3000` to client origins (for the browser demo).
3. Start the example (after `npm install` at the repo root):

```bash
STEWARD_URL=http://localhost:4000 STEWARD_API_KEY=sk_live_... STEWARD_WEBHOOK_SECRET=whsec_... npm start -w @steward/example-saas
```

Optional: `DEMO_PRICE_ID=price_...` enables the upgrade button, `DEMO_FEATURE` / `DEMO_METER` pick what to gate and meter, `PORT` and `APP_URL` change where it listens.

Open http://localhost:3000, sign up, click **Call the API** until the quota runs out, then ban or impersonate the user from the admin panel and watch the app react.

The app imports `@steward/node` from the monorepo source through a `tsconfig` path alias; in your own app install the package instead.
