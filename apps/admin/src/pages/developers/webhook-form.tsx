import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { Button, Field, FormError, Input, Modal, Textarea } from '../../components/ui';
import { EventPicker, OrgScopeField } from './shared';

export interface Endpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  org_id: string | null;
  api_version: string;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deliveries_24h: number;
  failed_24h: number;
  pending?: number;
  last_delivery_at?: string | null;
  org_name?: string | null;
}

/** Create (returns the signing secret once) or edit a webhook endpoint. */
export function EndpointFormDialog({ open, onOpenChange, existing, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; existing?: Endpoint; onCreated?: (r: { id: string; secret: string }) => void }) {
  const [form, setForm] = useState(() => ({ url: existing?.url ?? '', description: existing?.description ?? '', events: existing?.events ?? ['*'], orgId: existing?.org_id ?? null }));
  const [error, setError] = useState<string | null>(null);
  const save = useAction<void, { id: string; secret?: string }>(
    () =>
      existing
        ? api.patch<Endpoint>(`/api/admin/webhooks/${existing.id}`, { url: form.url.trim(), description: form.description, events: form.events })
        : api.post<{ id: string; secret: string }>('/api/admin/webhooks', { url: form.url.trim(), description: form.description || undefined, events: form.events, orgId: form.orgId }),
    {
      success: existing ? 'Endpoint updated' : undefined,
      invalidate: [['developers', 'webhooks']],
      onSuccess: (r) => {
        onOpenChange(false);
        if (!existing && r.secret) onCreated?.({ id: r.id, secret: r.secret });
      },
      onError: (e) => setError(errorMessage(e)),
    },
  );
  const valid = /^https?:\/\/\S+$/.test(form.url.trim()) && form.events.length > 0;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={existing ? 'Edit endpoint' : 'Add a webhook endpoint'}
      description="Your application receives a signed POST request for each subscribed event."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="endpoint-form" loading={save.isPending} disabled={!valid}>
            {existing ? 'Save changes' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form
        id="endpoint-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Endpoint URL" htmlFor="ep-url" required hint="Must be reachable from this server. In production, private and internal addresses are blocked.">
          <Input id="ep-url" type="url" inputMode="url" className="font-mono" placeholder="https://api.example.com/webhooks/steward" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required autoFocus />
        </Field>
        <Field label="Description" htmlFor="ep-desc">
          <Textarea id="ep-desc" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this endpoint does" />
        </Field>
        {!existing && (
          <Field label="Organization" htmlFor="ep-org" hint="An organization's endpoint only receives that organization's events.">
            <OrgScopeField id="ep-org" value={form.orgId} onChange={(orgId) => setForm({ ...form, orgId })} />
          </Field>
        )}
        <Field label="Events">
          <EventPicker value={form.events} onChange={(events) => setForm({ ...form, events })} />
        </Field>
      </form>
    </Modal>
  );
}
