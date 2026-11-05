import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Megaphone, Plus } from 'lucide-react';
import { api, ApiError, errorMessage, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { useUrlState } from '../../lib/hooks';
import { num } from '../../lib/format';
import { Button, ButtonLink, Callout, Card, DataTable, EmptyState, ErrorState, Field, FormError, Input, Modal, PageHeader, Pagination, Select, Toolbar, When } from '../../components/ui';
import type { Segment } from './segment-rules';
import { StatusPill } from './shared';
import { audienceBody, audienceOptions, useMailingLists } from '../lists/shared';

interface CampaignRow {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';
  segment_id: string | null;
  segment_name: string | null;
  list_id: string | null;
  list_name: string | null;
  subject: string;
  template_key: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  stats: { audience?: number; error?: string };
  created_at: string;
  sent_count: number;
}

interface TemplateSummary {
  id: string;
  key: string;
  locale: string;
  name: string;
  category: string;
}

const STARTER_HTML = `<h1 style="font-size:20px">A quick update from {{appName}}</h1>
<p>Hi{{#if recipient.name}} {{recipient.name}}{{/if}},</p>
<p>Write your message here.</p>
<p><a href="{{appUrl}}">Open {{appName}}</a></p>`;

function NewCampaignDialog({ open, onOpenChange, presetAudience }: { open: boolean; onOpenChange: (o: boolean) => void; presetAudience: string }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState({ name: '', audience: presetAudience, mode: 'custom', templateKey: '', subject: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const segments = useQuery({ queryKey: ['segments'], queryFn: () => api.get<{ data: Segment[] }>('/api/admin/segments'), enabled: open && can('marketing.segments.view') });
  const lists = useMailingLists(open && can('marketing.lists.view'));
  const audiences = audienceOptions(segments.data?.data ?? [], lists.data?.data ?? []);
  const noAudience = (segments.data || !can('marketing.segments.view')) && (lists.data || !can('marketing.lists.view')) && !audiences.length;
  const templates = useQuery({
    queryKey: ['email-templates', { category: 'marketing' }],
    queryFn: () => api.get<{ data: TemplateSummary[] }>('/api/admin/email/templates', { category: 'marketing' }),
    enabled: open && form.mode === 'template',
  });
  const create = useAction(
    () =>
      api.post<{ id: string }>('/api/admin/campaigns', {
        name: form.name,
        ...audienceBody(form.audience),
        ...(form.mode === 'template' ? { templateKey: form.templateKey } : { subject: form.subject || form.name, html: STARTER_HTML }),
      }),
    {
      success: 'Campaign draft created',
      invalidate: [['campaigns']],
      onSuccess: (c) => {
        onOpenChange(false);
        navigate(`/growth/campaigns/${c.id}`);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setErrors(e.fieldErrors());
      },
    },
  );
  const templateKeys = [...new Map((templates.data?.data ?? []).map((t) => [t.key, t])).values()];
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New campaign"
      description="Start a draft. You can edit the content, preview it and send yourself a test before scheduling."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-campaign" loading={create.isPending} disabled={!audiences.length}>
            Create draft
          </Button>
        </>
      }
    >
      {noAudience ? (
        <Callout title="Create a segment or a mailing list first" action={<ButtonLink to="/growth/segments/new" size="sm">New segment</ButtonLink>}>
          Campaigns are sent to a segment of your customers or to the subscribers of a mailing list.
        </Callout>
      ) : (
        <form
          id="new-campaign"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <FormError message={error} />
          <Field label="Campaign name" htmlFor="nc-name" hint="Internal; also used for the utm_campaign link tag" error={errors.name} required>
            <Input id="nc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} autoFocus placeholder="Spring launch" />
          </Field>
          <Field label="Audience" htmlFor="nc-segment" error={errors.segmentId ?? errors.listId} hint="A segment, or a mailing list's subscribers" required>
            <Select id="nc-segment" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} placeholder="Choose an audience" required options={audiences} />
          </Field>
          <Field label="Content" htmlFor="nc-mode">
            <Select id="nc-mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} options={[{ value: 'custom', label: 'Write a one-off message' }, { value: 'template', label: 'Use a marketing email template' }]} />
          </Field>
          {form.mode === 'template' ? (
            <Field label="Template" htmlFor="nc-template" error={errors.templateKey} hint="Translations are picked per recipient language" required>
              <Select id="nc-template" value={form.templateKey} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} placeholder={templates.isLoading ? 'Loading…' : 'Choose a template'} required options={templateKeys.map((t) => ({ value: t.key, label: `${t.name} (${t.key})` }))} />
            </Field>
          ) : (
            <Field label="Subject" htmlFor="nc-subject" hint="Defaults to the campaign name; editable later" error={errors.subject}>
              <Input id="nc-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={500} />
            </Field>
          )}
        </form>
      )}
    </Modal>
  );
}

