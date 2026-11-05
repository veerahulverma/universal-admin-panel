export type SequenceTrigger = 'signup' | 'purchase' | 'subscription_started' | 'renewal_upcoming' | 'subscription_ended';

export const TRIGGERS: { value: SequenceTrigger; label: string; description: string }[] = [
  { value: 'signup', label: 'Signs up', description: 'When someone creates an account (not people imported from a file or created from a support email)' },
  { value: 'purchase', label: 'Buys a product', description: 'When an order is paid' },
  { value: 'subscription_started', label: 'Starts a subscription', description: 'When a subscription starts, trials included' },
  { value: 'renewal_upcoming', label: 'Renewal is coming up', description: 'A set number of days before a paid subscription renews' },
  { value: 'subscription_ended', label: 'Subscription ends', description: 'When a subscription ends (paying off an installment plan does not count)' },
];

export const triggerLabel = (t: string) => TRIGGERS.find((x) => x.value === t)?.label ?? t;

/** Why an enrolment stopped early. */
export const STOP_REASONS: Record<string, string> = {
  no_consent: 'No marketing consent',
  unsubscribed: 'Unsubscribed',
  unsubscribe: 'Unsubscribed (address suppressed)',
  hard_bounce: 'Address bounced',
  complaint: 'Marked as spam',
  manual: 'Address suppressed by an administrator',
  inactive_recipient: 'Account deleted or banned',
  trigger_ended: 'Trigger no longer applies',
  customer_returned: 'Customer came back',
  stopped_by_admin: 'Stopped by an administrator',
};

export interface SequenceRow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  trigger_type: SequenceTrigger;
  product_ids: string[];
  days_before: number | null;
  created_at: string;
  updated_at: string;
  step_count: number;
  active_count: number;
  completed_count: number;
  stopped_count: number;
}

export interface StepRow {
  id: string;
  position: number;
  delay_minutes: number;
  template_key: string | null;
  subject: string;
  html: string;
  text: string | null;
  stats: { queued: number; suppressed: number; failed: number; opened: number; clicked: number };
}

export interface SequenceDetail extends Omit<SequenceRow, 'step_count' | 'active_count' | 'completed_count' | 'stopped_count'> {
  steps: StepRow[];
  enrollments: Partial<Record<'active' | 'completed' | 'stopped', number>>;
  stopReasons: { reason: string; count: number }[];
}

const UNITS = [
  { value: 'days', minutes: 24 * 60 },
  { value: 'hours', minutes: 60 },
  { value: 'minutes', minutes: 1 },
] as const;
export type DelayUnit = (typeof UNITS)[number]['value'];

/** 2880 -> { amount: 2, unit: 'days' }: the largest unit that divides the delay. */
export function splitDelay(minutes: number): { amount: number; unit: DelayUnit } {
  const unit = UNITS.find((u) => minutes % u.minutes === 0 && minutes >= u.minutes) ?? UNITS[2];
  return { amount: minutes / unit.minutes, unit: unit.value };
}

export const toMinutes = (amount: number, unit: DelayUnit) => Math.round(amount * (UNITS.find((u) => u.value === unit)?.minutes ?? 1));

export function describeDelay(minutes: number, first: boolean): string {
  if (minutes === 0) return first ? 'Right away' : 'Right after the previous email';
  const { amount, unit } = splitDelay(minutes);
  const label = `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
  return first ? `${label} after enrolment` : `${label} after the previous email`;
}
