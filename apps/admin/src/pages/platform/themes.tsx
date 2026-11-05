import { useId } from 'react';
import { Badge, Button, Input } from '../../components/ui';

export const COLOR_KEYS = ['primary', 'primaryForeground', 'background', 'foreground', 'surface', 'muted', 'mutedForeground', 'border', 'accent', 'success', 'warning', 'danger', 'info'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type Colors = Record<ColorKey, string>;

export const COLOR_LABELS: Record<ColorKey, { label: string; hint: string }> = {
  primary: { label: 'Primary', hint: 'Buttons, links, active navigation' },
  primaryForeground: { label: 'Text on primary', hint: 'Labels on primary buttons' },
  background: { label: 'Page background', hint: 'Behind cards and panels' },
  foreground: { label: 'Text', hint: 'Body text and headings' },
  surface: { label: 'Cards & panels', hint: 'Cards, tables, dialogs' },
  muted: { label: 'Muted background', hint: 'Hover states, table headers' },
  mutedForeground: { label: 'Secondary text', hint: 'Descriptions, hints' },
  border: { label: 'Borders', hint: 'Dividers and outlines' },
  accent: { label: 'Accent', hint: 'Highlighted backgrounds' },
  success: { label: 'Success', hint: 'Paid, active, healthy' },
  warning: { label: 'Warning', hint: 'Past due, degraded' },
  danger: { label: 'Danger', hint: 'Errors, destructive actions' },
  info: { label: 'Info', hint: 'Neutral notices, trials' },
};

export interface ThemeTokens {
  colors: Colors;
  dark: Partial<Colors>;
  typography: { fontFamily: string; headingFamily: string; monoFamily: string; baseSize: number };
  radius: number;
  density: 'compact' | 'comfortable';
  shadow: 'none' | 'sm' | 'md';
  appearance: 'light' | 'dark' | 'system';
  branding: { appName: string; loginTitle: string; loginSubtitle: string; checkoutTitle: string; emailFooter: string; supportUrl: string };
}

export interface ThemeAssets {
  logoUrl: string;
  logoDarkUrl: string;
  faviconUrl: string;
  loginBackgroundUrl: string;
}

export interface ThemeListRow {
  id: string;
  key: string;
  name: string;
  description: string;
  source: 'preset' | 'custom' | 'upload';
  scope: string;
  is_active: boolean;
  published_revision_id: string | null;
  created_at: string;
  updated_at: string;
  published_version: number | null;
  published_tokens: ThemeTokens | null;
  draft_version: number | null;
}

export interface Revision {
  id: string;
  theme_id: string;
  version: number;
  tokens: ThemeTokens;
  custom_css: string;
  assets: Partial<ThemeAssets>;
  status: 'draft' | 'published' | 'archived';
  note: string | null;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
}

export interface ThemeDetail extends Omit<ThemeListRow, 'published_version' | 'published_tokens' | 'draft_version'> {
  revisions: Revision[];
  draft: Revision | null;
  published: Revision | null;
}

export const EMPTY_ASSETS: ThemeAssets = { logoUrl: '', logoDarkUrl: '', faviconUrl: '', loginBackgroundUrl: '' };

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHex(v: string): boolean {
  return HEX.test(v);
}

/** #abc -> #aabbcc (the colour input only accepts six digits). */
export function fullHex(v: string): string {
  if (!isHex(v)) return '#000000';
  const h = v.slice(1);
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`.toLowerCase();
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function hexToRgb(hex: string): string {
  const n = parseInt(fullHex(hex).slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function vars(colors: Partial<Colors>): string {
  return Object.entries(colors)
    .filter(([, v]) => v && isHex(v))
    .map(([k, v]) => `--color-${kebab(k)}: ${v}; --rgb-${kebab(k)}: ${hexToRgb(v as string)};`)
    .join(' ');
}

/** The same custom properties the server generates (used for the instant preview). */
export function themeCss(t: ThemeTokens): string {
  const shadow = { none: 'none', sm: '0 1px 2px rgb(0 0 0 / 0.06)', md: '0 4px 12px rgb(0 0 0 / 0.08)' }[t.shadow];
  const scale = t.density === 'compact' ? 0.875 : 1;
  const root = `:root { ${vars(t.colors)} --font-sans: ${t.typography.fontFamily}; --font-heading: ${t.typography.headingFamily || t.typography.fontFamily}; --font-mono: ${t.typography.monoFamily}; --font-size-base: ${t.typography.baseSize}px; --radius: ${t.radius}px; --shadow: ${shadow}; --density: ${scale}; }`;
  const dark = Object.keys(t.dark ?? {}).length ? `:root.dark, [data-theme="dark"] { ${vars(t.dark)} }` : '';
  return [root, dark].filter(Boolean).join('\n');
}

function luminance(hex: string): number {
  const n = parseInt(fullHex(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  if (!isHex(a) || !isHex(b)) return 0;
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function ContrastBadge({ fg, bg, label }: { fg: string; bg: string; label: string }) {
  const ratio = contrast(fg, bg);
  const tone = ratio >= 4.5 ? 'success' : ratio >= 3 ? 'warning' : 'danger';
  return (
    <span className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="inline-flex size-5 items-center justify-center rounded border text-2xs font-bold" style={{ background: bg, color: fg }} aria-hidden="true">
          Aa
        </span>
        {label}
      </span>
      <Badge tone={tone}>
        {ratio.toFixed(1)}:1 {ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'large text only' : 'too low'}
      </Badge>
    </span>
  );
}

export function ColorField({ label, hint, value, onChange, placeholder, error, disabled, clearable }: { label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string; error?: string; disabled?: boolean; clearable?: boolean }) {
  const id = useId();
  const shown = value || placeholder || '#000000';
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-ui-sm border bg-surface p-1 disabled:cursor-not-allowed"
          value={fullHex(shown)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trim())} invalid={Boolean(error) || (value !== '' && !isHex(value))} className="font-mono" maxLength={7} disabled={disabled} />
        {clearable && value && !disabled && (
          <Button variant="ghost" size="sm" onClick={() => onChange('')} aria-label={`Use the light colour for ${label}`}>
            Inherit
          </Button>
        )}
      </div>
      {(error || (value !== '' && !isHex(value))) && <p className="mt-1 text-xs text-danger">{error ?? 'Use a hex colour like #4f46e5'}</p>}
    </div>
  );
}

export function Swatches({ tokens }: { tokens: ThemeTokens | null }) {
  if (!tokens) return <div className="h-16 rounded-ui-sm bg-muted" aria-hidden="true" />;
  const c = tokens.colors;
  const d = { ...c, ...tokens.dark };
  // Data colours from the theme itself (not UI chrome): a miniature light and dark rendering.
  return (
    <div className="grid h-16 grid-cols-2 overflow-hidden rounded-ui-sm border" aria-hidden="true">
      {[c, d].map((p, i) => (
        <div key={i} className="flex flex-col justify-between p-2" style={{ background: p.background }}>
          <div className="h-1.5 w-12 rounded-full" style={{ background: p.foreground, opacity: 0.8 }} />
          <div className="flex items-center gap-1.5 rounded px-1.5 py-1" style={{ background: p.surface, border: `1px solid ${p.border}` }}>
            <span className="h-3 w-8 rounded-sm" style={{ background: p.primary }} />
            <span className="h-1.5 flex-1 rounded-full" style={{ background: p.mutedForeground, opacity: 0.6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function scopeLabel(scope: string, orgName?: string | null): string {
  return scope === 'global' ? 'the console and all organizations' : `${orgName ?? scope.slice(4)}`;
}
