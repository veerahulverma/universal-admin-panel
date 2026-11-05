import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { Button, Callout, Field, FormError, Input, PasswordInput, Spinner } from '../../components/ui';
import { AuthCard } from './AuthLayout';

export default function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const invite = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<{ email: string; expiresAt: string }>('/api/admin/invitations/lookup', { token }),
    enabled: token.length > 0,
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token || invite.isError) {
    return (
      <AuthCard title="Invitation unavailable" footer={<Link to="/login">Go to sign in</Link>}>
        <Callout tone="warning" title="This invitation link is invalid or has expired">
          Ask the administrator who invited you to send a new invitation.
        </Callout>
      </AuthCard>
    );
  }
  if (invite.isLoading) return <Spinner className="size-6" />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/invitations/accept', { token, name, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Join the team" description={<>You were invited as <strong className="text-foreground">{invite.data?.email}</strong>. The invitation expires {dateTime(invite.data?.expiresAt)}.</>}>
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Your name" htmlFor="inv-name">
          <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required autoFocus />
        </Field>
        <Field label="Choose a password" htmlFor="inv-password">
          <PasswordInput id="inv-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm password" htmlFor="inv-confirm">
          <PasswordInput id="inv-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Create my account
        </Button>
      </form>
    </AuthCard>
  );
}
