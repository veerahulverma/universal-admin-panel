export interface PushProviderInfo {
  key: string;
  name: string;
  description: string;
  /** "users": reaches customers by id; "devices": needs app device tokens. */
  targets: 'users' | 'devices';
  plugin: string | null;
  configured: boolean;
  message: string;
  devices: number;
}

export interface PushOverview {
  pushEnabled: boolean;
  browsers: { subscriptions: number; customers: number };
  devices: { provider: string; devices: number; customers: number }[];
  providers: PushProviderInfo[];
}

export type Audience = { type: 'all' } | { type: 'segment'; segmentId: string } | { type: 'product'; productId: string };

export interface PushCampaign {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  kind: 'announcement' | 'marketing';
  audience: Audience;
  audienceLabel: string;
  status: 'scheduled' | 'sending' | 'sent' | 'canceled' | 'failed';
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  recipients: number;
  createdAt: string;
  stats: { notified: number; read: number; pushSent: number; pushFailed: number; pushPending: number };
}

export interface PushChannels {
  pushEnabled: boolean;
  browsers: { id: string; userAgent: string | null; failureCount: number; lastSuccessAt: string | null; createdAt: string }[];
  devices: { id: string; provider: string; platform: string; failureCount: number; lastSuccessAt: string | null; createdAt: string }[];
  providers: { key: string; name: string; targets: 'users' | 'devices' }[];
}

export const SEVERITIES = [
  { value: 'info', label: 'Information' },
  { value: 'success', label: 'Good news' },
  { value: 'warning', label: 'Needs attention' },
  { value: 'critical', label: 'Urgent' },
];

/** A short, readable browser name from a user agent. */
export function browserName(userAgent: string | null): string {
  if (!userAgent) return 'Browser';
  const ua = userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
