import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { safeNext } from '../../lib/page';
import { Button, Field, FormError, Input, PasswordInput } from '../../components/ui';
import { AuthCard } from './AuthLayout';

type LoginResult = { status: 'ok' | 'mfa_required' | 'mfa_enrollment_required'; csrfToken: string };

export default function LoginPage() {
  const { me, refresh, logout } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me && !me.session.mfaRequired) return <Navigate to={me.session.enrollmentRequired ? '/two-factor' : next} replace />;
  const mfaStep = Boolean(me?.session.mfaRequired);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post<LoginResult>('/api/admin/auth/login', { email, password, client: 'web' }, { quiet401: true });
      setPassword('');
      // The session (full, MFA-pending or enrollment-pending) decides where to go next.
      await refresh();
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const value = code.trim();
      await api.post('/api/admin/auth/mfa', useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, '') }, { quiet401: true });
      await refresh();
    });
  };

  if (mfaStep) {
    return (
      <AuthCard title="Two-factor authentication" description={useRecovery ? 'Enter one of your saved recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}>
        <form onSubmit={verify} className="space-y-4">
          <FormError message={error} />
          <Field label={useRecovery ? 'Recovery code' : 'Authentication code'} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={useRecovery ? 'xxxxx-xxxxx' : '123 456'}
              autoFocus
              required
              className="text-center font-mono tracking-widest"
            />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Verify
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => void logout()}>
              Cancel
            </button>
          </div>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in" description="Administration console" footer={<Link to="/forgot-password" className="hover:text-foreground">Forgot your password?</Link>}>
      <form onSubmit={signIn} className="space-y-4">
        <FormError message={error} />
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Field>
        <Field label="Password" htmlFor="password">
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
