import { useId, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, PasswordInput, Select, Switch, Textarea } from './ui';

/**
 * Renders a form from a JSON Schema (as produced by the server with
 * z.toJSONSchema): settings sections, gateway/email-provider configuration and
 * plugin settings all use it, so new modules and plugins get an admin form
 * without UI code.
 */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  pattern?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  writeOnly?: boolean;
  [key: string]: unknown;
}

type Obj = Record<string, unknown>;

/** Unwrap `anyOf: [X, {type: 'null'}]` (optional/nullable zod fields). */
export function resolve(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    if (nonNull.length === 1) return { schema: { ...nonNull[0], title: schema.title ?? nonNull[0].title, description: schema.description ?? nonNull[0].description, default: schema.default ?? nonNull[0].default }, nullable: nonNull.length < variants.length };
    // Text unions such as "URL or empty" (z.string().url().or(z.literal(''))) are one text input.
    const textual = (v: JsonSchema) => v.type === 'string' || typeof v.const === 'string' || Boolean(v.enum?.every((e) => typeof e === 'string'));
    if (nonNull.length > 1 && nonNull.every(textual)) {
      const main = nonNull.find((v) => v.type === 'string' && v.const === undefined && !v.enum) ?? nonNull[0];
      return { schema: { ...main, type: 'string', title: schema.title ?? main.title, description: schema.description ?? main.description, default: schema.default ?? main.default }, nullable: nonNull.length < variants.length };
    }
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== 'null');
    return { schema: { ...schema, type: types[0] }, nullable: types.length < schema.type.length };
  }
  return { schema, nullable: false };
}

/** "requireMixedCase" -> "Require mixed case" */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SECRETISH = /(password|secret|token|apikey|api_key|privatekey)$/i;

function JsonField({ id, value, onChange, disabled }: { id: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Textarea
        id={id}
        rows={Math.min(12, Math.max(3, text.split('\n').length))}
        className="font-mono text-xs"
        value={text}
        disabled={disabled}
        invalid={Boolean(error)}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
            setError(null);
          } catch {
            setError('Invalid JSON');
          }
        }}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
    </>
  );
}

function ListField({ id, value, onChange, numeric, disabled, placeholder }: { id: string; value: unknown; onChange: (v: unknown) => void; numeric?: boolean; disabled?: boolean; placeholder?: string }) {
  const list = Array.isArray(value) ? value : [];
  const [text, setText] = useState(list.join('\n'));
  return (
    <Textarea
      id={id}
      rows={Math.min(8, Math.max(2, list.length + 1))}
      value={text}
      disabled={disabled}
      placeholder={placeholder ?? 'One per line'}
      onChange={(e) => {
        setText(e.target.value);
        const items = e.target.value.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
        onChange(numeric ? items.map(Number).filter((n) => !Number.isNaN(n)) : items);
      }}
    />
  );
}