const DEFAULTS = { status: '', page: 1, pageSize: 25 };

export default function CampaignsPage() {
  const { can } = useAuth();
  const [state, setState] = useUrlState(DEFAULTS);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const presetAudience = params.get('list') ? `list:${params.get('list')}` : params.get('segment') ? `segment:${params.get('segment')}` : '';

  // /growth/campaigns?new=1&segment=seg_... or &list=lst_... (from a segment or list page) opens the dialog with that audience.
  useEffect(() => {
    if (params.get('new') === '1' && can('marketing.campaigns.manage')) {
      setCreating(true);
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  }, [params, setParams, can]);

  const list = useQuery({
    queryKey: ['campaigns', state],
    queryFn: ({ signal }) => api.get<Page<CampaignRow>>('/api/admin/campaigns', { status: String(state.status), page: state.page, pageSize: state.pageSize }, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.data.some((c) => c.status === 'sending' || c.status === 'scheduled') ? 15_000 : false),
  });

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Email campaigns to customer segments. Only people who consented to marketing receive them; everyone gets a one-click unsubscribe link."
        actions={
          can('marketing.campaigns.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New campaign
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar>
          <Select
            aria-label="Status"
            className="w-auto"
            value={String(state.status)}
            onChange={(e) => setState({ status: e.target.value })}
            placeholder="Any status"
            options={[
              { value: 'draft', label: 'Draft' },
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'sending', label: 'Sending' },
              { value: 'sent', label: 'Sent' },
              { value: 'canceled', label: 'Canceled' },
            ]}
          />
        </Toolbar>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Campaigns"
            rows={list.data?.data}
            rowKey={(c) => c.id}
            rowHref={(c) => `/growth/campaigns/${c.id}`}
            loading={list.isLoading}
            fetching={list.isFetching && !list.isLoading}
            empty={
              state.status ? (
                <EmptyState title="No campaigns with this status" />
              ) : (
                <EmptyState icon={<Megaphone />} title="No campaigns yet" description="Announce features, win back churned customers or promote an upgrade to a segment." />
              )
            }
            columns={[
              {
                key: 'name',
                header: 'Campaign',
                cell: (c) => (
                  <span className="min-w-0">
                    <span className="block truncate">{c.name}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{c.template_key ? `Template ${c.template_key}` : c.subject || 'No subject yet'}</span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (c) => <StatusPill status={c.status} /> },
              { key: 'segment', header: 'Audience', cell: (c) => c.segment_name ?? (c.list_name ? `List: ${c.list_name}` : <span className="text-muted-foreground">—</span>) },
              { key: 'recipients', header: 'Sent', align: 'right', cell: (c) => (c.stats?.audience !== undefined ? <span className="tabular">{num(c.sent_count)} / {num(c.stats.audience)}</span> : <span className="text-muted-foreground">—</span>) },
              {
                key: 'when',
                header: 'When',
                cell: (c) =>
                  c.completed_at ? (
                    <span>
                      Sent <When value={c.completed_at} />
                    </span>
                  ) : c.status === 'scheduled' && c.scheduled_at ? (
                    <span>
                      Scheduled <When value={c.scheduled_at} relative={false} />
                    </span>
                  ) : (
                    <span>
                      Created <When value={c.created_at} />
                    </span>
                  ),
              },
            ]}
          />
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setState({ page: p }, { resetPage: false })} />}
      </Card>
      {creating && <NewCampaignDialog open={creating} onOpenChange={setCreating} presetAudience={presetAudience} />}
    </>
  );
}
