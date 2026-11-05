import { Switch } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useAuth } from '../../src/auth/AuthContext';
import { Button, Card, Muted, Row, Screen, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { dateTime } from '../../src/lib/format';
import { PERMISSIONS } from '../../src/lib/permissions';

export default function More() {
  const { me, serverUrl, biometric, setBiometricEnabled, signOut, can } = useAuth();
  const { c } = useTheme();
  return (
    <Screen>
      <Card>
        <Title>{me?.admin.name ?? 'Administrator'}</Title>
        <Row label="Email" value={me?.admin.email ?? '—'} />
        <Row label="Roles" value={me?.admin.roles.map((r) => r.name).join(', ') || '—'} />
        <Row label="Two-factor" value={me?.admin.totpEnabled ? 'On' : 'Off'} />
        {me?.admin.orgScope?.length ? <Row label="Data scope" value={`${me.admin.orgScope.length} organization(s)`} /> : null}
        <Row label="Session expires" value={dateTime(me?.session.expiresAt)} />
      </Card>
      <Card>
        <Title>This device</Title>
        <Row label="Server" value={serverUrl ?? '—'} />
        {biometric.available ? (
          <Row
            label="Biometric unlock"
            right={<Switch value={biometric.enabled} onValueChange={(v) => void setBiometricEnabled(v)} trackColor={{ true: c.accent }} accessibilityLabel="Biometric unlock" />}
          />
        ) : (
          <Muted>Biometric unlock is unavailable (no Face ID / fingerprint enrolled).</Muted>
        )}
      </Card>
      {can(PERMISSIONS.auditView) ? (
        <Card>
          <Row label="Audit log" value="›" onPress={() => router.push('/audit')} />
        </Card>
      ) : null}
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
      <Muted style={{ textAlign: 'center' }}>Steward Admin {Constants.expoConfig?.version ?? ''}</Muted>
    </Screen>
  );
}
