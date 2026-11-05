import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { toneFor, useTheme } from './theme';

export function Screen({ children, refreshing, onRefresh, scroll = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean }) {
  const { c } = useTheme();
  if (!scroll) return <View style={{ flex: 1, backgroundColor: c.bg }}>{children}</View>;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={c.muted} /> : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { c } = useTheme();
  return <View style={[{ backgroundColor: c.card, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 }, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <Text style={{ color: c.fg, fontSize: 16, fontWeight: '600', marginBottom: 8 }}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  const { c } = useTheme();
  return <Text style={[{ color: c.muted, fontSize: 13 }, style]}>{children}</Text>;
}

export function Body({ children, style, numberOfLines }: { children: ReactNode; style?: object; numberOfLines?: number }) {
  const { c } = useTheme();
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: c.fg, fontSize: 15 }, style]}>
      {children}
    </Text>
  );
}

export function Badge({ label, tone }: { label: string; tone?: ReturnType<typeof toneFor> }) {
  const { c } = useTheme();
  const t = tone ?? toneFor(label);
  const color = t === 'muted' ? c.muted : c[t];
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{label.replace(/_/g, ' ')}</Text>
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, loading }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; loading?: boolean }) {
  const { c } = useTheme();
  const bg = variant === 'primary' ? c.accent : variant === 'danger' ? c.danger : c.card;
  const fg = variant === 'secondary' ? c.fg : variant === 'danger' ? '#fff' : c.accentFg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || loading) }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        backgroundColor: bg,
        borderColor: variant === 'secondary' ? c.border : bg,
        borderWidth: 1,
        borderRadius: 10,
        minHeight: 44,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.muted, fontSize: 13, fontWeight: '500' }}>{label}</Text>
      <TextInput
        placeholderTextColor={c.muted}
        {...props}
        style={[{ backgroundColor: c.card, color: c.fg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 }, props.style]}
      />
    </View>
  );
}

export function Row({ label, value, onPress, right }: { label: string; value?: ReactNode; onPress?: () => void; right?: ReactNode }) {
  const { c } = useTheme();
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, gap: 12, minHeight: 44 }}>
      <Text style={{ color: c.muted, fontSize: 14 }}>{label}</Text>
      {right ?? (typeof value === 'string' || typeof value === 'number' ? <Text style={{ color: c.fg, fontSize: 14, flexShrink: 1, textAlign: 'right' }}>{value}</Text> : value)}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button">
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function ListItem({ title, subtitle, right, onPress }: { title: string; subtitle?: string; right?: ReactNode; onPress?: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({ backgroundColor: pressed ? c.soft : c.card, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: c.fg, fontSize: 15, fontWeight: '500' }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.soft, borderRadius: 10, padding: 3, margin: 16, marginBottom: 8 }}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === o.value }}
          style={{ flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: value === o.value ? c.card : 'transparent' }}
        >
          <Text style={{ color: value === o.value ? c.fg : c.muted, fontWeight: '600' }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Loading() {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: 32, gap: 6 }}>
      <Text style={{ color: c.fg, fontWeight: '600' }}>{title}</Text>
      {hint ? <Text style={{ color: c.muted, textAlign: 'center' }}>{hint}</Text> : null}
    </View>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { c } = useTheme();
  return (
    <Card style={{ borderColor: c.danger, gap: 8 }}>
      <Text style={{ color: c.danger, fontWeight: '600' }}>Something went wrong</Text>
      <Text style={{ color: c.fg }}>{message}</Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </Card>
  );
}

/** Simple bar chart drawn with views (no native chart dependency). */
export function Bars({ points, format }: { points: { date: string; value: number }[]; format: (v: number) => string }) {
  const { c } = useTheme();
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((s, p) => s + p.value, 0);
  return (
    <View accessible accessibilityLabel={`Total ${format(total)} over ${points.length} days`}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 80, gap: 2 }}>
        {points.map((p) => (
          <View key={p.date} style={{ flex: 1, height: `${Math.max(2, (p.value / max) * 100)}%`, backgroundColor: c.accent, borderTopLeftRadius: 2, borderTopRightRadius: 2, opacity: p.value ? 1 : 0.25 }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Muted>{points[0]?.date.slice(5) ?? ''}</Muted>
        <Muted>Total {format(total)}</Muted>
        <Muted>{points[points.length - 1]?.date.slice(5) ?? ''}</Muted>
      </View>
    </View>
  );
}

/** Text prompt (Alert.prompt is iOS-only). */
export function PromptModal({
  visible,
  title,
  message,
  placeholder,
  confirmLabel,
  destructive,
  required = true,
  keyboardType,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  confirmLabel: string;
  destructive?: boolean;
  required?: boolean;
  keyboardType?: TextInputProps['keyboardType'];
  onCancel: () => void;
  onConfirm: (value: string) => Promise<void> | void;
}) {
  const { c } = useTheme();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(value.trim());
      setValue('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 }}>
        <SafeAreaView>
          <Card style={{ gap: 12 }}>
            <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>{title}</Text>
            {message ? <Text style={{ color: c.muted }}>{message}</Text> : null}
            <TextInput
              autoFocus
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              placeholderTextColor={c.muted}
              keyboardType={keyboardType}
              style={{ color: c.fg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 }}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" variant="secondary" onPress={onCancel} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title={confirmLabel} variant={destructive ? 'danger' : 'primary'} loading={busy} disabled={required && !value.trim()} onPress={submit} />
              </View>
            </View>
          </Card>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
