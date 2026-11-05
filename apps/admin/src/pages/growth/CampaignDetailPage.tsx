import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, Mail, MoreHorizontal, Send, Trash2, XCircle } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { dateTime, num, pct } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ErrorState,
  Field,
  FormError,
  Input,
  KeyValue,
  KpiTile,
  Menu,
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  Skeleton,
  Textarea,
  When,
  useConfirm,
  useToast,
  type MenuItem,
} from '../../components/ui';
import { PreviewPanel, type PreviewInput } from './email-preview';
import type { Segment } from './segment-rules';
import { MoneyList, StatusPill, reasonLabel, toLocalInput } from './shared';
import { audienceBody, audienceOptions, audienceValue, useMailingLists, type ListDetail, type MailingList } from '../lists/shared';

interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';
  segment_id: string | null;
  list_id: string | null;
  subject: string;
  html: string;
  text: string | null;
  template_key: string | null;
  utm_campaign: string | null;
  batch_size: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  stats: { audience?: number; error?: string };
  created_at: string;
  updated_at: string;
  results: {
    recipients: { status: 'pending' | 'queued' | 'skipped'; skip_reason: string | null; count: number }[];
    messages: Record<string, number>;
    opened: number;
    clicked: number;
    openRate: number;
    clickRate: number;
    revenue: { currency: string; amount: number; orders: number }[];
  };
}

interface TemplateRow {
  id: string;
  key: string;
  locale: string;
  name: string;
  category: string;
  subject: string;
  html: string;
  text: string | null;
  sample_data: Record<string, unknown>;
}

