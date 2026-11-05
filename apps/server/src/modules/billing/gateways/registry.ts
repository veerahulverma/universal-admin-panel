import type { App } from '../../../core/types.js';
import type { Db } from '../../../core/db.js';
import { sql } from '../../../core/sql.js';
import { AppError, notFound } from '../../../core/errors.js';
import type { GatewayAdapter, GatewayContext } from './types.js';

export interface GatewayRow {
  id: string;
  adapter: string;
  name: string;
  mode: 'test' | 'live';
  enabled: boolean;
  is_default: boolean;
  priority: number;
  config: Record<string, any>;
  currencies: string[] | null;
}

export function adapters(app: App): Map<string, { adapter: GatewayAdapter; owner: string }> {
  let map = app.services['billing.adapters'] as Map<string, { adapter: GatewayAdapter; owner: string }> | undefined;
  if (!map) {
    map = new Map();
    app.services['billing.adapters'] = map;
  }
  return map;
}

/** Gateway plugins call this (through the plugin context) to make their adapter available. */
export function registerGatewayAdapter(app: App, adapter: GatewayAdapter, owner = 'core'): void {
  adapters(app).set(adapter.key, { adapter, owner });
}

export function unregisterGatewayAdapters(app: App, owner: string): void {
  for (const [key, entry] of adapters(app)) if (entry.owner === owner) adapters(app).delete(key);
}

export function adapterFor(app: App, key: string): GatewayAdapter {
  const entry = adapters(app).get(key);
  if (!entry) throw new AppError(503, 'gateway_unavailable', `The "${key}" gateway plugin is not installed or not active`);
  return entry.adapter;
}

export function supportsCurrency(adapter: GatewayAdapter, row: Pick<GatewayRow, 'currencies'>, currency: string): boolean {
  const list = row.currencies ?? adapter.capabilities.currencies;
  return list === '*' || list.includes(currency.toUpperCase());
}

export async function gatewayContext(db: Db, app: App, row: GatewayRow): Promise<GatewayContext> {
  const fetchImpl = (app.services['billing.fetch'] as typeof fetch | undefined) ?? fetch;
  return {
    gatewayId: row.id,
    mode: row.mode,
    config: row.config,
    secrets: await app.secrets.getAll(db, 'gateway', row.id),
    appUrl: app.config.appUrl,
    webhookUrl: `${app.config.appUrl}/api/public/gateways/${row.id}/webhook`,
    returnUrl: `${app.config.appUrl}/api/public/gateways/${row.id}/return`,
    fetch: fetchImpl,
    log: app.log,
  };
}

export async function loadGateway(db: Db, app: App, id: string): Promise<{ row: GatewayRow; adapter: GatewayAdapter; ctx: GatewayContext }> {
  const row = await db.maybe<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE id = ${id}`);
  if (!row) throw notFound('Payment gateway');
  const adapter = adapterFor(app, row.adapter);
  return { row, adapter, ctx: await gatewayContext(db, app, row) };
}

/** Choose a gateway for a checkout: the requested one, else the default/highest-priority one that supports the currency. */
export async function pickGateway(db: Db, app: App, currency: string, requestedId?: string | null): Promise<GatewayRow> {
  const rows = await db.many<GatewayRow>(sql`SELECT * FROM payment_gateways WHERE enabled ORDER BY is_default DESC, priority DESC, created_at`);
  const usable = rows.filter((r) => {
    const entry = adapters(app).get(r.adapter);
    return entry && entry.adapter.capabilities.checkout && supportsCurrency(entry.adapter, r, currency);
  });
  if (requestedId) {
    const chosen = usable.find((r) => r.id === requestedId || r.adapter === requestedId);
    if (!chosen) throw new AppError(422, 'gateway_unsupported', `That payment method is not available for ${currency}`);
    return chosen;
  }
  if (!usable.length) throw new AppError(503, 'no_gateway', `No payment gateway is configured for ${currency}`);
  return usable[0];
}
