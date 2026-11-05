import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, onReauthRequired } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field, FormError, Input, Modal } from './ui';

/**
 * Sensitive actions (role changes, refunds, key creation...) require a recent
 * re-authentication. When the server answers `reauth_required`, this dialog
 * asks for the password (+ 2FA code) and the original request is retried.
 */
export function ReauthDialog() {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    onReauthRequired(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setPassword('');
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => onReauthRequired(null);
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/reauth', { password, code: code || undefined });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && finish(false)}
      title="Confirm it's you"
      description="This action is sensitive. Re-enter your password to continue."
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <FormError message={error} />
        <Field label="Password" htmlFor="reauth-password">
          <Input id="reauth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
        </Field>
        {me?.admin.totpEnabled && (
          <Field label="Authenticator code" htmlFor="reauth-code">
            <Input id="reauth-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" required />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