/** Same slug rule as the server (utmParams in modules/marketing/campaigns.ts), shown so marketers know what links carry. */
function utmSlug(c: { id: string; name: string; utm_campaign: string | null }): string {
  return (c.utm_campaign || c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || c.id;
}

/** Who would receive the campaign right now: a segment's matches, or a list's subscribers. */
function useAudience(campaign: Campaign, segment: Segment | null) {
  const { can } = useAuth();
  const segmentReach = useQuery({
    queryKey: ['segment-preview', JSON.stringify(segment?.rules ?? null)],
    queryFn: () => api.post<{ total: number; reachable: number }>('/api/admin/segments/preview', { rules: segment!.rules }),
    enabled: !campaign.list_id && Boolean(segment) && can('marketing.segments.view'),
  });
  const listReach = useQuery({
    queryKey: ['mailing-list', campaign.list_id],
    queryFn: () => api.get<ListDetail>(`/api/admin/lists/${campaign.list_id}`),
    enabled: Boolean(campaign.list_id) && can('marketing.lists.view'),
    select: (l) => ({ total: l.counts.subscribed, reachable: l.counts.reachable }),
  });
  return campaign.list_id ? listReach : segmentReach;
}

function ScheduleDialog({ campaign, segment, open, onOpenChange }: { campaign: Campaign; segment: Segment | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audience = useAudience(campaign, segment);
  const schedule = useAction(() => api.post(`/api/admin/campaigns/${campaign.id}/schedule`, when === 'later' ? { sendAt: new Date(at).toISOString() } : {}), {
    success: when === 'now' ? 'Campaign is sending' : 'Campaign scheduled',
    invalidate: [['campaign', campaign.id], ['campaigns']],
    onSuccess: () => onOpenChange(false),
    onError: (e) => setError(errorMessage(e)),
  });
  const reachable = audience.data?.reachable;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Send “${campaign.name}”`}
      description="The audience is frozen when sending starts. Consent, unsubscribes and suppressions are checked again for every recipient."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => schedule.mutate()} loading={schedule.isPending} disabled={!ack || (when === 'later' && !at)} icon={<Send className="size-4" />}>
            {when === 'now' ? 'Send now' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <div className="rounded-ui-sm bg-muted/50 px-3 py-2.5 text-sm">
          {audience.isLoading ? (
            <Skeleton className="h-5 w-48" />
          ) : audience.data ? (
            <>
              <strong className="tabular">{num(audience.data.reachable)}</strong> people can receive it right now
              {audience.data.total > audience.data.reachable && (
                <span className="text-muted-foreground"> ({num(audience.data.total - audience.data.reachable)} {campaign.list_id ? 'subscribers' : 'in the segment'} are excluded: no consent, unsubscribed or suppressed)</span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Audience size unavailable.</span>
          )}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">When</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} className="accent-[var(--color-primary)]" /> Send now
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} className="accent-[var(--color-primary)]" /> Schedule for later
          </label>
          {when === 'later' && <Input type="datetime-local" aria-label="Send at" value={at} min={toLocalInput(new Date())} onChange={(e) => setAt(e.target.value)} className="w-auto" />}
        </fieldset>
        <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} label={reachable !== undefined ? `I want to email ${num(reachable)} people` : 'I reviewed the content and the audience'} description="Sent emails cannot be recalled." />
      </div>
    </Modal>
  );
}

function TestDialog({ campaign, open, onOpenChange }: { campaign: Campaign; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [to, setTo] = useState(me?.admin.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const send = useAction(() => api.post<{ id: string; status: string; reason: string | null }>(`/api/admin/campaigns/${campaign.id}/test`, { to }), {
    onSuccess: (r) => {
      if (r.status === 'queued') toast.success('Test email queued', `Sent to ${to}. It is marked as a test and skips consent checks.`);
      else toast.error('Test not sent', reasonLabel(r.reason));
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Send a test"
      description="Uses the saved version of the campaign, with a [Test] subject prefix."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} loading={send.isPending} disabled={!to}>
            Send test
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <Field label="Send to" htmlFor="test-to">
        <Input id="test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
      </Field>
    </Modal>
  );
}

function Results({ c }: { c: Campaign }) {
  const r = c.results;
  const sent = r.messages.sent ?? 0;
  const audience = c.stats.audience ?? r.recipients.reduce((s, x) => s + x.count, 0);
  const skipped = r.recipients.filter((x) => x.status === 'skipped');
  const pending = r.recipients.find((x) => x.status === 'pending')?.count ?? 0;
  const delivered = r.recipients.find((x) => x.status === 'queued')?.count ?? 0;
  return (
    <div className="space-y-4">
      {c.status === 'sending' && (
        <Card title="Sending in batches">
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={audience} aria-valuenow={audience - pending} aria-label="Sending progress">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${audience ? ((audience - pending) / audience) * 100 : 0}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {num(audience - pending)} of {num(audience)} processed · {c.batch_size} per batch
          </p>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Audience" value={audience} display={num(audience)} hint={`${num(delivered)} queued for delivery`} />
        <KpiTile label="Sent" value={sent} display={num(sent)} hint={r.messages.bounced ? `${num(r.messages.bounced)} bounced` : undefined} />
        <KpiTile label="Opened" value={r.opened} display={pct(r.openRate)} hint={`${num(r.opened)} people · provider-reported`} />
        <KpiTile label="Clicked" value={r.clicked} display={pct(r.clickRate)} hint={`${num(r.clicked)} people`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Who did not receive it" description="Excluded automatically to respect consent and deliverability">
          {skipped.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody was excluded.</p>
          ) : (
            <ul className="divide-y">
              {skipped.map((s) => (
                <li key={s.skip_reason ?? 'unknown'} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>{reasonLabel(s.skip_reason)}</span>
                  <span className="font-semibold tabular">{num(s.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Attributed revenue" description="Orders paid within the attribution window after receiving this campaign">
          {r.revenue.length === 0 ? (
            <p className="text-sm text-muted-foreground">No attributed orders yet.</p>
          ) : (
            <div className="space-y-1">
              <MoneyList items={r.revenue.map((x) => ({ currency: x.currency, amount: x.amount }))} className="text-lg font-semibold" />
              <p className="text-sm text-muted-foreground">{num(r.revenue.reduce((s, x) => s + x.orders, 0))} orders</p>
            </div>
          )}
        </Card>
      </div>
      {Object.keys(r.messages).length > 0 && (
        <Card title="Delivery" actions={<Link to={`/growth/email/messages?campaignId=${c.id}`} className="text-sm text-primary hover:underline">View messages</Link>}>
          <div className="flex flex-wrap gap-2">
            {Object.entries(r.messages).map(([status, count]) => (
              <span key={status} className="inline-flex items-center gap-1.5 rounded-ui-sm border px-2.5 py-1 text-sm">
                <StatusPill status={status} /> <span className="font-semibold tabular">{num(count)}</span>
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Editor({ c, segments, lists, templates, editable, onDirtyChange }: { c: Campaign; segments: Segment[]; lists: MailingList[]; templates: { key: string; name: string }[]; editable: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const [form, setForm] = useState({
    name: c.name,
    audience: audienceValue(c),
    mode: c.template_key ? 'template' : 'custom',
    templateKey: c.template_key ?? '',
    subject: c.subject,
    html: c.html,
    text: c.text ?? '',
    utmCampaign: c.utm_campaign ?? '',
    batchSize: String(c.batch_size),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const dirty =
    form.name !== c.name ||
    form.audience !== audienceValue(c) ||
    (form.mode === 'template' ? form.templateKey !== (c.template_key ?? '') : Boolean(c.template_key) || form.subject !== c.subject || form.html !== c.html || form.text !== (c.text ?? '')) ||
    form.utmCampaign !== (c.utm_campaign ?? '') ||
    form.batchSize !== String(c.batch_size);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = useAction(
    () =>
      api.patch(`/api/admin/campaigns/${c.id}`, {
        name: form.name,
        ...audienceBody(form.audience),
        templateKey: form.mode === 'template' ? form.templateKey : null,
        subject: form.subject,
        html: form.html,
        text: form.text || null,
        utmCampaign: form.utmCampaign || null,
        batchSize: Number(form.batchSize),
      }),
    {
      success: 'Campaign saved',
      invalidate: [['campaign', c.id], ['campaigns']],
      onSuccess: () => setErrors({}),
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );

  // Template mode previews the stored template (English or first locale) with its own sample data.
  const tplRows = useQuery({
    queryKey: ['email-templates', { key: form.templateKey }],
    queryFn: () => api.get<{ data: { id: string; locale: string }[] }>('/api/admin/email/templates', { key: form.templateKey }),
    enabled: form.mode === 'template' && Boolean(form.templateKey),
  });
  const tplId = tplRows.data?.data.find((t) => t.locale === 'en')?.id ?? tplRows.data?.data[0]?.id;
  const tpl = useQuery({ queryKey: ['email-template', tplId], queryFn: () => api.get<TemplateRow>(`/api/admin/email/templates/${tplId}`), enabled: Boolean(tplId) });
  const previewInput: PreviewInput | null = useMemo(() => {
    if (form.mode === 'template') return tpl.data ? { subject: tpl.data.subject, html: tpl.data.html, text: tpl.data.text, category: 'marketing', data: { ...tpl.data.sample_data, campaign: { name: form.name } } } : null;
    return form.html ? { subject: form.subject, html: form.html, text: form.text || null, category: 'marketing', data: { campaign: { name: form.name } } } : null;
  }, [form.mode, form.subject, form.html, form.text, form.name, tpl.data]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Card
          title="Campaign"
          actions={
            editable && (
              <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>
                {dirty ? 'Save changes' : 'Saved'}
              </Button>
            )
          }
        >
          <div className="space-y-3">
            <FormError message={error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="cd-name" error={errors.name}>
                <Input id="cd-name" value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!editable} required maxLength={200} />
              </Field>
              <Field label="Audience" htmlFor="cd-segment" error={errors.segmentId ?? errors.listId}>
                <Select id="cd-segment" value={form.audience} onChange={(e) => set('audience', e.target.value)} disabled={!editable} options={audienceOptions(segments, lists)} placeholder="Choose a segment or list" />
              </Field>
              <Field label="Content" htmlFor="cd-mode">
                <Select id="cd-mode" value={form.mode} onChange={(e) => set('mode', e.target.value)} disabled={!editable} options={[{ value: 'custom', label: 'One-off message' }, { value: 'template', label: 'Marketing template' }]} />
              </Field>
              {form.mode === 'template' && (
                <Field label="Template" htmlFor="cd-template" error={errors.templateKey}>
                  <Select id="cd-template" value={form.templateKey} onChange={(e) => set('templateKey', e.target.value)} disabled={!editable} placeholder="Choose a template" required options={templates.map((t) => ({ value: t.key, label: `${t.name} (${t.key})` }))} />
                </Field>
              )}
            </div>
            {form.mode === 'custom' ? (
              <>
                <Field label="Subject" htmlFor="cd-subject" error={errors.subject}>
                  <Input id="cd-subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} disabled={!editable} maxLength={500} required />
                </Field>
                <Field label="HTML body" htmlFor="cd-html" error={errors.html} hint="Variables: {{recipient.name}}, {{appName}}, {{appUrl}}, {{campaign.name}}. Values are escaped. The unsubscribe footer is added automatically.">
                  <Textarea id="cd-html" rows={14} value={form.html} onChange={(e) => set('html', e.target.value)} disabled={!editable} className="font-mono text-xs" spellCheck={false} required />
                </Field>
                <Field label="Plain-text version" htmlFor="cd-text" error={errors.text} hint="Optional; generated from the HTML when empty">
                  <Textarea id="cd-text" rows={4} value={form.text} onChange={(e) => set('text', e.target.value)} disabled={!editable} className="font-mono text-xs" />
                </Field>
              </>
            ) : (
              form.templateKey && (
                <p className="text-sm text-muted-foreground">
                  Edit the wording in <Link to={tplId ? `/growth/email/templates/${tplId}` : '/growth/email/templates'} className="text-primary hover:underline">the template editor</Link>. Each recipient gets their language’s translation when one exists.
                </p>
              )
            )}
          </div>
        </Card>
        <Card title="Delivery options">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="utm_campaign tag" htmlFor="cd-utm" error={errors.utmCampaign} hint={`Links get utm_source=email, utm_medium=campaign, utm_campaign=${utmSlug({ id: c.id, name: form.name, utm_campaign: form.utmCampaign || null })}`}>
              <Input id="cd-utm" value={form.utmCampaign} onChange={(e) => set('utmCampaign', e.target.value)} disabled={!editable} maxLength={100} placeholder="Defaults to the name" />
            </Field>
            <Field label="Batch size" htmlFor="cd-batch" error={errors.batchSize} hint="Emails queued per batch; batches are spaced out to protect your sender reputation">
              <Input id="cd-batch" type="number" min={1} max={5000} value={form.batchSize} onChange={(e) => set('batchSize', e.target.value)} disabled={!editable} />
            </Field>
          </div>
        </Card>
      </form>
      <PreviewPanel input={previewInput} description={dirty ? 'Unsaved draft, rendered with sample data' : undefined} />
    </div>
  );
}

export default function CampaignDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [scheduling, setScheduling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const q = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<Campaign>(`/api/admin/campaigns/${id}`),
    refetchInterval: (query) => (query.state.data?.status === 'sending' ? 5_000 : query.state.data?.status === 'scheduled' ? 30_000 : false),
  });
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<{ data: Segment[] }>('/api/admin/segments'), enabled: can('marketing.segments.view') });
  const lists = useMailingLists(can('marketing.lists.view'));
  const templates = useQuery({ queryKey: ['email-templates', { category: 'marketing' }], queryFn: () => api.get<{ data: { key: string; name: string }[] }>('/api/admin/email/templates', { category: 'marketing' }), enabled: can('email.templates.view') });
  const cancel = useAction(() => api.post(`/api/admin/campaigns/${id}/cancel`), { success: 'Campaign canceled', invalidate: [['campaign', id], ['campaigns']] });
  const remove = useAction(() => api.delete(`/api/admin/campaigns/${id}`), { success: 'Draft deleted', invalidate: [['campaigns']], onSuccess: () => navigate('/growth/campaigns') });
  const duplicate = useAction(
    (c: Campaign) =>
      api.post<{ id: string }>('/api/admin/campaigns', {
        name: `${c.name} (copy)`.slice(0, 200),
        ...audienceBody(audienceValue(c)),
        subject: c.subject,
        html: c.html,
        text: c.text,
        templateKey: c.template_key,
        utmCampaign: c.utm_campaign,
        batchSize: c.batch_size,
      }),
    { success: 'Copied to a new draft', invalidate: [['campaigns']], onSuccess: (r) => navigate(`/growth/campaigns/${r.id}`) },
  );

  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const editable = can('marketing.campaigns.manage') && (c.status === 'draft' || c.status === 'scheduled');
  const segment = segments.data?.data.find((s) => s.id === c.segment_id) ?? null;
  const mailingList = lists.data?.data.find((l) => l.id === c.list_id) ?? null;
  const uniqueTemplates = [...new Map((templates.data?.data ?? []).map((t) => [t.key, t])).values()];
  const started = Boolean(c.started_at);

  const menu: MenuItem[] = [
    { label: 'Send a test', icon: <Mail className="size-4" />, onSelect: () => setTesting(true), hidden: !can('marketing.campaigns.manage') },
    { label: 'Duplicate', icon: <Copy className="size-4" />, onSelect: () => duplicate.mutate(c), hidden: !can('marketing.campaigns.manage') || (!c.segment_id && !c.list_id) },
    { separator: true, label: '' },
    {
      label: c.status === 'sending' ? 'Stop sending' : 'Cancel campaign',
      icon: <XCircle className="size-4" />,
      danger: true,
      hidden: !can('marketing.campaigns.send') || !['scheduled', 'sending'].includes(c.status),
      onSelect: async () => {
        const r = await confirm({
          title: c.status === 'sending' ? 'Stop sending now?' : 'Cancel this scheduled campaign?',
          description: c.status === 'sending' ? 'Emails already queued still go out; remaining recipients are skipped. A canceled campaign cannot be restarted (duplicate it instead).' : 'It will not be sent. A canceled campaign cannot be rescheduled; duplicate it to send later.',
          tone: 'danger',
          confirmLabel: c.status === 'sending' ? 'Stop sending' : 'Cancel campaign',
        });
        if (r.confirmed) cancel.mutate();
      },
    },
    {
      label: 'Delete draft',
      icon: <Trash2 className="size-4" />,
      danger: true,
      hidden: !can('marketing.campaigns.manage') || c.status !== 'draft',
      onSelect: async () => {
        if ((await confirm({ title: `Delete “${c.name}”?`, tone: 'danger', confirmLabel: 'Delete' })).confirmed) remove.mutate();
      },
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Campaigns', to: '/growth/campaigns' }, { label: c.name }]}
        title={c.name}
        meta={
          <>
            <StatusPill status={c.status} />
            {c.status === 'scheduled' && c.scheduled_at && <span className="text-sm text-muted-foreground">Sends {dateTime(c.scheduled_at)}</span>}
            {c.completed_at && <span className="text-sm text-muted-foreground">Finished {dateTime(c.completed_at)}</span>}
            {c.stats.error && <Badge tone="danger">{c.stats.error.replace(/_/g, ' ')}</Badge>}
          </>
        }
        actions={
          <>
            {can('marketing.campaigns.send') && c.status === 'draft' && (
              <Button icon={<Send className="size-4" />} onClick={() => setScheduling(true)} disabled={dirty} title={dirty ? 'Save your changes first' : undefined}>
                Schedule or send
              </Button>
            )}
            <Menu trigger={<Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>} items={menu} />
          </>
        }
      />

      {c.status === 'scheduled' && (
        <div className="mb-4">
          <Callout title="Scheduled">Edits you save before {dateTime(c.scheduled_at)} are included. To change the time, cancel and duplicate the campaign.</Callout>
        </div>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="Audience" className="lg:col-span-2">
          {segment || mailingList ? (
            <KeyValue
              items={[
                segment
                  ? { label: 'Segment', value: <Link to={`/growth/segments/${segment.id}`} className="text-primary hover:underline">{segment.name}</Link> }
                  : { label: 'Mailing list', value: <Link to={`/growth/lists/${mailingList!.id}`} className="text-primary hover:underline">{mailingList!.name}</Link> },
                { label: 'Frozen at send', value: c.stats.audience !== undefined ? `${num(c.stats.audience)} recipients` : 'Not yet' },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{c.segment_id || c.list_id ? 'Audience details unavailable.' : 'No audience selected.'}</p>
          )}
          {mailingList && <p className="mt-3 text-xs text-muted-foreground">List email reaches subscribers who opted in to the list, or who consented to marketing; its unsubscribe link leaves only this list.</p>}
        </Card>
        <Card title="Timeline">
          <KeyValue
            columns={1}
            items={[
              { label: 'Created', value: <When value={c.created_at} /> },
              { label: 'Started', value: c.started_at ? <When value={c.started_at} /> : null, hidden: !c.started_at },
              { label: 'Canceled', value: <When value={c.canceled_at} />, hidden: !c.canceled_at },
            ]}
          />
        </Card>
      </div>

      {started && (
        <div className="mb-6">
          <Results c={c} />
        </div>
      )}

      {segments.isLoading || lists.isLoading || templates.isLoading ? (
        <PageSkeleton />
      ) : (
        <Editor key={c.updated_at} c={c} segments={segments.data?.data ?? []} lists={lists.data?.data ?? []} templates={uniqueTemplates} editable={editable} onDirtyChange={setDirty} />
      )}

      {scheduling && <ScheduleDialog campaign={c} segment={segment} open={scheduling} onOpenChange={setScheduling} />}
      {testing && <TestDialog campaign={c} open={testing} onOpenChange={setTesting} />}
    </>
  );
}
