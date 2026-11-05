import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { PERMISSIONS } from '../../src/lib/permissions';
import { useTheme } from '../../src/ui/theme';

function Glyph({ symbol, color }: { symbol: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 18, fontWeight: '700' }}>{symbol}</Text>;
}

/** Tabs the admin has no permission for are hidden (the server enforces permissions regardless). */
export default function TabsLayout() {
  const { can } = useAuth();
  const { c } = useTheme();
  const showBilling = can(PERMISSIONS.subscriptionsView) || can(PERMISSIONS.paymentsView);
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.card },
        headerTintColor: c.fg,
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.muted,
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: ({ color }) => <Glyph symbol="▦" color={color} /> }} />
      <Tabs.Screen name="users" options={{ title: 'Users', href: can(PERMISSIONS.usersView) ? undefined : null, tabBarIcon: ({ color }) => <Glyph symbol="◉" color={color} /> }} />
      <Tabs.Screen name="billing" options={{ title: 'Billing', href: showBilling ? undefined : null, tabBarIcon: ({ color }) => <Glyph symbol="$" color={color} /> }} />
      <Tabs.Screen name="alerts" options={{ title: 'Alerts', tabBarIcon: ({ color }) => <Glyph symbol="!" color={color} /> }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: ({ color }) => <Glyph symbol="⋯" color={color} /> }} />
    </Tabs>
  );
}
