import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Field, FormError, Input, PasswordInput, Spinner } from '../../components/ui';
import { AuthCard } from './AuthLayout';

/** First run: create the initial super administrator with the one-time setup token. */
export default function SetupPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/api/admin/setup/status') });
  const [form, setForm] = useState({ setupToken: '', name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;
  if (status.isLoading) return <Spinner className="size-6" />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('The passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/setup', { setupToken: form.setupToken.trim(), name: form.name, email: form.email, password: form.password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set up your console" description="Create the first administrator account. It receives full access.">
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Setup token" htmlFor="setup-token" hint="Printed in the server log on first start, or the SETUP_TOKEN environment variable.">
          <Input id="setup-token" value={form.setupToken} onChange={set('setupToken')} autoComplete="off" className="font-mono" required autoFocus />
        </Field>
        <Field label="Your name" htmlFor="setup-name">
          <Input id="setup-name" value={form.name} onChange={set('name')} autoComplete="name" required />
        </Field>
        <Field label="Email" htmlFor="setup-email">
          <Input id="setup-email" type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
        </Field>
        <Field label="Password" htmlFor="setup-password">
          <PasswordInput id="setup-password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password" htmlFor="setup-confirm">
          <PasswordInput id="setup-confirm" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Create administrator
        </Button>
      </form>
    </AuthCard>
  );
}
