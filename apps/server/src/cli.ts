import { createPlatform } from './app.js';
import { loadConfig } from './config.js';
import { Db } from './core/db.js';
import { OffsetClock } from './core/clock.js';
import { runMigrations } from './core/migrate.js';
import { sortModules } from './core/modules.js';
import { allModules } from './modules/index.js';
import { sql } from './core/sql.js';
import { hashPassword } from './core/crypto.js';
import { newId, randomBase62 } from './core/ids.js';
import { verifyAuditChain } from './core/audit.js';
import { seedDemo } from './seed.js';

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=') as [string, string]));

const help = `Steward CLI

  migrate                         Apply database migrations
  seed [--email=you@example.com]  Load demo data (120 days of history) into an empty database
  worker                          Run background jobs without the HTTP server
  create-admin --email=… [--name=…]   Create a super administrator (prints a generated password)
  rotate-keys                     Re-encrypt stored secrets with ENCRYPTION_ACTIVE_KEY
  verify-audit                    Verify the audit log hash chain
`;

async function main(): Promise<void> {
  switch (command) {
    case 'migrate': {
      const config = loadConfig();
      const db = await Db.connect(config.databaseUrl, { poolMax: 2 });
      const n = await runMigrations(db, sortModules(allModules), { debug() {}, info: (o) => console.log(JSON.stringify(o)), warn: (o) => console.warn(JSON.stringify(o)), error: (o) => console.error(JSON.stringify(o)) });
      console.log(`Applied ${n} migration(s).`);
      await db.close();
      return;
    }
    case 'seed': {
      const clock = new OffsetClock();
      const platform = await createPlatform({ clock, env: { ...process.env, WORKER: 'false', LOG_LEVEL: 'warn' } });
      try {
        const result = await seedDemo(platform, clock, { adminEmail: args.email ?? 'admin@example.com', adminPassword: args.password, log: (m) => console.log(`  - ${m}`) });
        console.log(`\nDemo data ready.\n  Admin:    ${result.adminEmail}\n  Password: ${result.adminPassword}\n  API key:  ${result.apiKey} (test mode)\n`);
      } finally {
        await platform.close();
      }
      return;
    }
    case 'worker': {
      const platform = await createPlatform({ env: { ...process.env, WORKER: 'true' } });
      platform.app.worker.start();
      console.log(`Worker ${platform.app.worker.id} running. Ctrl+C to stop.`);
      const stop = async () => {
        await platform.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'create-admin': {
      if (!args.email) throw new Error('--email is required');
      const platform = await createPlatform({ env: { ...process.env, WORKER: 'false', LOG_LEVEL: 'warn' } });
      try {
        const password = args.password ?? `${randomBase62(16)}!a1`;
        const id = newId('adm');
        const now = new Date();
        await platform.app.db.tx(async (tx) => {
          await tx.exec(sql.insert('admins', { id, email: args.email, name: args.name ?? args.email.split('@')[0], password_hash: await hashPassword(password), status: 'active', password_changed_at: now, created_at: now, updated_at: now }, ''));
          await tx.exec(sql`INSERT INTO admin_roles (admin_id, role_id) SELECT ${id}, id FROM roles WHERE key = 'super_admin'`);
        });
        console.log(`Created super administrator ${args.email}\nPassword: ${password}\nChange it after signing in.`);
      } finally {
        await platform.close();
      }
      return;
    }
    case 'rotate-keys': {
      const platform = await createPlatform({ env: { ...process.env, WORKER: 'false', LOG_LEVEL: 'warn' } });
      try {
        const n = await platform.app.db.tx((tx) => platform.app.secrets.rotateAll(tx));
        console.log(`Re-encrypted ${n} secret(s) with key "${platform.app.encryptor.activeKeyId}".`);
      } finally {
        await platform.close();
      }
      return;
    }
    case 'verify-audit': {
      const config = loadConfig();
      const db = await Db.connect(config.databaseUrl, { poolMax: 2 });
      const result = await verifyAuditChain(db);
      console.log(result.ok ? `Audit chain intact (${result.checked} entries).` : `AUDIT CHAIN BROKEN at seq ${result.brokenAtSeq}: ${result.reason}`);
      await db.close();
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    default:
      console.log(help);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
