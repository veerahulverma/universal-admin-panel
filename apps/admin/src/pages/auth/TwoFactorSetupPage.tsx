import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Download } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { safeNext } from '../../lib/page';
import { Button, Callout, Checkbox, CopyButton, Field, FormError, Input, Spinner } from '../../components/ui';
import { AuthCard } from './AuthLayout';

interface SetupData {
  secret: string;
  otpauthUrl: string;
  qrCode: string;
}

/** TOTP enrollment: required by policy after sign-in, or started from Account & security. */
export default function TwoFactorSetupPage() {
  const { me, loading, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const back = safeNext(params.get('return'));
  const [setup, setSetup] = useState<SetupData | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!me || me.admin.totpEnabled || started.current) return;
    started.current = true; // each call issues a new pending secret, so start exactly once
    api.post<SetupData>('/api/admin/auth/2fa/setup').then(setSetup, (err) => setError(errorMessage(err)));
  }, [me]);

  if (loading) return <Spinner className="size-6" />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.admin.totpEnabled && !codes) return <Navigate to={back} replace />;

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/api/admin/auth/2fa/enable', { code: code.replace(/\s/g, '') });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await refresh();
    navigate(back, { replace: true });
  };

  if (codes) {
    const text = codes.join('\n');
    return (
      <AuthCard title="Save your recovery codes" description="Each code works once if you lose access to your authenticator. They will not be shown again.">
        <div className="space-y-4">
          <ul className="grid grid-cols-2 gap-2 rounded-ui border bg-muted/50 p-3 font-mono text-sm">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<Download className="size-4" />}
              onClick={() => {
                const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
                const a = Object.assign(document.createElement('a'), { href: url, download: 'recovery-codes.txt' });
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download
            </Button>
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <CopyButton value={text} label="Copy codes" /> Copy
            </span>
          </div>
          <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} label="I have stored these codes somewhere safe" />
          <Button className="w-full" disabled={!saved} onClick={() => void finish()}>
            Continue
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set up two-factor authentication"
      description={me.session.enrollmentRequired ? 'Your organization requires an authenticator app for administrator accounts.' : 'Protect your account with an authenticator app.'}
      footer={
        me.session.enrollmentRequired ? (
          <button type="button" className="hover:text-foreground" onClick={() => void logout().then(() => navigate('/login'))}>
            Sign out
          </button>
        ) : (
          <button type="button" className="hover:text-foreground" onClick={() => navigate(back)}>
            Cancel
          </button>
        )
      }
    >
      {!setup && !error ? (
        <div className="flex justify-center py-8">
          <Spinner className="size-6" />
        </div>
      ) : (
        <form onSubmit={enable} className="space-y-4">
          <FormError message={error} />
          {setup && (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator...).</li>
                <li>Enter the 6-digit code it shows.</li>
              </ol>
              <div className="flex justify-center">
                <img src={setup.qrCode} alt="QR code for your authenticator app" className="size-44 rounded-ui border bg-white p-2" />
              </div>
              <Callout title="Can't scan?">
                <span className="inline-flex flex-wrap items-center gap-1">
                  Enter this key manually: <code className="break-all font-mono text-xs text-foreground">{setup.secret}</code>
                  <CopyButton value={setup.secret} label="Copy key" />
                </span>
              </Callout>
              <Field label="Code from the app" htmlFor="totp-code">
                <Input id="totp-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="text-center font-mono tracking-widest" required autoFocus />
              </Field>
              <Button type="submit" className="w-full" loading={busy}>
                Turn on two-factor authentication
              </Button>
            </>
          )}
        </form>
      )}
    </AuthCard>
  );
}
