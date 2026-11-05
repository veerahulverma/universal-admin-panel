import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { usePaged } from '../../src/ui/useResource';
import { Badge, Body, Empty, ErrorBox, ListItem, Loading, Segmented } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { ago, money } from '../../src/lib/format';
import { PERMISSIONS } from '../../src/lib/permissions';
import type { PaymentRow, SubscriptionRow } from '../../src/lib/api';

type Tab = 'subscriptions' | 'payments';

export default function Billing() {
  const { can } = useAuth();
  const { c } = useTheme();
  const [tab, setTab] = useState<Tab>(can(PERMISSIONS.subscriptionsView) ? 'subscriptions' : 'payments');
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[
          ...(can(PERMISSIONS.subscriptionsView) ? [{ value: 'subscriptions' as const, label: 'Subscriptions' }] : []),
          ...(can(PERMISSIONS.paymentsView) ? [{ value: 'payments' as const, label: 'Payments' }] : []),
        ]}
      />
      {tab === 'subscriptions' ? <Subscriptions /> : <Payments />}
    </View>
  );
}

function Subscriptions() {
  const { api, can, withReauth } = useAuth();
  const { c } = useTheme();
  const list = usePaged<SubscriptionRow>((a, page) => a.subscriptions({ page, pageSize: 30 }), []);

  const open = (s: SubscriptionRow) => {
    if (!can(PERMISSIONS.subscriptionsManage) || s.status === 'canceled') return;
    Alert.alert(s.product_name, s.customer_label ?? s.id, [
      { text: 'Close', style: 'cancel' },
      ...(!s.cancel_at_period_end
        ? [
            {
              text: 'Cancel at period end',
              style: 'destructive' as const,
              onPress: async () => {
                try {
                  await withReauth(() => api.cancelSubscription(s.id, true, 'Canceled from the mobile app'));
                  await list.refresh();
                } catch (err) {
                  Alert.alert('Could not cancel', err instanceof Error ? err.message : String(err));
                }
              },
            },
          ]
        : []),
    ]);
  };

  if (list.loading) return <Loading />;
  if (list.error) return <View style={{ padding: 16 }}><ErrorBox message={list.error} onRetry={list.refresh} /></View>;
  return (
    <FlatList
      data={list.items}
      keyExtractor={(s) => s.id}
      renderItem={({ item: s }) => (
        <ListItem
          title={s.customer_label ?? s.id}
          subtitle={`${s.product_name} · ${money(s.unit_amount * (s.quantity || 1), s.currency)}${s.interval ? `/${s.interval}` : ''} · renews ${new Date(s.current_period_end).toLocaleDateString()}`}
          right={<Badge label={s.cancel_at_period_end ? 'cancels' : s.status} tone={s.cancel_at_period_end ? 'warning' : undefined} />}
          onPress={() => open(s)}
        />
      )}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.4}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
      ListEmptyComponent={<Empty title="No subscriptions yet" />}
      ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
    />
  );
}

function Payments() {
  const { c } = useTheme();
  const list = usePaged<PaymentRow>((a, page) => a.payments({ page, pageSize: 30 }), []);
  if (list.loading) return <Loading />;
  if (list.error) return <View style={{ padding: 16 }}><ErrorBox message={list.error} onRetry={list.refresh} /></View>;
  return (
    <FlatList
      data={list.items}
      keyExtractor={(p) => p.id}
      renderItem={({ item: p }) => (
        <ListItem
          title={p.customer_label ?? p.id}
          subtitle={`${ago(p.created_at)}${p.method_details?.last4 ? ` · ${p.method_details.brand ?? p.method_type} •••• ${p.method_details.last4}` : p.method_type ? ` · ${p.method_type}` : ''}`}
          right={
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Body style={{ fontWeight: '600' }}>{money(p.amount, p.currency)}</Body>
              <Badge label={p.status} />
            </View>
          }
          onPress={() => router.push(`/payment/${p.id}`)}
        />
      )}
      onEndReached={list.loadMore}
      onEndReachedThreshold={0.4}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
      ListEmptyComponent={<Empty title="No payments yet" />}
      ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
    />
  );
}
