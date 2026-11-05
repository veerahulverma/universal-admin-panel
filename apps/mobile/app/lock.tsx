import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth/AuthContext';
import { Button, Muted } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

/** Biometric gate shown on launch and after time in the background. */
export default function Lock() {
  const { unlock, signOut, me, serverUrl } = useAuth();
  const { c } = useTheme();
  const [failed, setFailed] = useState(false);

  const attempt = async () => {
    setFailed(!(await unlock()));
  };

  useEffect(() => {
    void attempt();
    // Prompt once on mount; later attempts are user-initiated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24, gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Text style={{ color: c.fg, fontSize: 24, fontWeight: '700' }}>Locked</Text>
        <Muted>{me?.admin.email ?? serverUrl ?? ''}</Muted>
      </View>
      {failed ? <Text style={{ color: c.danger, textAlign: 'center' }}>Authentication failed or was cancelled.</Text> : null}
      <Button title="Unlock" onPress={() => void attempt()} />
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </SafeAreaView>
  );
}
