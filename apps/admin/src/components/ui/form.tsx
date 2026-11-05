import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Switch as RSwitch } from 'radix-ui';
import { Eye, EyeOff, Search, X } from 'lucide-react';
import clsx from 'clsx';

const control =
  'rounded-ui-sm border bg-surface px-3 text-base text-foreground md:text-sm placeholder:text-muted-foreground/70 shadow-ui transition-colors focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/20';

/** Controls fill their container unless the caller sets a width (w-40, w-auto, flex-1...). */
function width(className?: string): string | undefined {
  return className && /(^|\s)(w-|flex-1|min-w-)/.test(className) ? undefined : 'w-full';
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={clsx(control, 'h-9', width(className), className)} {...rest} />;
});

/** Password input with a show/hide toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { invalid?: boolean }>(function PasswordInput({ className, ...rest }, ref) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={visible ? 'text' : 'password'} className={clsx('pr-9', className)} {...rest} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={clsx(control, 'py-2 leading-relaxed', width(className), className)} {...rest} />;
});

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A labelled group of options (rendered as an optgroup). */
export interface OptionGroup {
  label: string;
  options: Option[];
}

function renderOption(o: Option | string) {
  const opt = typeof o === 'string' ? { value: o, label: o } : o;
  return (
    <option key={opt.value} value={opt.value} disabled={opt.disabled}>
      {opt.label}
    </option>
  );
}

/** Native select: accessible, keyboard- and touch-friendly on every device. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { options: (Option | OptionGroup | string)[]; placeholder?: string; invalid?: boolean }>(function Select(
  { options, placeholder, className, invalid, ...rest },
  ref,
) {
  return (
    <select ref={ref} aria-invalid={invalid || undefined} className={clsx(control, 'h-9 pr-8 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat', width(className), className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o, i) =>
        typeof o !== 'string' && 'options' in o ? (
          <optgroup key={`${i}-${o.label}`} label={o.label}>
            {o.options.map(renderOption)}
          </optgroup>
        ) : (
          renderOption(o)
        ),
      )}
    </select>
  );
});

export function Checkbox({ label, description, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={rest.id ?? id} className={clsx('flex items-start gap-2.5 text-sm cursor-pointer', className)}>
      <input id={rest.id ?? id} type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border accent-[var(--color-primary)] cursor-pointer" {...rest} />
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="font-medium">{label}</span>}
          {description && <span className="block text-muted-foreground text-sm">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const autoId = useId();
  const sid = id ?? autoId;
  return (
    <div className="flex items-start justify-between gap-4">
      {(label || description) && (
        <label htmlFor={sid} className="min-w-0 text-sm cursor-pointer">
          {label && <span className="font-medium">{label}</span>}
          {description && <span className="block text-muted-foreground text-sm">{description}</span>}
        </label>
      )}
      <RSwitch.Root
        id={sid}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="relative h-5 w-9 shrink-0 rounded-full bg-muted-foreground/30 transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
      >
        <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </RSwitch.Root>
    </div>
  );
}

export function Field({ label, hint, error, children, required, className, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean; className?: string; htmlFor?: string }) {
  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
          {label}
          {required && <span className="text-danger"> *</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-search-input=""
        className={clsx(control, 'h-9 w-full pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-ui-sm border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
      {message}
    </div>
  );
}
