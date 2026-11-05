import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorMessage } from '../../lib/api';
import { Button, Callout, Field, FormError, Input } from '../../components/ui';
import { AuthCard } from './AuthLayout';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>('/api/admin/auth/forgot-password', { email });
      setSent(res.message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" description="We will email you a link to choose a new password." footer={<Link to="/login" className="hover:text-foreground">Back to sign in</Link>}>
      {sent ? (
        <Callout tone="success" title="Check your inbox">
          {sent}
        </Callout>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError message={error} />
          <Field label="Email" htmlFor="forgot-email">
            <Input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
