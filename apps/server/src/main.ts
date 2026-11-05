import { createPlatform } from './app.js';

const platform = await createPlatform();
const { app, server } = platform;

try {
  await server.listen({ host: app.config.host, port: app.config.port });
  if (app.config.worker) app.worker.start();
  app.log.info(`Steward ${app.config.version} listening on ${app.config.appUrl} (${app.db.dialect})`);
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    await platform.close().catch((err) => app.log.error({ err }, 'error during shutdown'));
    process.exit(0);
  });
}
