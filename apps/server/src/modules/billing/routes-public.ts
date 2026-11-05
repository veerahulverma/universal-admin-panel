import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import { sql } from '../../core/sql.js';
import { AppError, notFound } from '../../core/errors.js';
import { escapeHtml } from '../../core/template.js';
import { newId, randomBase62 } from '../../core/ids.js';
import { adapterFor, gatewayContext, type GatewayRow } from './gateways/registry.js';
import { WebhookSignatureError } from './gateways/types.js';
import { signSandboxEvent, SANDBOX_DECLINE_METHOD } from './gateways/sandbox.js';
import { createInvoiceCheckout, payToken, processGatewayEvents, verifyPayToken } from './checkout.js';
import { formatMoney } from './money.js';
import { helpLine } from '../email/pages.js';

/** Minimal, self-contained branded page for hosted payment flows (no scripts). */
function page(app: App, title: string, body: string): string {
  const name = escapeHtml(app.settings.get('general').appName);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${name}</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5d6470;--border:#e3e6eb;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--fg:#eceef2;--muted:#9aa1ad;--border:#2a2f37}}
body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.amount{font-size:30px;font-weight:650;margin:16px 0}
button,.btn{display:block;width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);font:inherit;font-weight:600;cursor:pointer;margin-top:10px;text-align:center;text-decoration:none;box-sizing:border-box}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}pre{white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border)}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:#fef3c7;color:#92400e}
</style></head><body><main class="card">${body}<p class="muted" style="font-size:12px;margin-top:24px">${name}</p>${helpLine(app)}</main></body></html>`;
}

function html(reply: FastifyReply, content: string, status = 200) {
  return reply.status(status).type('text/html; charset=utf-8').header('x-frame-options', 'DENY').send(content);
}

function safeRedirect(url: string | null | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

export function registerPublicBillingRoutes(r: Router, app: App): void {
  r.route({
    method: 'POST',
    url: '/api/public/gateways/:id/webhook',
    auth: 'public',
    summary: 'Payment gateway webhook receiver',
    description: 'Configure this URL in your gateway dashboard. Signatures are verified by the gateway plugin; events are processed exactly once.',
    tags: ['Webhooks'],
    params: z.object({ id: z.string() }),
    bodyLimit: 2 * 1024 * 1024,
    handler: async (c) => {
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Payment gateway');
      const adapter = adapterFor(app, row.adapter);
      let events;
      try {
        events = await adapter.parseWebhook(await gatewayContext(app.db, app, row), {
          rawBody: c.req.rawBody ?? '',
          headers: c.req.headers as Record<string, string | string[] | undefined>,
          query: c.req.query as Record<string, string>,
        });
      } catch (err) {
        if (err instanceof WebhookSignatureError) throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
        throw err;
      }
      const result = await processGatewayEvents(app, row.id, events);
      return { received: true, ...result };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/public/gateways/:id/return',
    auth: 'public',
    hidden: true,
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.id}`);
      if (!row) throw notFound('Payment gateway');
      const adapter = adapterFor(app, row.adapter);
      const query = c.req.query as Record<string, string>;
      let checkoutId = query.checkout ?? null;
      if (adapter.handleReturn) {
        const result = await adapter.handleReturn(await gatewayContext(app.db, app, row), query);
        checkoutId = result.checkoutId ?? checkoutId;
        if (result.events.length) await processGatewayEvents(app, row.id, result.events);
      }
      const chk = checkoutId ? await app.db.maybe<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${checkoutId}`) : null;
      if (!chk) return html(c.reply, page(app, 'Payment', '<h1>Thanks!</h1><p class="muted">You can close this window.</p>'));
      const done = chk.status === 'completed';
      const fallback = `${app.config.appUrl}/pay/complete/${chk.id}?token=${payToken(app, chk.id)}`;
      return c.reply.redirect(safeRedirect(done ? chk.success_url : chk.cancel_url, fallback), 303);
    },
  });

  // ---- Hosted pages ----------------------------------------------------------------------
  r.route({
    method: 'GET',
    url: '/pay/complete/:id',
    auth: 'public',
    hidden: true,
    params: z.object({ id: z.string() }),
    query: z.object({ token: z.string().optional() }),
    handler: async (c) => {
      if (!verifyPayToken(app, c.params.id, c.query.token)) throw notFound('Checkout');
      const chk = await app.db.maybe<any>(sql`SELECT status, total, currency FROM checkout_sessions WHERE id = ${c.params.id}`);
      if (!chk) throw notFound('Checkout');
      const ok = chk.status === 'completed';
      return html(c.reply, page(app, ok ? 'Payment complete' : 'Payment pending', ok
        ? `<h1>Payment complete</h1><p class="muted">Thank you. A receipt for ${escapeHtml(formatMoney(chk.total, chk.currency))} is on its way.</p>`
        : `<h1>Payment not completed</h1><p class="muted">Status: ${escapeHtml(chk.status)}. You can safely try again.</p>`));
    },
  });

  r.route({
    method: 'GET',
    url: '/pay/invoice/:id',
    auth: 'public',
    hidden: true,
    params: z.object({ id: z.string() }),
    query: z.object({ token: z.string().optional(), gateway: z.string().optional() }),
    handler: async (c) => {
      if (!verifyPayToken(app, c.params.id, c.query.token)) throw notFound('Invoice');
      const inv = await app.db.maybe<any>(sql`SELECT * FROM invoices WHERE id = ${c.params.id}`);
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'open') {
        return html(c.reply, page(app, `Invoice ${inv.number}`, `<h1>Invoice ${escapeHtml(inv.number)}</h1><p class="muted">This invoice is ${escapeHtml(inv.status)}.</p>`));
      }
      const { url } = await app.db.tx((tx) => createInvoiceCheckout(tx, app, inv.id, { gatewayId: c.query.gateway }));
      return c.reply.redirect(url, 303);
    },
  });

  r.route({
    method: 'GET',
    url: '/pay/manual/:gatewayId/:checkoutId',
    auth: 'public',
    hidden: true,
    params: z.object({ gatewayId: z.string(), checkoutId: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.gatewayId} AND adapter = 'manual'`);
      const chk = await app.db.maybe<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${c.params.checkoutId} AND gateway_id = ${c.params.gatewayId}`);
      if (!row || !chk) throw notFound('Checkout');
      const reference = chk.invoice_id ?? chk.id;
      return html(c.reply, page(app, 'Bank transfer', `
        <h1>Pay by bank transfer</h1>
        <div class="amount">${escapeHtml(formatMoney(chk.total, chk.currency))}</div>
        <p>${escapeHtml(row.config.instructions ?? '')}</p>
        ${row.config.bankDetails ? `<pre>${escapeHtml(row.config.bankDetails)}</pre>` : ''}
        <p>Payment reference: <strong>${escapeHtml(reference)}</strong></p>
        <p class="muted">Access is activated once your payment is confirmed.</p>`));
    },
  });

  r.route({
    method: 'GET',
    url: '/pay/sandbox/:gatewayId/:checkoutId',
    auth: 'public',
    hidden: true,
    params: z.object({ gatewayId: z.string(), checkoutId: z.string() }),
    handler: async (c) => {
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.gatewayId} AND adapter = 'sandbox'`);
      const chk = await app.db.maybe<any>(sql`SELECT ch.*, p.name AS product_name FROM checkout_sessions ch LEFT JOIN products p ON p.id = ch.product_id WHERE ch.id = ${c.params.checkoutId} AND ch.gateway_id = ${c.params.gatewayId}`);
      if (!row || !chk) throw notFound('Checkout');
      if (chk.status !== 'open') return html(c.reply, page(app, 'Checkout', `<h1>Checkout ${escapeHtml(chk.status)}</h1>`));
      const token = payToken(app, chk.id);
      const action = `/pay/sandbox/${escapeHtml(row.id)}/${escapeHtml(chk.id)}`;
      return html(c.reply, page(app, 'Test checkout', `
        <span class="badge">Sandbox · no real money</span>
        <h1 style="margin-top:12px">${escapeHtml(chk.product_name ?? 'Invoice payment')}</h1>
        <div class="amount">${escapeHtml(formatMoney(chk.total, chk.currency))}</div>
        <form method="post" action="${action}"><input type="hidden" name="token" value="${token}"><input type="hidden" name="outcome" value="success"><button class="primary" type="submit">Pay with test card 4242</button></form>
        <form method="post" action="${action}"><input type="hidden" name="token" value="${token}"><input type="hidden" name="outcome" value="decline"><button type="submit">Use a declining card</button></form>
        ${chk.cancel_url ? `<a class="btn" href="${escapeHtml(chk.cancel_url)}">Cancel</a>` : ''}`));
    },
  });

  r.route({
    method: 'POST',
    url: '/pay/sandbox/:gatewayId/:checkoutId',
    auth: 'public',
    hidden: true,
    params: z.object({ gatewayId: z.string(), checkoutId: z.string() }),
    body: z.object({ token: z.string(), outcome: z.enum(['success', 'decline']) }),
    handler: async (c) => {
      if (!verifyPayToken(app, c.params.checkoutId, c.body.token)) throw notFound('Checkout');
      const row = await app.db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${c.params.gatewayId} AND adapter = 'sandbox' AND mode = 'test'`);
      const chk = await app.db.maybe<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${c.params.checkoutId} AND gateway_id = ${c.params.gatewayId}`);
      if (!row || !chk) throw notFound('Checkout');
      const secret = (await app.secrets.get(app.db, 'gateway', row.id, 'webhook_secret')) ?? '';
      const event =
        c.body.outcome === 'success'
          ? { type: 'payment.succeeded' as const, eventId: `sbx_evt_${randomBase62(16)}`, checkoutId: chk.id, gatewayPaymentId: `sbx_pi_${randomBase62(16)}`, amount: chk.total, currency: chk.currency, method: { type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: app.clock.now().getUTCFullYear() + 3 }, customerRef: `sbx_cus_${chk.subject_id}`, paymentMethodRef: `pm_sandbox_${newId('x').slice(-10)}` }
          : { type: 'payment.failed' as const, eventId: `sbx_evt_${randomBase62(16)}`, checkoutId: chk.id, failureCode: 'card_declined', failureMessage: `Your card was declined (sandbox ${SANDBOX_DECLINE_METHOD})` };
      // Go through the same signature-verified path a real gateway webhook uses.
      const signed = signSandboxEvent(secret, event);
      const events = await adapterFor(app, 'sandbox').parseWebhook(await gatewayContext(app.db, app, row), {
        rawBody: signed.body,
        headers: { 'x-sandbox-signature': signed.signature },
        query: {},
      });
      await processGatewayEvents(app, row.id, events);
      const fresh = await app.db.one<any>(sql`SELECT * FROM checkout_sessions WHERE id = ${chk.id}`);
      const fallback = `${app.config.appUrl}/pay/complete/${chk.id}?token=${payToken(app, chk.id)}`;
      return c.reply.redirect(safeRedirect(fresh.status === 'completed' ? fresh.success_url : fresh.cancel_url, fallback), 303);
    },
  });
}
