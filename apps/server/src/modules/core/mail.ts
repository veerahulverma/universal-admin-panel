import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';

export interface SystemEmail {
  to: string;
  /** Template key, e.g. `admin.invitation`. */
  template: string;
  data: Record<string, unknown>;
  userId?: string | null;
  locale?: string | null;
  category?: 'transactional' | 'security' | 'billing' | 'marketing';
  /** Org whose branding should be used. */
  orgId?: string | null;
}

export type SendEmailFn = (db: Db, email: SystemEmail) => Promise<{ id: string | null; suppressed?: boolean }>;

/**
 * Queue a templated email through the email module. When that module is
 * disabled the platform keeps working: the send is skipped and logged, and
 * callers that need it (invites, resets) surface links in the admin UI instead.
 */
export async function sendSystemEmail(app: App, db: Db, email: SystemEmail): Promise<boolean> {
  const fn = app.services['email.send'] as SendEmailFn | undefined;
  if (!fn || !app.modules.isEnabled('email')) {
    app.log.info({ to: email.to, template: email.template }, 'email module unavailable; message not sent');
    return false;
  }
  await fn(db, email);
  return true;
}
