import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { usePaged } from '../../src/ui/useResource';
import { Badge, Empty, ErrorBox, ListItem, Loading, Segmented } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { ago, humanize } from '../../src/lib/format';
import { PERMISSIONS } from '../../src/lib/permissions';
import type { NotificationRow, SecurityEventRow } from '../../src/lib/api';

type Tab = 'notifications' | 'security';

export default function Alerts() {
  const { can } = useAuth();
  const { c } = useTheme();
  const [tab, setTab] = useState<Tab>('notifications');
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        options={[{ value: 'notifications', label: 'Notifications' }, ...(can(PERMISSIONS.securityView) ? [{ value: 'security' as const, label: 'Security' }] : [])]}
      />
      {tab === 'notifications' ? <Notifications /> : <SecurityEvents />}
    </View>
  );
}

/** Map admin-panel links to native screens where one exists. */
function openLink(link: string | null) {
  if (!link) return;
  const user = /^\/customers\/users\/([^/]+)/.exec(link);
  if (user) return router.push(`/user/${user[1]}`);
  if (link.startsWith('/admin/security')) return;
  if (link.startsWith('/revenue')) return router.push('/billing');
}

function Notifications() {
  const { api } = useAuth();
  const { c } = useTheme();
  const list = usePaged<NotificationRow>((a, page) => a.notifications({ page }), []);

  const markAll = async () => {
    await api.markNotificationsRead();
    list.replace((items) => items.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
  };

  if (list.loading) return <Loading />;
  if (list.error) return <View style={{ padding: 16 }}><ErrorBox message={list.error} onRetry={list.refresh} /></View>;
  return (
    <FlatList
      data={list.items}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={
        list.items.some((n) => !n.read_at) ? (
          <Pressable onPress={() => void markAll()} accessibilityRole="button" style={{ alignSelf: 'flex-end', paddingHorizontal: 16, paddingVertical: 8 }}>
            <Text style={{ color: c.accent, fontWeight: '600' }}>Mark all read</Text>
          </Pressable>
        ) : undefined
      }
      renderItem={({ item: n }) => (
        <ListItem
          title={`${n.read_at ? '' : '● '}${n.title}`}
          subtitle={`${ago(n.created_at)}${n.body ? ` · ${n.body}` : ''}`}
          right={n.severity !== 'info' ? <Badge label={n.severity} /> : undefined}
          onPress={() => {
            if (!n.read_at) {
              void api.markNotificationsRead([n.id]);
              list.replace((items) => items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
            }
            openLink(n.link);
          }}
        />
      )}
      onEndReached={list.loadMore}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
      ListEmptyComponent={<Empty title="You're all caught up" />}
      ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
    />
  );
}

function SecurityEvents() {
  const { api, can } = useAuth();
  const { c } = useTheme();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const list = usePaged<SecurityEventRow>((a, page) => a.securityEvents({ status: status === 'open' ? 'open' : undefined, page }), [status]);

  const act = (e: SecurityEventRow) => {
    if (!can(PERMISSIONS.securityManage) || e.status === 'resolved') return;
    const update = async (next: SecurityEventRow['status']) => {
      try {
        await api.updateSecurityEvent(e.id, next);
        await list.refresh();
      } catch (err) {
        Alert.alert('Update failed', err instanceof Error ? err.message : String(err));
      }
    };
    Alert.alert(humanize(e.type), `${e.subject_type ?? ''} ${e.subject_id ?? ''}${e.ip ? `\nIP ${e.ip}` : ''}\nIP addresses can be shared or VPNs; treat this as a signal, not proof.`, [
      { text: 'Close', style: 'cancel' },
      ...(e.status === 'open' ? [{ text: 'Acknowledge', onPress: () => void update('acknowledged') }] : []),
      { text: 'Resolve', onPress: () => void update('resolved') },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 16, paddingBottom: 8 }}>
        {(['open', 'all'] as const).map((s) => (
          <Pressable key={s} onPress={() => setStatus(s)} accessibilityRole="button" accessibilityState={{ selected: status === s }}>
            <Text style={{ color: status === s ? c.accent : c.muted, fontWeight: '600' }}>{s === 'open' ? 'Open' : 'All'}</Text>
          </Pressable>
        ))}
      </View>
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <View style={{ padding: 16 }}><ErrorBox message={list.error} onRetry={list.refresh} /></View>
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(e) => e.id}
          renderItem={({ item: e }) => (
            <ListItem title={humanize(e.type)} subtitle={`${ago(e.created_at)}${e.ip ? ` · ${e.ip}` : ''} · ${e.status}`} right={<Badge label={e.severity} />} onPress={() => act(e)} />
          )}
          onEndReached={list.loadMore}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
          ListEmptyComponent={<Empty title={status === 'open' ? 'No open security events' : 'No security events'} />}
          ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
        />
      )}
    </View>
  );
}
