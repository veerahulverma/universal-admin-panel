import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { useResource } from '../../src/ui/useResource';
import { Badge, Body, Button, Card, ErrorBox, Loading, Muted, PromptModal, Row, Screen, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { ago, dateTime, money } from '../../src/lib/format';
import { PERMISSIONS } from '../../src/lib/permissions';

type Action = { kind: 'suspend' | 'ban' } | null;

export default function UserDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, can, withReauth } = useAuth();
  const { c } = useTheme();
  const { data: user, error, loading, refreshing, refresh } = useResource((a) => a.user(String(id)), [id]);
  const [action, setAction] = useState<Action>(null);

  if (loading) return <Loading />;
  if (error || !user) {
    return (
      <Screen>
        <ErrorBox message={error ?? 'User not found'} onRetry={refresh} />
      </Screen>
    );
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await withReauth(fn);
      await refresh();
    } catch (err) {
      Alert.alert(`${label} failed`, err instanceof Error ? err.message : String(err));
    }
  };

  const confirmRevoke = () =>
    Alert.alert('Sign out everywhere?', 'All of this user’s sessions end immediately.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void run('Revoking sessions', () => api.revokeSessions(user.id)) },
    ]);

  const subs = user.panels.billing?.subscriptions ?? [];
  const payments = user.panels.billing?.payments ?? [];

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen options={{ title: user.name || user.email }} />
      <Card style={{ gap: 6 }}>
        <Text style={{ color: c.fg, fontSize: 20, fontWeight: '700' }}>{user.name || user.email}</Text>
        {user.name ? <Muted>{user.email}</Muted> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <Badge label={user.deleted_at ? 'deleted' : user.status} />
          {user.plan ? <Badge label={user.plan.name} tone="info" /> : null}
          {user.email_verified_at ? <Badge label="verified" tone="success" /> : <Badge label="unverified" tone="muted" />}
        </View>
        {user.status_reason ? <Muted>Reason: {user.status_reason}</Muted> : null}
      </Card>

      <Card>
        <Row label="Lifetime revenue" value={money(user.lifetime_revenue)} />
        <Row label="Signed up" value={dateTime(user.created_at)} />
        <Row label="Last active" value={ago(user.last_active_at)} />
        <Row label="Last login" value={user.last_login_at ? `${ago(user.last_login_at)}${user.last_login_ip ? ` · ${user.last_login_ip}` : ''}` : '—'} />
        <Row label="Active sessions" value={String(user.activeSessions)} />
        <Row label="Country" value={user.country ?? '—'} />
        {user.external_id ? <Row label="External ID" value={user.external_id} /> : null}
        <Row label="User ID" value={user.id} />
      </Card>

      {user.organizations.length ? (
        <Card>
          <Title>Organizations</Title>
          {user.organizations.map((o) => (
            <Row key={o.id} label={o.name} value={o.role} />
          ))}
        </Card>
      ) : null}

      {subs.length ? (
        <Card>
          <Title>Subscriptions</Title>
          {subs.map((s) => (
            <Row
              key={s.id}
              label={s.product_name}
              right={
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Body>
                    {money(s.unit_amount, s.currency)}
                    {s.interval ? ` / ${s.interval}` : ''}
                  </Body>
                  <Badge label={s.cancel_at_period_end ? 'cancels' : s.status} tone={s.cancel_at_period_end ? 'warning' : undefined} />
                </View>
              }
            />
          ))}
        </Card>
      ) : null}

      {payments.length ? (
        <Card>
          <Title>Payments</Title>
          {payments.slice(0, 8).map((p) => (
            <Row key={p.id} label={ago(p.created_at)} onPress={() => router.push(`/payment/${p.id}`)} right={<Body>{`${money(p.amount, p.currency)} · ${p.status.replace(/_/g, ' ')}`}</Body>} />
          ))}
        </Card>
      ) : null}

      {!user.deleted_at ? (
        <Card style={{ gap: 10 }}>
          <Title>Actions</Title>
          {user.status !== 'active' && can(PERMISSIONS.usersSuspend) ? <Button title="Reactivate" onPress={() => void run('Reactivation', () => api.setUserStatus(user.id, 'reactivate'))} /> : null}
          {user.status === 'active' && can(PERMISSIONS.usersSuspend) ? <Button title="Suspend" variant="secondary" onPress={() => setAction({ kind: 'suspend' })} /> : null}
          {user.status !== 'banned' && can(PERMISSIONS.usersBan) ? <Button title="Ban" variant="danger" onPress={() => setAction({ kind: 'ban' })} /> : null}
          {can(PERMISSIONS.sessionsRevoke) ? <Button title="Sign out everywhere" variant="secondary" onPress={confirmRevoke} /> : null}
          {!can(PERMISSIONS.usersSuspend) && !can(PERMISSIONS.usersBan) && !can(PERMISSIONS.sessionsRevoke) ? <Muted>Your role cannot change this account.</Muted> : null}
        </Card>
      ) : null}

      <PromptModal
        visible={action !== null}
        title={action?.kind === 'ban' ? 'Ban user' : 'Suspend user'}
        message="The reason is recorded in the audit log and their sessions end."
        placeholder="Reason"
        confirmLabel={action?.kind === 'ban' ? 'Ban' : 'Suspend'}
        destructive
        onCancel={() => setAction(null)}
        onConfirm={async (reason) => {
          const kind = action!.kind;
          setAction(null);
          await run(kind === 'ban' ? 'Ban' : 'Suspension', () => api.setUserStatus(user.id, kind, reason));
        }}
      />
    </Screen>
  );
}
