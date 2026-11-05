import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { usePaged } from '../../src/ui/useResource';
import { Badge, Empty, ErrorBox, ListItem, Loading, Segmented } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { money } from '../../src/lib/format';
import type { UserRow } from '../../src/lib/api';

type Filter = 'all' | 'active' | 'suspended' | 'banned';

export default function Users() {
  const { c } = useTheme();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(t);
  }, [input]);

  const list = usePaged<UserRow>((api, page) => api.users({ q: q || undefined, status: filter === 'all' ? undefined : filter, page, pageSize: 30 }), [q, filter]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Search name, email or ID"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Search users"
          style={{ backgroundColor: c.card, color: c.fg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 }}
        />
      </View>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'active', label: 'Active' },
          { value: 'suspended', label: 'Suspended' },
          { value: 'banned', label: 'Banned' },
        ]}
      />
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <View style={{ padding: 16 }}>
          <ErrorBox message={list.error} onRetry={list.refresh} />
        </View>
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => (
            <ListItem
              title={item.name || item.email}
              subtitle={[item.name ? item.email : null, item.plan?.name, item.lifetime_revenue ? money(item.lifetime_revenue) : null].filter(Boolean).join(' · ')}
              right={<Badge label={item.status} />}
              onPress={() => router.push(`/user/${item.id}`)}
            />
          )}
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.muted} />}
          ListEmptyComponent={<Empty title="No users found" hint={q ? 'Try a different search.' : undefined} />}
          ListFooterComponent={list.loadingMore ? <ActivityIndicator style={{ padding: 16 }} color={c.muted} /> : undefined}
        />
      )}
    </View>
  );
}
