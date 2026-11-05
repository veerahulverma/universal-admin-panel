import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './button';

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const ToastContext = createContext<{ push: (t: Omit<ToastItem, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = Date.now() + Math.random();
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleAlert : Info;
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-ui border bg-surface p-3 shadow-lg animate-pop-in">
              <Icon className={clsx('mt-0.5 size-4 shrink-0', t.tone === 'success' && 'text-success', t.tone === 'error' && 'text-danger', t.tone === 'info' && 'text-info')} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 break-words text-sm text-muted-foreground">{t.description}</p>}
              </div>
              <button className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return {
    success: (title: string, description?: string) => ctx.push({ tone: 'success', title, description }),
    error: (title: string, description?: string) => ctx.push({ tone: 'error', title, description }),
    info: (title: string, description?: string) => ctx.push({ tone: 'info', title, description }),
  };
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle className={clsx('size-4 animate-spin text-muted-foreground', className)} aria-label={label} role="status" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton rounded-ui-sm', className)} aria-hidden="true" />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 rounded-full bg-muted p-3 text-muted-foreground [&>svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = error instanceof Error ? error.message : 'Unexpected error';
  const forbidden = (error as { status?: number })?.status === 403;
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title={forbidden ? 'You do not have access to this' : title}
      description={forbidden ? 'Ask an administrator for the required permission.' : message}
      action={onRetry && !forbidden ? <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button> : undefined}
    />
  );
}

export function Callout({ tone = 'info', title, children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'info' ? Info : TriangleAlert;
  const tones = {
    info: 'border-info/25 bg-info/5 [&_svg]:text-info',
    warning: 'border-warning/30 bg-warning/5 [&_svg]:text-warning',
    danger: 'border-danger/30 bg-danger/5 [&_svg]:text-danger',
    success: 'border-success/30 bg-success/5 [&_svg]:text-success',
  };
  return (
    <div className={clsx('flex items-start gap-3 rounded-ui border px-3.5 py-3 text-sm', tones[tone])} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={clsx('text-sm text-muted-foreground', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}
