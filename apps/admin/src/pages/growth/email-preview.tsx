import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import { Badge, Callout, Card, Skeleton } from '../../components/ui';
import { HtmlPreview } from './shared';

export interface RenderedPreview {
  subject: string;
  html: string;
  text: string;
  variables: string[];
  missingVariables: string[];
}

export interface PreviewInput {
  subject: string;
  html: string;
  text?: string | null;
  category: string;
  data?: Record<string, unknown>;
}

/** Server-side render of a draft (the same engine that sends), debounced while typing. Nothing is sent. */
export function useEmailPreview(input: PreviewInput | null) {
  const { can } = useAuth();
  const key = input ? JSON.stringify(input) : '';
  const debounced = useDebounced(key, 450);
  const query = useQuery({
    queryKey: ['email-preview', debounced],
    queryFn: () => api.post<RenderedPreview>('/api/admin/email/templates/preview', JSON.parse(debounced)),
    enabled: Boolean(debounced) && can('email.templates.view'),
    placeholderData: keepPreviousData,
    retry: false,
  });
  return { ...query, stale: query.isFetching || key !== debounced, allowed: can('email.templates.view') };
}

export function PreviewPanel({ input, title = 'Preview', description }: { input: PreviewInput | null; title?: string; description?: string }) {
  const preview = useEmailPreview(input);
  const [view, setView] = useState<'html' | 'text'>('html');
  const p = preview.data;
  return (
    <Card
      title={title}
      description={description ?? 'Rendered with sample data by the sending engine'}
      actions={
        <div role="radiogroup" aria-label="Preview format" className="inline-flex rounded-ui-sm border p-0.5 text-xs">
          {(['html', 'text'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)} className={clsx('rounded-[calc(var(--radius)-3px)] px-2 py-0.5 font-medium', view === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {v === 'html' ? 'HTML' : 'Plain text'}
            </button>
          ))}
        </div>
      }
    >
      {!preview.allowed ? (
        <p className="text-sm text-muted-foreground">Previews need permission to view email templates.</p>
      ) : !input ? (
        <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
      ) : preview.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6" />
          <Skeleton className="h-80" />
        </div>
      ) : preview.error ? (
        <Callout tone="warning" title="This draft cannot be rendered">
          {preview.error instanceof ApiError && preview.error.code === 'validation_error' ? errorMessage(preview.error) : 'The preview failed. Check the template syntax.'}
        </Callout>
      ) : p ? (
        <div className={clsx('space-y-3 transition-opacity', preview.stale && 'opacity-60')}>
          <div className="rounded-ui-sm border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Subject: </span>
            <span className="font-medium">{p.subject || <em className="text-muted-foreground">empty</em>}</span>
          </div>
          {p.missingVariables.length > 0 && (
            <Callout tone="warning" title="Variables without sample data">
              <span className="flex flex-wrap gap-1">
                {p.missingVariables.map((v) => (
                  <Badge key={v} tone="warning">
                    {v}
                  </Badge>
                ))}
              </span>
              <span className="mt-1 block">They render empty in this preview. Make sure the sending code provides them.</span>
            </Callout>
          )}
          {view === 'html' ? <HtmlPreview html={p.html} /> : <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-ui border bg-muted/40 p-3 font-mono text-xs">{p.text}</pre>}
        </div>
      ) : null}
    </Card>
  );
}
