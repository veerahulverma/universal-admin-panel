import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { num } from '../../lib/format';
import { Badge, ButtonLink, Button, Callout, Card, DataTable, EmptyState, ErrorState, FormError, Input, PageHeader, Skeleton, StatusBadge, Switch, Tabs, When } from '../../components/ui';
import { useSaveSettings, useSettingsSection } from '../growth/shared';
import { triggerLabel, type SequenceRow } from './shared';

function SequencesTab() {
  const sequences = useQuery({ queryKey: ['email-sequences'], queryFn: () => api.get<{ data: SequenceRow[] }>('/api/admin/email/sequences') });
  if (sequences.error) return <ErrorState error={sequences.error} onRetry={() => void sequences.refetch()} />;
  return (
    <div className="space-y-4">
      <Callout>
        Autoresponders are marketing email: only people who consented to marketing receive them, and unsubscribing stops every sequence they are in. An enrolment also stops when its trigger no longer applies (a refund, a cancellation, a renewal that happened, a customer who came back).
      </Callout>
      <Card padded={false}>
        <DataTable
          caption="Autoresponders"
          rows={sequences.data?.data}
          loading={sequences.isLoading}
          rowKey={(s) => s.id}
          rowHref={(s) => `/growth/email/autoresponders/${s.id}`}
          empty={<EmptyState icon={<CalendarClock />} title="No autoresponders yet" description="For example: three onboarding emails over the first week after signup, or tips after someone buys a product." />}
          columns={[
            {
              key: 'name',
              header: 'Autoresponder',
              cell: (s) => (
                <span className="block min-w-0 max-w-md">
                  <span className="block truncate">{s.name}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {triggerLabel(s.trigger_type)}
                    {s.trigger_type === 'renewal_upcoming' && s.days_before ? ` · ${s.days_before} days before` : ''}
                    {s.product_ids.length ? ` · ${s.product_ids.length} ${s.product_ids.length === 1 ? 'product' : 'products'}` : ''}
                  </span>
                </span>
              ),
            },
            { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
            { key: 'steps', header: 'Emails', align: 'right', cell: (s) => <span className="tabular">{num(s.step_count)}</span> },
            { key: 'active', header: 'In progress', align: 'right', cell: (s) => <span className="tabular">{num(s.active_count)}</span> },
            { key: 'completed', header: 'Completed', align: 'right', priority: 'low', cell: (s) => <span className="tabular">{num(s.completed_count)}</span> },
            { key: 'stopped', header: 'Stopped', align: 'right', priority: 'low', cell: (s) => <span className="tabular">{num(s.stopped_count)}</span> },
            { key: 'updated', header: 'Updated', cell: (s) => <When value={s.updated_at} /> },
          ]}
        />
      </Card>
    </div>
  );
}

interface Automation {
  key: string;
  label: string;
  description: string;
  templates: string[];
  days?: { key: string; label: string; min: number; max: number };
}

const AUTOMATIONS: Automation[] = [
  { key: 'autoWelcome', label: 'Welcome email', description: 'When someone signs up. Never for people imported from a file or created from a support email.', templates: ['account.welcome'] },
  {
    key: 'autoRenewalReminder',
    label: 'Renewal reminders',
    description: 'Before a paid subscription renews. Not for subscriptions that will not renew (cancelled, or an installment plan whose last payment is billed).',
    templates: ['subscription.renewal_reminder'],
    days: { key: 'renewalReminderDays', label: 'Days before renewal', min: 1, max: 60 },
  },
  {
    key: 'autoExpiryNotices',
    label: 'Expiry notices',
    description: 'Before access ends (the last period of a cancelled subscription or paid-off installment plan, a time-limited grant) and once a grant or plan has ended.',
    templates: ['access.expiring', 'access.expired'],
    days: { key: 'expiryReminderDays', label: 'Days before access ends (0: only when it ends)', min: 0, max: 60 },
  },
  { key: 'autoReceipts', label: 'Payment receipts', description: 'After every successful payment.', templates: ['billing.receipt'] },
  { key: 'autoPaymentFailed', label: 'Failed payments', description: 'When collecting an invoice fails, with a link to pay.', templates: ['billing.payment_failed'] },
  { key: 'autoTrialEnding', label: 'Trial ending', description: 'A few days before a trial ends.', templates: ['subscription.trial_will_end'] },
  { key: 'autoSubscriptionCanceled', label: 'Subscription ended', description: 'When a subscription ends. Not when an installment plan is paid off.', templates: ['subscription.canceled'] },
  { key: 'autoUsageAlerts', label: 'Usage alerts', description: 'When a quota passes its warning threshold and when it is reached.', templates: ['usage.limit_warning', 'usage.limit_reached'] },
  { key: 'autoCheckoutRecovery', label: 'Abandoned checkout', description: 'One reminder per abandoned checkout (marketing: needs consent).', templates: ['checkout.recovery'] },
];

function LifecycleTab() {
  const { can } = useAuth();
  const settings = useSettingsSection('email');
  const manage = can('email.providers.manage');
  const templates = useQuery({
    queryKey: ['email-templates', { all: true }],
    queryFn: () => api.get<{ data: { id: string; key: string; locale: string; name: string }[] }>('/api/admin/email/templates'),
    enabled: can('email.templates.view'),
    staleTime: 60_000,
  });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useSaveSettings('email', { onSuccess: () => setDraft({}), onError: (e) => setError(errorMessage(e)) });
  if (!settings.allowed) return <Callout title="You cannot view these settings">Lifecycle emails are switched on and off in the email settings, which need permission to view system settings.</Callout>;
  if (settings.isLoading) return <Skeleton className="h-96" />;
  if (settings.error || !settings.section) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const value = { ...settings.section.value, ...draft };
  const dirty = Object.keys(draft).some((k) => draft[k] !== settings.section!.value[k]);
  const templateId = (key: string) => {
    const rows = (templates.data?.data ?? []).filter((t) => t.key === key);
    return (rows.find((t) => t.locale === 'en') ?? rows[0])?.id;
  };
  return (
    <Card
      title="Lifecycle emails"
      description="Sent automatically when something happens to a customer's account or subscription. Each is sent once per occasion; edit the wording in Email templates."
      actions={
        manage && (
          <Button
            size="sm"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(draft);
            }}
          >
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
        )
      }
      padded={false}
    >
      <div className="px-4 pt-3">
        <FormError message={error} />
      </div>
      <ul className="divide-y">
        {AUTOMATIONS.map((a) => (
          <li key={a.key} className="space-y-2 px-4 py-3">
            <Switch checked={Boolean(value[a.key])} disabled={!manage} onCheckedChange={(on) => setDraft((d) => ({ ...d, [a.key]: on }))} label={a.label} description={a.description} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {a.days && (
                <label className="inline-flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{a.days.label}</span>
                  <Input
                    type="number"
                    min={a.days.min}
                    max={a.days.max}
                    step={1}
                    className="w-20"
                    value={String(value[a.days.key] ?? '')}
                    disabled={!manage || !value[a.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [a.days!.key]: e.target.value === '' ? '' : Number(e.target.value) }))}
                  />
                </label>
              )}
              {a.templates.map((key) => {
                const id = templateId(key);
                return id ? (
                  <Link key={key} to={`/growth/email/templates/${id}`} className="text-sm text-primary hover:underline">
                    Edit “{templates.data?.data.find((t) => t.id === id)?.name ?? key}”
                  </Link>
                ) : (
                  <Badge key={key}>{key}</Badge>
                );
              })}
            </div>
          </li>
        ))}
        <li className="px-4 py-3 text-sm text-muted-foreground">Card expiry warnings are sent by billing; set how many days ahead in Settings → Billing.</li>
      </ul>
    </Card>
  );
}

export default function AutorespondersPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('sequences');
  return (
    <>
      <PageHeader
        title="Autoresponders"
        description="Email sequences sent on a schedule after signup, a purchase, a subscription starting or ending, or ahead of a renewal, and the lifecycle emails every customer receives."
        actions={
          can('email.autoresponders.manage') && (
            <ButtonLink to="/growth/email/autoresponders/new" variant="primary" icon={<Plus className="size-4" />}>
              New autoresponder
            </ButtonLink>
          )
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'sequences', label: 'Autoresponders', content: <SequencesTab /> },
          { value: 'lifecycle', label: 'Lifecycle emails', content: tab === 'lifecycle' && <LifecycleTab /> },
        ]}
      />
    </>
  );
}
