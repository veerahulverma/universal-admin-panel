import { z } from 'zod';

export const emailSettingsSchema = z.object({
  /** Receives a copy of every admin notification, and is the sender when no outgoing address is set. */
  adminEmail: z.string().email().or(z.literal('')),
  /** Shown on hosted pages (payment, unsubscribe) to people who need help; empty uses the admin address. */
  technicalEmail: z.string().email().or(z.literal('')),
  /** The From address of customer email; empty uses the admin address. A provider's own address takes precedence. */
  defaultFromEmail: z.string().email().or(z.literal('')),
  /** Sender name shown in the inbox; empty uses the application name. */
  fromName: z.string().trim().max(100),
  /** Turn outgoing email off: messages are recorded as not sent. Test sends still go out. */
  sendingDisabled: z.boolean(),
  /** Send at most this many emails a minute (0 = no limit), for providers or hosts that cap the rate. */
  throttlePerMinute: z.number().int().min(0).max(100_000),
  /** Unsubscribe links in optional notifications (usage alerts, reminders). Marketing email always has one. */
  notificationUnsubscribeLinks: z.boolean(),
  /** More addresses that receive a copy of every admin notification. */
  adminNotificationCopies: z.array(z.string().trim().email()).max(10),
  defaultLocale: z.string().min(2).max(10),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #4f46e5'),
  footerText: z.string().max(500),
  maxAttempts: z.number().int().min(1).max(20),
  /** Outside production, deliver to the log when no provider is configured. */
  devLogFallback: z.boolean(),
  autoReceipts: z.boolean(),
  autoPaymentFailed: z.boolean(),
  autoTrialEnding: z.boolean(),
  autoSubscriptionCanceled: z.boolean(),
  autoUsageAlerts: z.boolean(),
  autoCheckoutRecovery: z.boolean(),
  /** Where abandoned-checkout emails send people (your pricing page). Defaults to the app URL. */
  checkoutRecoveryUrl: z.string().url().or(z.literal('')),
  /** Welcome new users when they sign up. Off by default: your application may already send one. */
  autoWelcome: z.boolean(),
  /** Registration sources that are not signups: no welcome email and no signup autoresponders. CSV imports are always excluded. */
  signupExcludedSources: z.array(z.string().trim().min(1).max(100)).max(20),
  /** Remind customers before a paid subscription renews. */
  autoRenewalReminder: z.boolean(),
  renewalReminderDays: z.number().int().min(1).max(60),
  /** Tell customers before access ends (a cancelled subscription's last period, a time-limited grant) and when a grant has ended. */
  autoExpiryNotices: z.boolean(),
  /** How many days ahead the "access ending" notice goes out; 0 sends only the notice once access has ended. */
  expiryReminderDays: z.number().int().min(0).max(60),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export const emailSettingsDefaults: EmailSettings = {
  adminEmail: '',
  technicalEmail: '',
  defaultFromEmail: '',
  fromName: '',
  sendingDisabled: false,
  throttlePerMinute: 0,
  notificationUnsubscribeLinks: true,
  adminNotificationCopies: [],
  defaultLocale: 'en',
  brandColor: '#4f46e5',
  footerText: '',
  maxAttempts: 5,
  devLogFallback: true,
  autoReceipts: true,
  autoPaymentFailed: true,
  autoTrialEnding: true,
  autoSubscriptionCanceled: true,
  autoUsageAlerts: true,
  autoCheckoutRecovery: true,
  checkoutRecoveryUrl: '',
  autoWelcome: false,
  signupExcludedSources: ['support_email'],
  autoRenewalReminder: false,
  renewalReminderDays: 7,
  autoExpiryNotices: false,
  expiryReminderDays: 7,
};
