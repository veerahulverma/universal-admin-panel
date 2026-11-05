import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, TextInput, View } from 'react-native';
import { usePaged } from '../src/ui/useResource';
import { Empty, ErrorBox, ListItem, Loading } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';
import { ago } from '../src/lib/format';
import type { AuditRow } from '../src/lib/api';

export default function Audit() {
  const { c } = useTheme();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);
  const list = usePaged<AuditRow>((api, page) => api.auditLogs({ q: q || undefined, page, pageSize: 40 }), [q]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: 16, paddingBottom: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Filter by action, actor or target"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Filter audit log"
          style={{ backgroundColor: c.card, color: c.fg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 }}
        />
      </View>
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <View style={{ padding: 16 }}><ErrorBox message={list.error} onRetry={list.refresh} /></View>
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(r) => r.id}
          renderItem={({ item: r }) => (
            <ListItem
              title={r.action}
              subtitle={`${r.actor_label ?? r.actor_type} · ${ago(r.created_at)}${r.target_type ? ` · ${r.target_type} ${r.target_id ?? ''}` : ''}`}
            />
          )}
          onEndReached={list.loadMore}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
          ListEmptyComponent={<Empty title="No audit entries" />}
          ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
        />
      )}
    </View>
  );
}
