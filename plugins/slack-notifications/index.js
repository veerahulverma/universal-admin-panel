const money = (minor, currency) => `${(minor / 100).toFixed(2)} ${currency}`;

export async function activate(ctx) {
  const post = async (text) => {
    const url = await ctx.secrets.get('webhook_url');
    if (!url) return ctx.log.warn('Slack webhook URL is not configured');
    const res = await ctx.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (res.status >= 300) await ctx.log.error(`Slack responded ${res.status}`, { body: res.body });
  };
  const enabled = async (key) => ((await ctx.settings.get()) ?? {})[key] !== false;

  await ctx.events.on('payment.succeeded', async (e) => {
    if (await enabled('notifyPayments')) await post(`:moneybag: Payment received: ${money(e.data.amount, e.data.currency)}`);
  });
  await ctx.events.on('subscription.canceled', async (e) => {
    if (await enabled('notifyCancellations')) await post(`:wave: Subscription ${e.data.subscriptionId} cancelled${e.data.reason ? ` (${e.data.reason})` : ''}`);
  });
  await ctx.events.on('security.alert', async (e) => {
    if (await enabled('notifySecurity')) await post(`:rotating_light: Security alert: ${e.data.type} (${e.data.severity})`);
  });
}
