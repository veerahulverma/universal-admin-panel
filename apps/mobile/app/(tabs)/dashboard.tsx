import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useResource } from '../../src/ui/useResource';
import { Badge, Bars, Card, Empty, ErrorBox, Loading, Muted, Screen, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { ago, compact, money, percentChange } from '../../src/lib/format';
import type { Kpi } from '../../src/lib/api';

function formatKpi(k: Kpi, currency: string): string {
  if (k.format === 'money') return money(k.value, currency);
  if (k.format === 'percent') return `${k.value.toFixed(1)}%`;
  return compact(k.value);
}

export default function Dashboard() {
  const { c } = useTheme();
  const { data, error, loading, refreshing, refresh } = useResource((api) => api.dashboard(30), []);
  if (loading) return <Loading />;
  if (error || !data) {
    return (
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <ErrorBox message={error ?? 'No data'} onRetry={refresh} />
      </Screen>
    );
  }
  const fmtMoney = (v: number) => money(v, data.currency);
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Muted>Last 30 days · compared with the previous 30</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {data.kpis.map((k) => {
          const change = percentChange(k.value, k.previous);
          return (
            <Card key={k.key} style={{ flexBasis: '47%', flexGrow: 1, gap: 4 }}>
              <Muted>{k.label}</Muted>
              <Text style={{ color: c.fg, fontSize: 22, fontWeight: '700' }} adjustsFontSizeToFit numberOfLines={1}>
                {formatKpi(k, data.currency)}
              </Text>
              {change !== null ? (
                <Text style={{ color: change >= 0 ? c.success : c.danger, fontSize: 12, fontWeight: '600' }}>
                  {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
                </Text>
              ) : (
                <Muted>—</Muted>
              )}
            </Card>
          );
        })}
      </View>
      <Card>
        <Title>Revenue</Title>
        {data.series.revenue.length ? <Bars points={data.series.revenue} format={fmtMoney} /> : <Empty title="No revenue yet" />}
      </Card>
      <Card>
        <Title>Signups</Title>
        {data.series.signups.length ? <Bars points={data.series.signups} format={(v) => compact(v)} /> : <Empty title="No signups yet" />}
      </Card>
      <Card style={{ gap: 4 }}>
        <Title>Recent payments</Title>
        {data.recent.payments.length ? (
          data.recent.payments.map((p) => (
            <Pressable key={p.id} onPress={() => router.push(`/payment/${p.id}`)} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, minHeight: 44 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.fg }} numberOfLines={1}>
                  {p.customer_label ?? p.id}
                </Text>
                <Muted>{ago(p.created_at)}</Muted>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={{ color: c.fg, fontWeight: '600' }}>{money(p.amount, p.currency)}</Text>
                <Badge label={p.status} />
              </View>
            </Pressable>
          ))
        ) : (
          <Muted>No payments in this period.</Muted>
        )}
      </Card>
      <Card style={{ gap: 4 }}>
        <Title>New users</Title>
        {data.recent.users.length ? (
          data.recent.users.map((u) => (
            <Pressable key={u.id} onPress={() => router.push(`/user/${u.id}`)} style={{ paddingVertical: 8, minHeight: 44 }}>
              <Text style={{ color: c.fg }} numberOfLines={1}>
                {u.name || u.email}
              </Text>
              <Muted>
                {u.name ? `${u.email} · ` : ''}
                {ago(u.created_at)}
              </Muted>
            </Pressable>
          ))
        ) : (
          <Muted>No signups in this period.</Muted>
        )}
      </Card>
      <Card style={{ gap: 4 }}>
        <Title>Security</Title>
        {data.recent.security.length ? (
          data.recent.security.map((s) => (
            <View key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
              <Text style={{ color: c.fg, flex: 1 }} numberOfLines={1}>
                {s.type.replace(/[._]/g, ' ')}
              </Text>
              <Badge label={s.severity} />
            </View>
          ))
        ) : (
          <Muted>No security events.</Muted>
        )}
      </Card>
    </Screen>
  );
}
