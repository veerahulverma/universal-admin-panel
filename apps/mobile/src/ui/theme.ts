import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  card: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  accentFg: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  soft: string;
}

const light: Palette = {
  bg: '#f5f6f8',
  card: '#ffffff',
  fg: '#14161a',
  muted: '#5d6470',
  border: '#e2e5ea',
  accent: '#4f46e5',
  accentFg: '#ffffff',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  info: '#1d4ed8',
  soft: '#eef0f4',
};

const dark: Palette = {
  bg: '#0d0f12',
  card: '#16191e',
  fg: '#eceef2',
  muted: '#9aa1ad',
  border: '#2a2f37',
  accent: '#818cf8',
  accentFg: '#0d0f12',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
  info: '#60a5fa',
  soft: '#1f242b',
};

export function useTheme(): { c: Palette; dark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { c: isDark ? dark : light, dark: isDark };
}

/** Badge tone for common statuses across users, subscriptions, payments and alerts. */
export function toneFor(status: string): 'success' | 'warning' | 'danger' | 'info' | 'muted' {
  switch (status) {
    case 'active':
    case 'succeeded':
    case 'paid':
    case 'resolved':
    case 'trialing':
      return status === 'trialing' ? 'info' : 'success';
    case 'past_due':
    case 'suspended':
    case 'pending':
    case 'partially_refunded':
    case 'warning':
    case 'acknowledged':
    case 'paused':
      return 'warning';
    case 'banned':
    case 'failed':
    case 'canceled':
    case 'unpaid':
    case 'disputed':
    case 'critical':
    case 'open':
      return 'danger';
    case 'info':
    case 'refunded':
      return 'info';
    default:
      return 'muted';
  }
}
