import { useState } from 'react';
import { Alert, Modal, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/auth/AuthContext';
import { useResource } from '../../src/ui/useResource';
import { Badge, Button, Card, ErrorBox, Field, Loading, Muted, Row, Screen, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { currencyDigits, dateTime, money } from '../../src/lib/format';
import { PERMISSIONS } from '../../src/lib/permissions';

export default function PaymentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, can, withReauth } = useAuth();
  const { c } = useTheme();
  const { data: p, error, loading, refreshing, refresh } = useResource((a) => a.payment(String(id)), [id]);
  const [refundOpen, setRefundOpen] = useState(false);

  if (loading) return <Loading />;
  if (error || !p) {
    return (
      <Screen>
        <ErrorBox message={error ?? 'Payment not found'} onRetry={refresh} />
      </Screen>
    );
  }
  const remaining = p.amount - p.amount_refunded;
  const canRefund = can(PERMISSIONS.refundsCreate) && p.refundable && remaining > 0 && ['succeeded', 'partially_refunded', 'disputed'].includes(p.status);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Card style={{ gap: 6 }}>
        <Text style={{ color: c.fg, fontSize: 26, fontWeight: '700' }}>{money(p.amount, p.currency)}</Text>
        <Badge label={p.status} />
        {p.amount_refunded ? <Muted>{money(p.amount_refunded, p.currency)} refunded</Muted> : null}
      </Card>
      <Card>
        <Row label="Customer" value={p.customer_label ?? '—'} />
        <Row label="Date" value={dateTime(p.created_at)} />
        <Row label="Method" value={p.method_details?.last4 ? `${p.method_details.brand ?? p.method_type} •••• ${p.method_details.last4}` : p.method_type ?? '—'} />
        <Row label="Gateway" value={p.gateway_name ?? '—'} />
        <Row label="Payment ID" value={p.id} />
      </Card>
      {p.refunds.length ? (
        <Card>
          <Title>Refunds</Title>
          {p.refunds.map((r) => (
            <Row key={r.id} label={dateTime(r.created_at)} value={`${money(r.amount, p.currency)} · ${r.status}`} />
          ))}
        </Card>
      ) : null}
      {canRefund ? <Button title="Refund" variant="danger" onPress={() => setRefundOpen(true)} /> : null}
      <RefundModal
        visible={refundOpen}
        currency={p.currency}
        max={remaining}
        partial={p.partialRefunds}
        onCancel={() => setRefundOpen(false)}
        onSubmit={async (amount, reason) => {
          const result = await withReauth(() => api.refund(p.id, amount, reason));
          setRefundOpen(false);
          if (result.status === 'requires_approval') Alert.alert('Sent for approval', 'Refunds this large need a second administrator. They have been notified.');
          else if (result.status === 'failed') Alert.alert('Refund failed', 'The gateway rejected the refund. Check the payment in the web admin.');
          await refresh();
        }}
      />
    </Screen>
  );
}

function RefundModal({ visible, currency, max, partial, onCancel, onSubmit }: { visible: boolean; currency: string; max: number; partial: boolean; onCancel: () => void; onSubmit: (amount: number, reason: string) => Promise<void> }) {
  const { c } = useTheme();
  const digits = currencyDigits(currency);
  const [amount, setAmount] = useState((max / 10 ** digits).toFixed(digits));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const minor = Math.round(Number(amount.replace(',', '.')) * 10 ** digits);
  const valid = Number.isFinite(minor) && minor > 0 && minor <= max && (partial || minor === max) && reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(minor, reason.trim());
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 }}>
        <SafeAreaView>
          <Card style={{ gap: 12 }}>
            <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>Refund payment</Text>
            <Muted>Up to {money(max, currency)}{partial ? '' : ' (this gateway only supports full refunds)'}.</Muted>
            <Field label={`Amount (${currency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" editable={partial} />
            <Field label="Reason" value={reason} onChangeText={setReason} placeholder="Shown in the audit log" />
            {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" variant="secondary" onPress={onCancel} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Refund" variant="danger" loading={busy} disabled={!valid} onPress={submit} />
              </View>
            </View>
          </Card>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
