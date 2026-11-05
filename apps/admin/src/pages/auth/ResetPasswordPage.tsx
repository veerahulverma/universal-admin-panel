import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { Button, ButtonLink, Callout, Field, FormError, PasswordInput } from '../../components/ui';
import { AuthCard } from './AuthLayout';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard title="Reset link missing" footer={<Link to="/forgot-password">Request a new link</Link>}>
        <Callout tone="warning">Open the link from the password reset email.</Callout>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" description="Other sessions are signed out once the password changes.">
      {done ? (
        <div className="space-y-4">
          <Callout tone="success" title="Password updated">
            You can now sign in with your new password.
          </Callout>
          <ButtonLink to="/login" variant="primary" className="w-full">
            Sign in
          </ButtonLink>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError message={error} />
          <Field label="New password" htmlFor="reset-password">
            <PasswordInput id="reset-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required autoFocus />
          </Field>
          <Field label="Confirm password" htmlFor="reset-confirm">
            <PasswordInput id="reset-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Update password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
