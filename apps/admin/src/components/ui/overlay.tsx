import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Dialog as RDialog, DropdownMenu, Popover as RPopover, Tooltip as RTooltip } from 'radix-ui';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { Button } from './button';
import { Input } from './form';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] animate-fade-in" />
        <RDialog.Content
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-ui border bg-surface shadow-xl animate-pop-in',
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="text-base font-semibold">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-muted-foreground">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RDialog.Description>}
            </div>
            <RDialog.Close className="-mr-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Side panel; used for the mobile navigation drawer and record previews. */
export function Sheet({ open, onOpenChange, side = 'left', title, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; side?: 'left' | 'right'; title: string; children: ReactNode; className?: string }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
        <RDialog.Content className={clsx('fixed inset-y-0 z-50 flex w-[min(20rem,85vw)] flex-col bg-surface shadow-xl animate-slide-in', side === 'left' ? 'left-0 border-r' : 'right-0 border-l', className)}>
          <RDialog.Title className="sr-only">{title}</RDialog.Title>
          <RDialog.Description className="sr-only">{title}</RDialog.Description>
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
  /** Ask the admin to type this exact text first (irreversible actions). */
  typeToConfirm?: string;
  /** Optional free-text reason collected with the confirmation. */
  reason?: { label: string; required?: boolean; placeholder?: string };
}

type ConfirmResult = { confirmed: boolean; reason?: string };
const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<ConfirmResult>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const resolver = useRef<((r: ConfirmResult) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setTyped('');
    setReason('');
    setOpts(o);
    return new Promise<ConfirmResult>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (confirmed: boolean) => {
    resolver.current?.({ confirmed, reason: reason.trim() || undefined });
    resolver.current = null;
    setOpts(null);
  };

  const blocked = Boolean(opts && ((opts.typeToConfirm && typed !== opts.typeToConfirm) || (opts.reason?.required && !reason.trim())));

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(opts)}
        onOpenChange={(o) => !o && close(false)}
        title={opts?.title ?? ''}
        description={opts?.description}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={opts?.tone === 'danger' ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)}>
              {opts?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {opts?.reason && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="confirm-reason">
              {opts.reason.label}
            </label>
            <Input id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={opts.reason.placeholder} autoFocus />
          </div>
        )}
        {opts?.typeToConfirm && (
          <div className="mt-3 space-y-1.5">
            <label className="text-sm" htmlFor="confirm-type">
              Type <code className="rounded bg-muted px-1 font-mono text-xs">{opts.typeToConfirm}</code> to confirm
            </label>
            <Input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus={!opts.reason} />
          </div>
        )}
        {!opts?.reason && !opts?.typeToConfirm && <p className="text-sm text-muted-foreground">This action is recorded in the audit log.</p>}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hidden?: boolean;
}

export function Menu({ trigger, items, align = 'end' }: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' }) {
  const visible = items.filter((i) => !i.hidden);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-ui border bg-surface p-1 shadow-lg animate-pop-in">
          {visible.map((item, i) =>
            item.separator ? (
              <DropdownMenu.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
            ) : (
              <DropdownMenu.Item
                key={i}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={clsx(
                  'flex cursor-pointer select-none items-center gap-2 rounded-ui-sm px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  item.danger && 'text-danger',
                )}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={300}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-ui-sm bg-foreground px-2 py-1 text-xs text-background shadow animate-fade-in">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Popover({ trigger, children, align = 'end', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; className?: string }) {
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content align={align} sideOffset={6} className={clsx('z-50 rounded-ui border bg-surface shadow-lg animate-pop-in', className)}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;
