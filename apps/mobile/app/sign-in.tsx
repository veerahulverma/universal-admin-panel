import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { useAuth } from '../src/auth/AuthContext';
import { Button, Card, Field, Muted, Screen } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';
import { normalizeServerUrl } from '../src/lib/format';

/** Sign in, then complete two-factor verification (or enrollment when the policy requires it). */
export default function SignIn() {
  const { status } = useAuth();
  const { c } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Screen>
          <View style={{ marginTop: 32, marginBottom: 8, gap: 4 }}>
            <Text style={{ color: c.fg, fontSize: 28, fontWeight: '700' }}>Steward Admin</Text>
            <Muted>Manage your SaaS from anywhere.</Muted>
          </View>
          {status === 'mfa' ? <MfaStep /> : status === 'enroll' ? <EnrollStep /> : <CredentialsStep />}
        </Screen>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function CredentialsStep() {
  const { signIn, serverUrl } = useAuth();
  const { c } = useTheme();
  const [server, setServer] = useState(serverUrl ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) void SecureStore.getItemAsync('steward.server').then((s) => s && setServer(s));
  }, [serverUrl]);

  const submit = async () => {
    const url = normalizeServerUrl(server);
    if (!url) return setError('Enter your Steward server address, e.g. admin.example.com');
    setBusy(true);
    setError(null);
    try {
      await signIn(url, email.trim(), password);
      setPassword('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 14 }}>
      <Field label="Server" value={server} onChangeText={setServer} placeholder="admin.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={submit} />
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button title="Sign in" onPress={submit} loading={busy} disabled={!server || !email || !password} />
      <Muted>Production servers must use HTTPS. Your session token is kept in the device's secure storage.</Muted>
    </Card>
  );
}

function MfaStep() {
  const { verifyMfa, signOut } = useAuth();
  const { c } = useTheme();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(recovery ? { recoveryCode: code.trim() } : { code: code.trim() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 14 }}>
      <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Two-factor verification</Text>
      <Muted>{recovery ? 'Enter one of your recovery codes. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}</Muted>
      <Field
        label={recovery ? 'Recovery code' : 'Authentication code'}
        value={code}
        onChangeText={setCode}
        autoFocus
        keyboardType={recovery ? 'default' : 'number-pad'}
        autoCapitalize="none"
        autoComplete={recovery ? 'off' : 'one-time-code'}
        textContentType={recovery ? 'none' : 'oneTimeCode'}
        maxLength={recovery ? 20 : 6}
        onSubmitEditing={submit}
      />
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button title="Verify" onPress={submit} loading={busy} disabled={recovery ? code.trim().length < 8 : code.trim().length !== 6} />
      <Pressable onPress={() => setRecovery((r) => !r)} accessibilityRole="button">
        <Text style={{ color: c.accent, textAlign: 'center', padding: 8 }}>{recovery ? 'Use an authenticator code' : 'Use a recovery code'}</Text>
      </Pressable>
      <Button title="Cancel" variant="secondary" onPress={() => void signOut()} />
    </Card>
  );
}

/** The workspace requires 2FA and this admin has not enrolled yet: enroll right on the phone. */
function EnrollStep() {
  const { api, refreshMe, signOut } = useAuth();
  const { c } = useTheme();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.setupTotp());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes((await api.enableTotp(code.trim())).recoveryCodes);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Card style={{ gap: 12 }}>
        <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Save your recovery codes</Text>
        <Muted>They are shown only once. Each works one time if you lose your authenticator.</Muted>
        <Text selectable style={{ color: c.fg, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), lineHeight: 22 }}>
          {codes.join('\n')}
        </Text>
        <Button title="I saved them" onPress={() => void refreshMe()} />
      </Card>
    );
  }

  return (
    <Card style={{ gap: 14 }}>
      <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Set up two-factor authentication</Text>
      <Muted>Your organization requires an authenticator app for administrators.</Muted>
      {!setup ? (
        <Button title="Start setup" onPress={start} loading={busy} />
      ) : (
        <>
          <Button title="Open in authenticator app" variant="secondary" onPress={() => void Linking.openURL(setup.otpauthUrl).catch(() => setError('No authenticator app found; enter the key manually.'))} />
          <Muted>Or enter this key manually:</Muted>
          <Text selectable style={{ color: c.fg, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
            {setup.secret}
          </Text>
          <Field label="Code from the app" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" textContentType="oneTimeCode" />
          <Button title="Enable" onPress={enable} loading={busy} disabled={code.trim().length !== 6} />
        </>
      )}
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button title="Cancel" variant="secondary" onPress={() => void signOut()} />
    </Card>
  );
}
