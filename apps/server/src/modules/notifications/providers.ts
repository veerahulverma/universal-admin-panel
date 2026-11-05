import type { App } from '../../core/types.js';

/*
 * Push providers deliver notifications to customers' phones and apps (Firebase Cloud Messaging,
 * OneSignal...). They come from plugins, which register them through the plugin host; browser web
 * push is built in and needs none. The core decides who is notified and keeps the history, the
 * provider only delivers.
 */

export interface PushRecipient {
  userId: string;
  /** The customer's id in your application, when set. Providers may know customers by it. */
  externalId: string | null;
  /** Device tokens registered for this provider (empty for providers that target users). */
  devices: { id: string; token: string; platform: string }[];
}

/** One notification for one or more customers. */
export interface PushMessage {
  notificationId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  recipients: PushRecipient[];
}

export interface PushRecipientResult {
  userId: string;
  /** "skipped" means the provider had nothing to deliver to (no subscribed device). */
  status: 'sent' | 'failed' | 'skipped';
  error?: string | null;
  providerMessageId?: string | null;
  /** Devices the provider reports as no longer valid; they are removed. */
  invalidDeviceIds?: string[];
}

export interface PushProviderStatus {
  configured: boolean;
  message: string;
}

export interface PushProvider {
  key: string;
  name: string;
  description: string;
  /**
   * "users": the provider reaches a customer by id and maps ids to devices itself (OneSignal).
   * "devices": it needs device tokens your app registers through the client API (Firebase).
   */
  targets: 'users' | 'devices';
  status(): Promise<PushProviderStatus>;
  send(message: PushMessage): Promise<{ results: PushRecipientResult[] }>;
}

interface Registered {
  provider: PushProvider;
  owner: string;
  status?: PushProviderStatus & { checkedAt: number };
}

/** A provider's configuration is checked at most once a minute (it may live in a plugin process). */
const STATUS_TTL_MS = 60_000;
export const PROVIDER_KEY = /^[a-z][a-z0-9_-]{1,40}$/;

function registry(app: App): Map<string, Registered> {
  let map = app.services['push.providers'] as Map<string, Registered> | undefined;
  if (!map) app.services['push.providers'] = map = new Map();
  return map;
}

export function registerPushProvider(app: App, provider: PushProvider, owner: string): void {
  if (!PROVIDER_KEY.test(provider.key)) throw new Error(`Invalid push provider key "${provider.key}"`);
  const map = registry(app);
  const current = map.get(provider.key);
  if (current && current.owner !== owner) throw new Error(`Push provider "${provider.key}" is already registered by ${current.owner}`);
  map.set(provider.key, { provider, owner });
}

export function unregisterPushProviders(app: App, owner: string): void {
  const map = registry(app);
  for (const [key, r] of map) if (r.owner === owner) map.delete(key);
}

export function pushProvider(app: App, key: string): PushProvider | null {
  return registry(app).get(key)?.provider ?? null;
}

/** Every registered provider with whether it is configured. */
export async function pushProviders(app: App, opts: { fresh?: boolean } = {}): Promise<{ provider: PushProvider; owner: string; status: PushProviderStatus }[]> {
  const out = [];
  for (const r of registry(app).values()) {
    if (opts.fresh || !r.status || Date.now() - r.status.checkedAt > STATUS_TTL_MS) {
      let status: PushProviderStatus;
      try {
        status = await r.provider.status();
      } catch (err) {
        status = { configured: false, message: (err as Error).message };
      }
      r.status = { configured: Boolean(status?.configured), message: String(status?.message ?? ''), checkedAt: Date.now() };
    }
    out.push({ provider: r.provider, owner: r.owner, status: { configured: r.status.configured, message: r.status.message } });
  }
  return out;
}
