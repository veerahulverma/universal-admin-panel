import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Laptop, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import { Badge, Button, ButtonLink, Card, Field, KeyValue, Modal, PageHeader, PasswordInput, Skeleton, When, useConfirm } from '../../components/ui';

interface SessionRow {
  id: string;
  client: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export default function AccountPage() {
  const { me, refresh } = useAuth();
  const confirm = useConfirm();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<{ data: SessionRow[] }>('/api/admin/auth/sessions') });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const changePassword = useAction((body: { currentPassword: string; newPassword: string }) => api.post('/api/admin/auth/password', body), {
    success: 'Password changed. Your other sessions were signed out.',
    invalidate: [['my-sessions']],
    onSuccess: () => setPw({ currentPassword: '', newPassword: '', confirm: '' }),
  });
  const revoke = useAction((id: string) => api.delete(`/api/admin/auth/sessions/${id}`), { success: 'Session signed out', invalidate: [['my-sessions']] });
  const regenerate = useAction(() => api.post<{ recoveryCodes: string[] }>('/api/admin/auth/2fa/recovery-codes'), {
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      void refresh();
    },
  });
  const disable2fa = useAction(() => api.post('/api/admin/auth/2fa/disable'), { success: 'Two-factor authentication turned off', onSuccess: () => void refresh() });

  if (!me) return null;
  const a = me.admin;

  return (
    <>
      <PageHeader title="Account & security" description="Your profile, password, two-factor authentication and signed-in devices." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValue
            items={[
              { label: 'Name', value: a.name },
              { label: 'Email', value: a.email },
              { label: 'Roles', value: <span className="flex flex-wrap gap-1">{a.roles.map((r) => <Badge key={r.id}>{r.name}</Badge>)}</span> },
              { label: 'Access', value: a.orgScope ? `${a.orgScope.length} organization(s) only` : 'All organizations' },
              { label: 'Last sign-in', value: dateTime(a.lastLoginAt) },
            ]}
          />
        </Card>

        <Card title="Two-factor authentication">
          {a.totpEnabled ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="size-5 text-success" aria-hidden="true" />
                <span>Authenticator app is on. {a.recoveryCodesLeft} recovery code{a.recoveryCodesLeft === 1 ? '' : 's'} left.</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
                  New recovery codes
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  loading={disable2fa.isPending}
                  onClick={async () => {
                    const { confirmed } = await confirm({ title: 'Turn off two-factor authentication?', description: 'Your account will be protected by your password only.', confirmLabel: 'Turn off', tone: 'danger' });
                    if (confirmed) disable2fa.mutate();
                  }}
                >
                  Turn off
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm">
                <ShieldOff className="size-5 text-warning" aria-hidden="true" />
                <span>Not set up. Add an authenticator app to protect this administrator account.</span>
              </div>
              <ButtonLink to="/two-factor?return=/account" variant="primary" size="sm">
                Set up two-factor authentication
              </ButtonLink>
            </div>
          )}
        </Card>

        <Card title="Change password" description="Changing your password signs out your other sessions.">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pw.newPassword !== pw.confirm) return setPwError('The new passwords do not match');
              setPwError(null);
              changePassword.mutate({ currentPassword: pw.currentPassword, newPassword: pw.newPassword });
            }}
          >
            <Field label="Current password" htmlFor="pw-current">
              <PasswordInput id="pw-current" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required />
            </Field>
            <Field label="New password" htmlFor="pw-new">
              <PasswordInput id="pw-new" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required />
            </Field>
            <Field label="Confirm new password" htmlFor="pw-confirm" error={pwError}>
              <PasswordInput id="pw-confirm" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
            </Field>
            <Button type="submit" loading={changePassword.isPending}>
              Update password
            </Button>
          </form>
        </Card>

        <Card title="Signed-in devices" padded={false}>
          {sessions.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <ul className="divide-y">
              {(sessions.data?.data ?? []).map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  {s.client === 'mobile' ? <Smartphone className="size-5 text-muted-foreground" aria-hidden="true" /> : <Laptop className="size-5 text-muted-foreground" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {s.client === 'mobile' ? 'Mobile app' : describeAgent(s.user_agent)}
                      {s.current && <Badge tone="success">This device</Badge>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.ip ?? 'Unknown IP'} · active <When value={s.last_seen_at} />
                    </p>
                  </div>
                  {!s.current && (
                    <Button variant="outline" size="sm" onClick={() => revoke.mutate(s.id)} loading={revoke.isPending && revoke.variables === s.id}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={Boolean(codes)} onOpenChange={(o) => !o && setCodes(null)} title="New recovery codes" description="Your previous codes no longer work. Store these somewhere safe; they will not be shown again." footer={<Button onClick={() => setCodes(null)}>Done</Button>}>
        <ul className="grid grid-cols-2 gap-2 rounded-ui border bg-muted/50 p-3 font-mono text-sm">
          {codes?.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
