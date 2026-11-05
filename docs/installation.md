# Installation and deployment

## Requirements

- Node.js 22.13 or newer (Node 24 LTS recommended; the plugin sandbox uses Node's permission model).
- PostgreSQL 14 or newer in production. Development and tests use PGlite (PostgreSQL compiled to
  WebAssembly), so nothing needs installing locally.
- A persistent directory for uploaded plugins and generated files (`DATA_DIR`).

## Local development

```bash
npm install
npm run seed      # optional: 120 days of demo customers, subscriptions, payments and usage
npm run dev       # API on http://localhost:4000, admin UI on http://localhost:5173
```

`npm run seed` prints the demo administrator's email and password. Without seeding, the first
start logs a one-time **setup token**: open http://localhost:5173/setup and create the first
super administrator with it.

Data lives in `apps/server/data` (PGlite database, development encryption key, uploads). Delete
that folder to start over. Useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) and admin UI (Vite) together |
| `npm run typecheck` | Type-checks every workspace |
| `npm test` | Server, SDK and plugin tests |
| `npm run build` | Builds the admin UI to `apps/admin/dist` and the server to `apps/server/dist` |
| `npm start` | Runs the built server, which also serves the built admin UI |

The CLI (`npx tsx apps/server/src/cli.ts <command>` in development, `node apps/server/dist/cli.js
<command>` in production):

| Command | Purpose |
| --- | --- |
| `migrate` | Apply database migrations (also done automatically at startup) |
| `seed [--email=…] [--password=…]` | Load demo data into an empty database |
| `worker` | Run background jobs without the HTTP server |
| `create-admin --email=… [--name=…]` | Create a super administrator and print a generated password |
| `rotate-keys` | Re-encrypt stored secrets with `ENCRYPTION_ACTIVE_KEY` |
| `verify-audit` | Verify the audit log hash chain |

## Production with Docker Compose

```bash
cp .env.example .env
# set at least: POSTGRES_PASSWORD, ENCRYPTION_KEYS, APP_URL
docker compose up -d --build
docker compose logs app | grep -i "setup token"
```

Then open `$APP_URL/setup` and create the first administrator. The image runs as a non-root
user, applies migrations on start, exposes `/api/health` for health checks and stores files in the
`appdata` volume.

To run background jobs separately, set `WORKER: "false"` on the `app` service and start the
worker profile: `docker compose --profile worker up -d`. Any number of workers can run at once.

## Production without containers

```bash
npm ci
npm run build
NODE_ENV=production DATABASE_URL=postgres://… ENCRYPTION_KEYS=k1:… APP_URL=https://admin.example.com \
  node apps/server/dist/main.js
```

Run it under a process manager (systemd, PM2) and put a TLS-terminating reverse proxy in front.

## Reverse proxy and HTTPS

- Terminate TLS at the proxy and forward to port 4000. Set `TRUST_PROXY` to the number of proxy
  hops (usually `1`) or the proxies' CIDRs, so client IPs, rate limits and IP rules use the real
  address. Never trust `X-Forwarded-For` from the open internet.
- Keep `COOKIE_SECURE=true` (the production default). `FORCE_HTTPS=true` redirects plain HTTP.
- Payment and email providers call back to `APP_URL` (`/api/public/gateways/...`,
  `/api/public/email/events/...`), so it must be reachable from the internet.

## Scaling out

Several web instances can share one database. Share `STORAGE_DIR` and `PLUGINS_DIR` between them
(network volume or object-storage mount) so uploaded plugins and generated files are visible
everywhere. Jobs, rate limits, sessions and settings are coordinated through PostgreSQL.

## Upgrades

1. Back up the database (below).
2. Deploy the new version. Migrations run at startup, each in its own transaction; a failed
   migration aborts startup and leaves the schema unchanged.
3. Check **System → Jobs & health** for failed jobs and health warnings.

Applied migrations are checksummed: editing a shipped migration is detected and refused, so ship
schema changes as new migrations.

## Backup and restore

- **Database**: `pg_dump --format=custom "$DATABASE_URL" > steward-$(date +%F).dump`, restore with
  `pg_restore --clean --if-exists --dbname "$DATABASE_URL" steward-….dump`. Use your provider's
  point-in-time recovery where available.
- **Files**: back up `DATA_DIR` (uploaded plugins, generated invoices and exports).
- **Encryption keys**: store `ENCRYPTION_KEYS` in your secret manager. A database backup without
  its keys cannot decrypt gateway credentials, 2FA secrets or plugin secrets.
- After restoring, run `verify-audit` to confirm the audit chain is intact.

## Retention

**System → Settings → Data retention** controls how long audit logs, login events, API request
logs, webhook deliveries, events, finished jobs and email logs are kept. A daily scheduled task
deletes older rows.
