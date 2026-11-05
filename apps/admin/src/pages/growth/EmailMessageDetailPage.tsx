import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime } from '../../lib/format';
import { Badge, Button, Callout, Card, CodeBlock, EmptyState, ErrorState, JsonView, KeyValue, Mono, PageHeader, PageSkeleton, Tabs } from '../../components/ui';
import { HtmlPreview, StatusPill, reasonLabel, useTabParam } from './shared';

interface Message {
  id: string;
  to_email: string;
  user_id: string | null;
  org_id: string | null;
  template_key: string | null;
  locale: string | null;
  category: string;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  status: string;
  suppression_reason: string | null;
  attempts: number;
  provider_id: string | null;
  provider_type: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  campaign_id: string | null;
  metadata: Record<string, unknown>;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  created_at: string;
  updated_at: string;
}

export default function EmailMessageDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useTabParam('preview');
  const q = useQuery({
    queryKey: ['email-message', id],
    queryFn: () => api.get<Message>(`/api/admin/email/messages/${id}`),
    refetchInterval: (query) => (['queued', 'sending'].includes(query.state.data?.status ?? '') ? 5_000 : false),
  });
  const resend = useAction(() => api.post(`/api/admin/email/messages/${id}/resend`), { success: 'Queued for another delivery attempt', invalidate: [['email-message', id], ['email-messages']] });

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const m = q.data;
  const isTest = Boolean(m.metadata?.test);

  const timeline = (
    [
      ['Queued', m.created_at],
      ['Handed to provider', m.sent_at],
      ['Delivered', m.delivered_at],
      ['Opened', m.opened_at],
      ['Clicked a link', m.clicked_at],
      ['Bounced', m.bounced_at],
    ] as const
  ).filter(([, at]) => Boolean(at));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Email log', to: '/growth/email/messages' }, { label: m.subject }]}
        documentTitle={m.subject}
        title={m.subject}
        description={`To ${m.to_email}`}
        meta={
          <>
            <StatusPill status={m.status} />
            <Badge tone={m.category === 'marketing' ? 'primary' : 'neutral'}>{m.category}</Badge>
            {isTest && <Badge tone="info">test send</Badge>}
          </>
        }
        actions={
          m.status === 'failed' &&
          can('email.providers.manage') && (
            <Button icon={<RotateCcw className="size-4" />} onClick={() => resend.mutate()} loading={resend.isPending}>
              Try again
            </Button>
          )
        }
      />

      {m.status === 'suppressed' && (
        <div className="mb-4">
          <Callout tone="warning" title={`Not sent: ${reasonLabel(m.suppression_reason)}`}>
            Consent and suppressions are checked when an email is queued and again just before delivery. See <Link to="/growth/email/messages?tab=suppressions" className="text-primary hover:underline">suppressions</Link>.
          </Callout>
        </div>
      )}
      {m.last_error && (
        <div className="mb-4">
          <Callout tone={m.status === 'failed' ? 'danger' : 'warning'} title={m.status === 'failed' ? 'Delivery failed' : 'A provider failed; the next one in the chain was used'}>
            <span className="break-words font-mono text-xs">{m.last_error}</span>
          </Callout>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <KeyValue
            items={[
              { label: 'Recipient', value: m.user_id ? <Link to={`/customers/users/${m.user_id}`} className="text-primary hover:underline">{m.to_email}</Link> : m.to_email },
              { label: 'Template', value: m.template_key ? <Link to={`/growth/email/templates?q=${encodeURIComponent(m.template_key)}`} className="font-mono text-xs text-primary hover:underline">{m.template_key}{m.locale ? ` (${m.locale})` : ''}</Link> : m.campaign_id ? 'Campaign content' : null },
              { label: 'Campaign', value: m.campaign_id ? <Link to={`/growth/campaigns/${m.campaign_id}`} className="text-primary hover:underline">View campaign</Link> : null, hidden: !m.campaign_id },
              { label: 'Provider', value: m.provider_type ? <span className="inline-flex flex-wrap items-center gap-1.5">{m.provider_type}{m.provider_message_id && <Mono copy>{m.provider_message_id}</Mono>}</span> : null },
              { label: 'Delivery attempts', value: String(m.attempts) },
              { label: 'Message ID', value: <Mono copy>{m.id}</Mono> },
            ]}
          />
        </Card>
        <Card title="Timeline">
          <ol className="space-y-2.5">
            {timeline.map(([label, at]) => (
              <li key={label} className="flex items-start gap-2.5 text-sm">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{dateTime(at)}</span>
                </span>
              </li>
            ))}
          </ol>
          {!m.delivered_at && m.sent_at && <p className="mt-3 text-xs text-muted-foreground">Delivery, opens and bounces appear when the provider’s event webhook is configured.</p>}
        </Card>
      </div>

      <div className="mt-6">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            {
              value: 'preview',
              label: 'Content',
              content: m.html ? <HtmlPreview html={m.html} title={`Email: ${m.subject}`} /> : <EmptyState title="No content stored" description="The content was removed (for example after a personal-data erasure) or the email failed before rendering." />,
            },
            { value: 'text', label: 'Plain text', content: m.text ? <CodeBlock code={m.text} /> : <EmptyState title="No plain-text version" /> },
            { value: 'headers', label: 'Headers', content: <JsonView value={m.headers ?? {}} /> },
            { value: 'metadata', label: 'Metadata', content: <JsonView value={m.metadata ?? {}} /> },
          ]}
        />
      </div>
    </>
  );
}
