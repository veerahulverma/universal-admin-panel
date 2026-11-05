import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Text, View, Modal } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AdminApi, ApiError, type Me } from '../lib/api';
import { can as canPermission } from '../lib/permissions';
import { Button, Card, Field } from '../ui/components';
import { useTheme } from '../ui/theme';

export type AuthStatus = 'loading' | 'signed_out' | 'locked' | 'mfa' | 'enroll' | 'signed_in' | 'error';

const KEYS = { server: 'steward.server', token: 'steward.token', biometric: 'steward.biometric' } as const;
/** Re-lock with biometrics after this long in the background. */
const LOCK_AFTER_MS = 2 * 60_000;

interface AuthValue {
  status: AuthStatus;
  serverUrl: string | null;
  me: Me | null;
  api: AdminApi;
  error: string | null;
  biometric: { available: boolean; enabled: boolean };
  signIn(serverUrl: string, email: string, password: string): Promise<void>;
  verifyMfa(input: { code?: string; recoveryCode?: string }): Promise<void>;
  /** After TOTP enrollment the session is fully authenticated. */
  refreshMe(): Promise<void>;
  unlock(): Promise<boolean>;
  retry(): Promise<void>;
  signOut(): Promise<void>;
  setBiometricEnabled(enabled: boolean): Promise<void>;
  can(permission: string): boolean;
  /** Run a sensitive action; if the server asks for re-authentication, prompt and retry once. */
  withReauth<T>(fn: () => Promise<T>): Promise<T>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [biometric, setBiometric] = useState({ available: false, enabled: false });
  const [reauth, setReauth] = useState<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const backgroundedAt = useRef<number | null>(null);

  const clearSession = useCallback(async () => {
    await SecureStore.deleteItemAsync(KEYS.token);
    apiRef.current.setToken(null);
    setMe(null);
    setStatus('signed_out');
  }, []);

  const apiRef = useRef<AdminApi>(new AdminApi('https://invalid.local', null));
  const makeApi = useCallback(
    (url: string, token: string | null) => {
      apiRef.current = new AdminApi(url, token, () => {
        void clearSession();
      });
      return apiRef.current;
    },
    [clearSession],
  );

  const loadMe = useCallback(async () => {
    try {
      const profile = await apiRef.current.me();
      setMe(profile);
      setError(null);
      setStatus(profile.session.mfaRequired ? 'mfa' : profile.session.enrollmentRequired ? 'enroll' : 'signed_in');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (err.code === 'mfa_required') setStatus('mfa');
        else await clearSession();
        return;
      }
      if (err instanceof ApiError && err.code === 'mfa_enrollment_required') {
        setStatus('enroll');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [clearSession]);

  // Boot: restore the server and session; require biometrics before showing data.
  useEffect(() => {
    (async () => {
      const [server, token, bio] = await Promise.all([SecureStore.getItemAsync(KEYS.server), SecureStore.getItemAsync(KEYS.token), SecureStore.getItemAsync(KEYS.biometric)]);
      const available = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
      const enabled = available && bio === '1';
      setBiometric({ available, enabled });
      setServerUrl(server);
      if (!server || !token) {
        setStatus('signed_out');
        return;
      }
      makeApi(server, token);
      if (enabled) setStatus('locked');
      else await loadMe();
    })();
  }, [loadMe, makeApi]);

  // Lock again after the app spent a while in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active' && backgroundedAt.current) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (biometric.enabled && away > LOCK_AFTER_MS) setStatus((s) => (s === 'signed_in' ? 'locked' : s));
      }
    });
    return () => sub.remove();
  }, [biometric.enabled]);

  const signIn = useCallback(
    async (url: string, email: string, password: string) => {
      setError(null);
      const api = makeApi(url, null);
      const result = await api.login(email, password);
      if (!result.token) throw new ApiError(500, 'no_token', 'The server did not return a mobile session token');
      api.setToken(result.token);
      await SecureStore.setItemAsync(KEYS.server, url);
      await SecureStore.setItemAsync(KEYS.token, result.token);
      setServerUrl(url);
      if (result.status === 'mfa_required') setStatus('mfa');
      else if (result.status === 'mfa_enrollment_required') setStatus('enroll');
      else await loadMe();
    },
    [loadMe, makeApi],
  );

  const verifyMfa = useCallback(
    async (input: { code?: string; recoveryCode?: string }) => {
      await apiRef.current.verifyMfa(input);
      await loadMe();
    },
    [loadMe],
  );

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Steward Admin', fallbackLabel: 'Use passcode' });
    if (!result.success) return false;
    await loadMe();
    return true;
  }, [loadMe]);

  const signOut = useCallback(async () => {
    try {
      await apiRef.current.logout();
    } catch {
      /* the session may already be gone */
    }
    await clearSession();
  }, [clearSession]);

  const setBiometricEnabled = useCallback(
    async (enabled: boolean) => {
      if (enabled) {
        const check = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to enable biometric unlock' });
        if (!check.success) return;
      }
      await SecureStore.setItemAsync(KEYS.biometric, enabled ? '1' : '0');
      setBiometric((b) => ({ ...b, enabled: enabled && b.available }));
    },
    [],
  );

  const withReauth = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'reauth_required') throw err;
      await new Promise<void>((resolve, reject) => setReauth({ resolve, reject }));
      return fn();
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      serverUrl,
      me,
      api: apiRef.current,
      error,
      biometric,
      signIn,
      verifyMfa,
      refreshMe: loadMe,
      unlock,
      retry: loadMe,
      signOut,
      setBiometricEnabled,
      can: (permission: string) => canPermission(me?.permissions, permission),
      withReauth,
    }),
    [status, serverUrl, me, error, biometric, signIn, verifyMfa, loadMe, unlock, signOut, setBiometricEnabled, withReauth],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <ReauthModal
        visible={Boolean(reauth)}
        needsCode={Boolean(me?.admin.totpEnabled)}
        onCancel={() => {
          reauth?.reject(new Error('Confirmation cancelled'));
          setReauth(null);
        }}
        onSubmit={async (password, code) => {
          await apiRef.current.reauth(password, code);
          reauth?.resolve();
          setReauth(null);
        }}
      />
    </AuthContext.Provider>
  );
}

function ReauthModal({ visible, needsCode, onCancel, onSubmit }: { visible: boolean; needsCode: boolean; onCancel: () => void; onSubmit: (password: string, code?: string) => Promise<void> }) {
  const { c } = useTheme();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, needsCode ? code : undefined);
      setPassword('');
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 }}>
        <SafeAreaView>
          <Card style={{ gap: 12 }}>
            <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Confirm it's you</Text>
            <Text style={{ color: c.muted }}>This action is sensitive. Re-enter your password{needsCode ? ' and an authenticator code' : ''}.</Text>
            <Field label="Password" secureTextEntry value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" />
            {needsCode ? <Field label="Authenticator code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} /> : null}
            {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" variant="secondary" onPress={onCancel} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Confirm" loading={busy} disabled={!password || (needsCode && code.length < 6)} onPress={submit} />
              </View>
            </View>
          </Card>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