function Property({ name, schema: raw, value, onChange, required, errors, path, disabled }: { name: string; schema: JsonSchema; value: unknown; onChange: (v: unknown) => void; required: boolean; errors?: Record<string, string>; path: string; disabled?: boolean }) {
  const id = useId();
  const { schema, nullable } = resolve(raw);
  const label = schema.title ?? humanize(name);
  const hint = schema.description;
  const error = errors?.[path];
  const type = schema.type as string | undefined;
  const optional = !required || nullable;
  const empty = nullable ? null : undefined;

  if (type === 'object' && schema.properties) {
    return (
      <fieldset className="space-y-3 rounded-ui border p-3 sm:col-span-2">
        <legend className="px-1 text-sm font-semibold">{label}</legend>
        {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
        <Fields schema={schema} value={(value as Obj) ?? {}} onChange={onChange} errors={errors} path={path} disabled={disabled} />
      </fieldset>
    );
  }

  if (type === 'boolean') {
    return (
      <div className="sm:col-span-2">
        <Switch id={id} checked={Boolean(value ?? schema.default)} onCheckedChange={onChange} label={label} description={hint} disabled={disabled} />
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  let control: React.ReactNode;
  let wide = false;
  if (schema.enum && schema.enum.every((e) => typeof e === 'string' || typeof e === 'number')) {
    control = (
      <Select
        id={id}
        value={value === undefined || value === null ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? empty : typeof schema.enum![0] === 'number' ? Number(e.target.value) : e.target.value)}
        placeholder={optional ? 'Not set' : undefined}
        options={schema.enum.map((e) => ({ value: String(e), label: humanize(String(e)) }))}
      />
    );
  } else if (type === 'integer' || type === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        inputMode={type === 'integer' ? 'numeric' : 'decimal'}
        step={type === 'integer' ? 1 : 'any'}
        min={schema.minimum ?? schema.exclusiveMinimum}
        max={schema.maximum ?? schema.exclusiveMaximum}
        value={value === undefined || value === null ? '' : String(value)}
        disabled={disabled}
        invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value === '' ? empty : Number(e.target.value))}
        placeholder={schema.default !== undefined ? String(schema.default) : undefined}
      />
    );
  } else if (type === 'array' && schema.items) {
    const item = resolve(schema.items).schema;
    wide = true;
    if (item.enum) {
      const selected = new Set(Array.isArray(value) ? (value as unknown[]).map(String) : []);
      control = (
        <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-ui-sm border p-2.5">
          {item.enum.map((opt) => (
            <Checkbox
              key={String(opt)}
              label={humanize(String(opt))}
              checked={selected.has(String(opt))}
              disabled={disabled}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(String(opt));
                else next.delete(String(opt));
                onChange(item.enum!.filter((o) => next.has(String(o))));
              }}
            />
          ))}
        </div>
      );
    } else if (item.type === 'string' || item.type === 'number' || item.type === 'integer') {
      control = <ListField id={id} value={value} onChange={onChange} numeric={item.type !== 'string'} disabled={disabled} />;
    } else {
      control = <JsonField id={id} value={value} onChange={onChange} disabled={disabled} />;
    }
  } else if (type === 'string') {
    const common = { id, disabled, invalid: Boolean(error), value: value === undefined || value === null ? '' : String(value), placeholder: schema.default !== undefined && schema.default !== '' ? String(schema.default) : undefined };
    const set = (v: string) => onChange(v === '' ? (optional ? empty : '') : v);
    if (schema.writeOnly || SECRETISH.test(name)) control = <PasswordInput {...common} autoComplete="off" onChange={(e) => set(e.target.value)} />;
    else if (schema.format === 'date-time') control = <Input {...common} type="datetime-local" value={common.value.slice(0, 16)} onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : '')} />;
    else if (schema.format === 'date') control = <Input {...common} type="date" onChange={(e) => set(e.target.value)} />;
    else if (schema.pattern?.includes('[0-9a-fA-F]{6}') || /colou?r$/i.test(name)) {
      control = (
        <div className="flex gap-2">
          <input type="color" aria-label={`${label} picker`} className="h-9 w-11 shrink-0 cursor-pointer rounded-ui-sm border bg-surface p-1" value={/^#[0-9a-f]{6}$/i.test(common.value) ? common.value : '#000000'} disabled={disabled} onChange={(e) => set(e.target.value)} />
          <Input {...common} className="font-mono" onChange={(e) => set(e.target.value)} />
        </div>
      );
    } else if ((schema.maxLength ?? 0) > 300) {
      wide = true;
      control = <Textarea {...common} rows={4} onChange={(e) => set(e.target.value)} />;
    } else {
      control = <Input {...common} type={schema.format === 'email' ? 'email' : schema.format === 'uri' || schema.format === 'url' ? 'url' : 'text'} maxLength={schema.maxLength} onChange={(e) => set(e.target.value)} />;
    }
  } else {
    wide = true;
    control = <JsonField id={id} value={value} onChange={onChange} disabled={disabled} />;
  }

  return (
    <Field label={label} hint={hint} error={error} htmlFor={id} required={required && !nullable} className={wide ? 'sm:col-span-2' : undefined}>
      {control}
    </Field>
  );
}

function Fields({ schema, value, onChange, errors, path, disabled }: { schema: JsonSchema; value: Obj; onChange: (v: Obj) => void; errors?: Record<string, string>; path: string; disabled?: boolean }) {
  const required = new Set(schema.required ?? []);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => (
        <Property
          key={key}
          name={key}
          schema={prop}
          value={value[key]}
          required={required.has(key)}
          errors={errors}
          path={path ? `${path}.${key}` : key}
          disabled={disabled}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

export function SchemaForm({ schema, value, onChange, errors, disabled }: { schema: JsonSchema; value: Obj; onChange: (v: Obj) => void; errors?: Record<string, string>; disabled?: boolean }) {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return <p className="text-sm text-muted-foreground">No options to configure.</p>;
  }
  return <Fields schema={schema} value={value ?? {}} onChange={onChange} errors={errors} path="" disabled={disabled} />;
}

export interface SecretField {
  key: string;
  label: string;
  required?: boolean;
  help?: string;
}

/**
 * Write-only credentials. Stored values are never sent back to the browser;
 * the server only reports which keys are set. Leave a field empty to keep it.
 */
export function SecretFields({ fields, configured, value, onChange, disabled }: { fields: SecretField[]; configured: string[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<Set<string>>(new Set());
  if (!fields.length) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        const isSet = configured.includes(f.key);
        const open = !isSet || editing.has(f.key);
        return (
          <Field key={f.key} label={<span className="inline-flex items-center gap-2">{f.label}{isSet && <Badge tone="success">set</Badge>}</span>} hint={f.help ?? (isSet ? 'Stored encrypted. Replace to rotate it.' : undefined)} required={f.required && !isSet} htmlFor={`secret-${f.key}`}>
            {open ? (
              <PasswordInput
                id={`secret-${f.key}`}
                autoComplete="off"
                value={value[f.key] ?? ''}
                disabled={disabled}
                placeholder={isSet ? 'Enter a new value' : undefined}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.value) next[f.key] = e.target.value;
                  else delete next[f.key];
                  onChange(next);
                }}
              />
            ) : (
              <div className="flex items-center gap-2">
                <Input id={`secret-${f.key}`} value="••••••••••••" readOnly disabled className="flex-1 font-mono" />
                <Button variant="outline" size="sm" onClick={() => setEditing(new Set(editing).add(f.key))} disabled={disabled}>
                  Replace
                </Button>
              </div>
            )}
          </Field>
        );
      })}
    </div>
  );
}
