// A reference plugin. Everything the plugin does goes through `ctx`, and every
// capability it uses is declared in plugin.json and approved by an admin.
let settings = {};

export async function activate(ctx) {
  settings = (await ctx.settings.get()) ?? {};

  await ctx.events.on('user.created', async (event) => {
    const count = ((await ctx.kv.get('signups')) ?? 0) + 1;
    await ctx.kv.set('signups', count);
    await ctx.log.info(`New user ${event.data.email} (total seen: ${count})`);
  });

  await ctx.routes.register({
    method: 'GET',
    path: '/hello',
    handler: async () => ({ status: 200, body: { message: settings.greeting || 'Hello from a plugin!', signups: (await ctx.kv.get('signups')) ?? 0 } }),
  });

  await ctx.routes.register({
    method: 'GET',
    path: '/page',
    auth: 'admin',
    handler: async (req) => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:24px}</style>
        <h1>Hello, ${String(req.admin?.email ?? 'admin').replace(/[<>&"]/g, '')}</h1>
        <p>This page is served by the hello-world plugin inside a sandboxed iframe.</p>
        <p>Signups seen by this plugin: <strong>${(await ctx.kv.get('signups')) ?? 0}</strong></p>`,
    }),
  });

  await ctx.jobs.schedule('refresh-settings', 300, async () => {
    settings = (await ctx.settings.get()) ?? {};
  });

  // Unlock a feature for an allowlist of beta users without touching core code.
  await ctx.hooks.filter('entitlements.resolve', (entitlements, { subject }) => {
    const feature = settings.betaFeature && entitlements.features[settings.betaFeature];
    if (feature && subject?.type === 'user' && (settings.betaUsers ?? []).includes(subject.id)) {
      feature.enabled = true;
      feature.sources.push('plugin:hello-world');
    }
    return entitlements;
  });
}

export async function deactivate() {
  settings = {};
}
