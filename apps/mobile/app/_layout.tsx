import { useEffect } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { useTheme } from '../src/ui/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <Navigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

/** Route by session state: sign-in (incl. 2FA), biometric lock, or the app. */
function Navigator() {
  const { status } = useAuth();
  const segments = useSegments();
  const { c, dark } = useTheme();

  useEffect(() => {
    const first = segments[0] as string | undefined;
    if (status === 'loading' || status === 'error') return;
    if (status === 'locked') {
      if (first !== 'lock') router.replace('/lock');
    } else if (status === 'signed_in') {
      if (!first || first === 'sign-in' || first === 'lock') router.replace('/dashboard');
    } else if (first !== 'sign-in') {
      router.replace('/sign-in');
    }
  }, [status, segments]);

  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerStyle: { backgroundColor: c.card }, headerTintColor: c.fg, headerShadowVisible: false, contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="lock" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="user/[id]" options={{ title: 'User' }} />
        <Stack.Screen name="payment/[id]" options={{ title: 'Payment' }} />
        <Stack.Screen name="audit" options={{ title: 'Audit log' }} />
      </Stack>
    </>
  );
}
