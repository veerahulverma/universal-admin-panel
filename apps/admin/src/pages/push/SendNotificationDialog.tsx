import { useState } from 'react';
import { Send } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { Button, Field, FormError, Input, Modal, Select, Switch, Textarea } from '../../components/ui';
import { SEVERITIES } from './shared';

/** Send one customer a notification: in their notification center, and as a push to their browsers and apps. */
export function SendNotificationDialog({ user, open, onOpenChange }: { user: { id: string; email: string; name: string | null }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState({ title: '', body: '', link: '', severity: 'info', push: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const send = useAction(
    () =>
      api.post('/api/admin/user-notifications', {
        userIds: [user.id],
        title: form.title.trim(),
        ...(form.body.trim() ? { body: form.body.trim() } : {}),
        ...(form.link.trim() ? { link: form.link.trim() } : {}),
        severity: form.severity,
        push: form.push,
      }),
    {
      success: `Notification sent to ${user.name || user.email}`,
      invalidate: [['user-notifications', user.id]],
      onSuccess: () => {
        setForm({ title: '', body: '', link: '', severity: 'info', push: true });
        onOpenChange(false);
      },
      onError: (err) => {
        setError(errorMessage(err));
        if (err instanceof ApiError) setErrors(err.fieldErrors());
      },
    },
  );
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a notification"
      description={`To ${user.name || user.email}. It appears in their notification center${form.push ? ' and as a push notification on their browsers and apps' : ''}.`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="send-notification" icon={<Send className="size-4" />} loading={send.isPending} disabled={!form.title.trim()}>
            Send
          </Button>
        </>
      }
    >
      <form
        id="send-notification"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setErrors({});
          send.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Title" htmlFor="sn-title" error={errors.title} required>
          <Input id="sn-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} autoFocus placeholder="Your report is ready" />
        </Field>
        <Field label="Message" htmlFor="sn-body" error={errors.body}>
          <Textarea id="sn-body" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={1000} />
        </Field>
        <Field label="Link" htmlFor="sn-link" hint="Opened when the customer taps the notification" error={errors.link}>
          <Input id="sn-link" type="url" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://app.example.com/reports" />
        </Field>
        <Field label="Importance" htmlFor="sn-severity">
          <Select id="sn-severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} options={SEVERITIES} />
        </Field>
        <Switch checked={form.push} onCheckedChange={(push) => setForm({ ...form, push })} label="Also send as a push notification" description="Off: it only appears in the notification center." />
      </form>
    </Modal>
  );
}
