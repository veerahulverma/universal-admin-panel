import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, EyeOff, Globe, ImageIcon, Moon, RotateCcw, Save, Send, Sun, Upload } from 'lucide-react';
import clsx from 'clsx';
import { api, download, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction } from '../../lib/mutations';
import { applyBrand } from '../../lib/theme';
import { useBootstrap } from '../../components/layout/AppShell';
import type { Bootstrap } from '../../components/layout/nav';
import { Badge, Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, PageSkeleton, Select, StatusBadge, Tabs, Textarea, When, useConfirm, useToast } from '../../components/ui';
import { ThemeActivateDialog } from './ThemeActivateDialog';
import { fieldErrors, refreshShell } from './shared';
import { COLOR_KEYS, COLOR_LABELS, ColorField, ContrastBadge, EMPTY_ASSETS, isHex, themeCss, type ColorKey, type Revision, type ThemeAssets, type ThemeDetail, type ThemeTokens } from './themes';

interface Work {
  tokens: ThemeTokens;
  customCss: string;
  assets: ThemeAssets;
}

function fromRevision(rev: Revision): Work {
  return { tokens: rev.tokens, customCss: rev.custom_css ?? '', assets: { ...EMPTY_ASSETS, ...rev.assets } };
}

/** The console shell as the server's active theme describes it (used to undo a console preview). */
function restoreConsoleBrand(boot: Bootstrap | undefined): void {
  const theme = boot?.theme;
  applyBrand(
    theme
      ? { css: theme.css, appName: theme.tokens?.branding?.appName || boot?.app.name, faviconUrl: theme.assets?.faviconUrl || boot?.app.faviconUrl, primary: theme.tokens?.colors?.primary }
      : boot
        ? { appName: boot.app.name }
        : null,
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PREVIEW_CSS = `*{box-sizing:border-box;margin:0}
html{font-size:var(--font-size-base,14px)}
body{font-family:var(--font-sans);background:var(--color-background);color:var(--color-foreground);line-height:1.45;-webkit-font-smoothing:antialiased}
.app{display:flex;min-height:100vh}
.side{width:172px;flex-shrink:0;background:var(--color-surface);border-right:1px solid var(--color-border);padding:calc(14px*var(--density,1)) 10px;display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;padding:0 6px;min-width:0}
.brand img{height:26px;max-width:120px;object-fit:contain}
.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mark{width:26px;height:26px;flex-shrink:0;border-radius:calc(var(--radius) - 2px);background:var(--color-primary);color:var(--color-primary-foreground);display:grid;place-items:center;font-size:12px;font-weight:700}
.nav{display:flex;flex-direction:column;gap:2px}
.nav span{display:block;padding:calc(6px*var(--density,1)) 10px;border-radius:calc(var(--radius) - 2px);color:var(--color-muted-foreground);font-size:.93em}
.nav .on{background:color-mix(in srgb,var(--color-primary) 12%,transparent);color:var(--color-primary);font-weight:600}
main{flex:1;min-width:0;padding:calc(18px*var(--density,1)) 20px;display:flex;flex-direction:column;gap:calc(14px*var(--density,1))}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.search{flex:1;max-width:240px;border:1px solid var(--color-border);background:var(--color-background);border-radius:calc(var(--radius) - 2px);padding:6px 10px;color:var(--color-muted-foreground);font-size:.9em}
.avatar{width:28px;height:28px;border-radius:999px;background:color-mix(in srgb,var(--color-primary) 14%,transparent);color:var(--color-primary);display:grid;place-items:center;font-size:11px;font-weight:700}
h1{font-family:var(--font-heading);font-size:1.35em;letter-spacing:-.01em}
.muted{color:var(--color-muted-foreground);font-size:.92em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius);box-shadow:var(--shadow);padding:calc(12px*var(--density,1)) 14px}
.label{color:var(--color-muted-foreground);font-size:.86em}
.value{font-size:1.45em;font-weight:650;margin-top:2px}
.up{font-size:.82em;color:var(--color-success);margin-top:2px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:calc(7px*var(--density,1)) 0;border-top:1px solid var(--color-border)}
.row:first-child{border-top:0}
.badge{font-size:.78em;padding:2px 8px;border-radius:999px;font-weight:600;white-space:nowrap}
.b-success{background:color-mix(in srgb,var(--color-success) 14%,transparent);color:var(--color-success)}
.b-warning{background:color-mix(in srgb,var(--color-warning) 14%,transparent);color:var(--color-warning)}
.b-danger{background:color-mix(in srgb,var(--color-danger) 14%,transparent);color:var(--color-danger)}
.b-info{background:color-mix(in srgb,var(--color-info) 14%,transparent);color:var(--color-info)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button{font:inherit;font-size:.93em;font-weight:600;border-radius:calc(var(--radius) - 2px);padding:calc(7px*var(--density,1)) 14px}
.primary{background:var(--color-primary);color:var(--color-primary-foreground);border:1px solid var(--color-primary)}
.outline{background:var(--color-surface);color:var(--color-foreground);border:1px solid var(--color-border)}
.link{background:none;border:0;color:var(--color-primary);padding-left:4px;padding-right:4px}
input{font:inherit;font-size:.93em;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-foreground);border-radius:calc(var(--radius) - 2px);padding:7px 10px;min-width:0;flex:1}
.callout{background:var(--color-accent);border:1px solid var(--color-border);border-radius:var(--radius);padding:10px 12px;font-size:.92em}
code{font-family:var(--font-mono);font-size:.88em}
@media (max-width:540px){.side{display:none}.grid{grid-template-columns:1fr}}`;

/** A miniature console rendered with the theme's variables inside a fully sandboxed frame. */
function previewDocument(work: Work, mode: 'light' | 'dark', appName: string): string {
  const logo = mode === 'dark' ? work.assets.logoDarkUrl || work.assets.logoUrl : work.assets.logoUrl;
  const origin = window.location.origin;
  const custom = work.customCss.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html class="${mode}" data-theme="${mode}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${origin} https: data:; font-src https: data:">
<base href="${origin}/"><style>${PREVIEW_CSS}</style><style>${themeCss(work.tokens)}</style><style>${custom}</style></head>
<body><div class="app"><aside class="side"><div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : `<div class="mark">${esc(appName.slice(0, 1).toUpperCase())}</div>`}<span>${logo ? '' : esc(appName)}</span></div>
<div class="nav"><span class="on">Dashboard</span><span>Users</span><span>Subscriptions</span><span>Invoices</span><span>Settings</span></div></aside>
<main><div class="top"><div class="search">Search…</div><div class="avatar">AB</div></div>
<div><h1>Welcome back</h1><p class="muted">Key numbers for the last 30 days.</p></div>
<div class="grid"><div class="card"><div class="label">Monthly recurring revenue</div><div class="value">$12,480</div><div class="up">▲ 8.2% vs prior period</div></div>
<div class="card"><div class="label">Active subscriptions</div><div class="value">1,284</div><div class="up">▲ 3.1% vs prior period</div></div></div>
<div class="card"><div class="row"><span>Elena Berners</span><span class="badge b-success">active</span></div><div class="row"><span>Lars Knuth</span><span class="badge b-warning">past due</span></div><div class="row"><span>Mei Dijkstra</span><span class="badge b-danger">payment failed</span></div><div class="row"><span>Omar Goldwasser</span><span class="badge b-info">trialing</span></div></div>
<div class="actions"><input placeholder="Text field" aria-label="Sample field"><button class="outline">Cancel</button><button class="primary">Save changes</button></div>
<div class="callout">Accent surface with <button class="link">a link</button> and <code>monospace</code> text.</div></main></div></body></html>`;
}

function AssetField({ label, hint, value, onChange, error, disabled }: { label: string; hint: string; value: string; onChange: (v: string) => void; error?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = useAction(
    (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<{ url: string }>('/api/admin/themes/assets', form);
    },
    { success: 'Image uploaded', onSuccess: (r) => onChange(r.url) },
  );
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-start gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-ui-sm border bg-muted/40">
          {value ? <img src={value} alt={`${label} preview`} className="max-h-14 max-w-14 object-contain" /> : <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="https://… or upload an image" aria-label={`${label} URL`} disabled={disabled} invalid={Boolean(error)} />
          {!disabled && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" icon={<Upload className="size-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>
                Upload
              </Button>
              {value && (
                <Button size="sm" variant="ghost" onClick={() => onChange('')}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > 1024 * 1024) return toast.error('Image too large', 'Use an image of 1 MB or less.');
          upload.mutate(f);
        }}
      />
    </Field>
  );
}

function Editor({ theme, base }: { theme: ThemeDetail; base: Revision }) {
  const { can } = useAuth();
  const client = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const boot = useBootstrap();
  const readOnly = theme.source === 'preset' || !can('themes.themes.manage');
  const initial = useMemo(() => fromRevision(base), [base]);
  const [work, setWork] = useState<Work>(initial);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('colors');
  const [mode, setMode] = useState<'light' | 'dark'>(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const [previewRev, setPreviewRev] = useState<Revision | null>(null);
  const [inConsole, setInConsole] = useState(false);
  const [activating, setActivating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(work) !== JSON.stringify(initial);
  const t = work.tokens;
  const appName = t.branding.appName || boot.data?.app.name || theme.name;

  const setTokens = (patch: Partial<ThemeTokens>) => setWork((w) => ({ ...w, tokens: { ...w.tokens, ...patch } }));
  const setColor = (k: ColorKey, v: string) => setWork((w) => ({ ...w, tokens: { ...w.tokens, colors: { ...w.tokens.colors, [k]: v } } }));
  const setDark = (k: ColorKey, v: string) =>
    setWork((w) => {
      const dark = { ...w.tokens.dark };
      if (v) dark[k] = v;
      else delete dark[k];
      return { ...w, tokens: { ...w.tokens, dark } };
    });
  const setBranding = (k: keyof ThemeTokens['branding'], v: string) => setTokens({ branding: { ...t.branding, [k]: v } });
  const setAsset = (k: keyof ThemeAssets, v: string) => setWork((w) => ({ ...w, assets: { ...w.assets, [k]: v } }));

  const invalidColors = [...COLOR_KEYS.filter((k) => !isHex(t.colors[k])), ...Object.entries(t.dark).filter(([, v]) => v && !isHex(v)).map(([k]) => `dark ${k}`)];

  // After a save, adopt what the server stored (custom CSS is sanitized there) unless editing continued.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (lastSaved.current !== null && lastSaved.current === JSON.stringify(work)) setWork(initial);
    lastSaved.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const saveDraft = useAction(() => {
    lastSaved.current = JSON.stringify(work);
    return api.put<{ ok: boolean; css: string }>(`/api/admin/themes/${theme.id}/draft`, { tokens: work.tokens, customCss: work.customCss, assets: work.assets, note: note || undefined });
  }, {
    invalidate: [['theme', theme.id], ['themes']],
    onSuccess: () => {
      setErrors({});
      setNote('');
    },
    onError: (err) => setErrors(fieldErrors(err)),
  });
  const publish = useAction((revisionId?: string) => api.post(`/api/admin/themes/${theme.id}/publish`, revisionId ? { revisionId } : {}), {
    success: (_r, rev) => (rev ? 'Earlier version restored and published' : 'Theme published'),
    invalidate: [['theme', theme.id], ['themes']],
    onSuccess: () => {
      setPreviewRev(null);
      if (theme.is_active) refreshShell(client);
    },
  });

  // A console preview only lasts while the editor is open.
  useEffect(() => () => restoreConsoleBrand(client.getQueryData<Bootstrap>(['bootstrap'])), [client]);

  const startConsolePreview = async () => {
    if (dirty) {
      try {
        await saveDraft.mutateAsync();
      } catch {
        return; // the save already reported the problem
      }
    }
    try {
      const css = await api.get<string>(`/api/admin/themes/${theme.id}/preview.css`);
      applyBrand({ css, appName, faviconUrl: work.assets.faviconUrl || undefined, primary: t.colors.primary });
      setInConsole(true);
    } catch (err) {
      toast.error('Preview failed', errorMessage(err));
    }
  };
  const stopConsolePreview = () => {
    restoreConsoleBrand(boot.data);
    setInConsole(false);
  };

  const onSave = () => {
    if (invalidColors.length) return toast.error('Fix the colours first', invalidColors.join(', '));
    saveDraft.mutate(undefined, { onSuccess: () => toast.success('Draft saved') });
  };

  const onPublish = async () => {
    if (invalidColors.length) return toast.error('Fix the colours first', invalidColors.join(', '));
    const { confirmed } = await confirm({
      title: `Publish ${theme.name}?`,
      description: theme.is_active ? `This theme is live for ${theme.scope === 'global' ? 'the console and every organization without its own theme' : 'an organization'}; publishing updates its branding immediately.` : 'Publishing makes this version available to activate. The current published version stays in the history.',
      confirmLabel: 'Publish',
    });
    if (!confirmed) return;
    if (dirty) {
      try {
        await saveDraft.mutateAsync();
      } catch {
        return;
      }
    }
    publish.mutate(undefined);
  };

  const shown = previewRev ? fromRevision(previewRev) : work;
  const doc = useMemo(() => previewDocument(shown, mode, appName), [shown, mode, appName]);
  const darkEffective = { ...t.colors, ...t.dark };
  const err = (path: string) => errors[path];

  const colorsTab = (
    <div className="space-y-4">
      <Card title="Colours" description="Used in light mode, and as the starting point for dark mode.">
        <div className="grid gap-4 sm:grid-cols-2">
          {COLOR_KEYS.map((k) => (
            <ColorField key={k} label={COLOR_LABELS[k].label} hint={COLOR_LABELS[k].hint} value={t.colors[k]} onChange={(v) => setColor(k, v)} error={err(`tokens.colors.${k}`)} disabled={readOnly} />
          ))}
        </div>
      </Card>
      <Card title="Readability" description="WCAG contrast for the most common pairs (4.5:1 is the AA minimum for body text).">
        <div className="space-y-2">
          <ContrastBadge fg={t.colors.foreground} bg={t.colors.background} label="Text on page background" />
          <ContrastBadge fg={t.colors.foreground} bg={t.colors.surface} label="Text on cards" />
          <ContrastBadge fg={t.colors.mutedForeground} bg={t.colors.surface} label="Secondary text on cards" />
          <ContrastBadge fg={t.colors.primaryForeground} bg={t.colors.primary} label="Primary button label" />
          <ContrastBadge fg={t.colors.primary} bg={t.colors.surface} label="Links on cards" />
        </div>
      </Card>
    </div>
  );

  const darkTab = (
    <div className="space-y-4">
      <Card title="Dark mode colours" description="Leave a colour empty to reuse the light one. Applies when the viewer uses dark mode.">
        <div className="grid gap-4 sm:grid-cols-2">
          {COLOR_KEYS.map((k) => (
            <ColorField key={k} label={COLOR_LABELS[k].label} value={t.dark[k] ?? ''} placeholder={t.colors[k]} clearable onChange={(v) => setDark(k, v)} error={err(`tokens.dark.${k}`)} disabled={readOnly} />
          ))}
        </div>
      </Card>
      <Card title="Readability in dark mode">
        <div className="space-y-2">
          <ContrastBadge fg={darkEffective.foreground} bg={darkEffective.background} label="Text on page background" />
          <ContrastBadge fg={darkEffective.mutedForeground} bg={darkEffective.surface} label="Secondary text on cards" />
          <ContrastBadge fg={darkEffective.primaryForeground} bg={darkEffective.primary} label="Primary button label" />
        </div>
      </Card>
    </div>
  );

  const typeTab = (
    <Card title="Typography & layout">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Body font" htmlFor="ty-font" hint="A CSS font stack; the first installed font is used." error={err('tokens.typography.fontFamily')} className="sm:col-span-2">
          <Input id="ty-font" value={t.typography.fontFamily} onChange={(e) => setTokens({ typography: { ...t.typography, fontFamily: e.target.value } })} disabled={readOnly} />
        </Field>
        <Field label="Heading font" htmlFor="ty-heading" hint="Empty uses the body font." error={err('tokens.typography.headingFamily')}>
          <Input id="ty-heading" value={t.typography.headingFamily} onChange={(e) => setTokens({ typography: { ...t.typography, headingFamily: e.target.value } })} disabled={readOnly} />
        </Field>
        <Field label="Monospace font" htmlFor="ty-mono" error={err('tokens.typography.monoFamily')}>
          <Input id="ty-mono" value={t.typography.monoFamily} onChange={(e) => setTokens({ typography: { ...t.typography, monoFamily: e.target.value } })} disabled={readOnly} />
        </Field>
        <Field label="Base font size" htmlFor="ty-size" hint="Body text size, 12–18 px. Headings, spacing and the sidebar scale with it." error={err('tokens.typography.baseSize')}>
          <Input id="ty-size" type="number" min={12} max={18} value={t.typography.baseSize} onChange={(e) => setTokens({ typography: { ...t.typography, baseSize: Math.min(18, Math.max(12, Number(e.target.value) || 14)) } })} disabled={readOnly} />
        </Field>
        <Field label={`Corner radius: ${t.radius}px`} htmlFor="ty-radius" error={err('tokens.radius')}>
          <input id="ty-radius" type="range" min={0} max={24} step={1} value={t.radius} onChange={(e) => setTokens({ radius: Number(e.target.value) })} disabled={readOnly} className="mt-2 w-full accent-[var(--color-primary)]" />
        </Field>
        <Field label="Density" htmlFor="ty-density">
          <Select id="ty-density" value={t.density} onChange={(e) => setTokens({ density: e.target.value as ThemeTokens['density'] })} disabled={readOnly} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Field>
        <Field label="Shadows" htmlFor="ty-shadow">
          <Select id="ty-shadow" value={t.shadow} onChange={(e) => setTokens({ shadow: e.target.value as ThemeTokens['shadow'] })} disabled={readOnly} options={[{ value: 'none', label: 'None (flat)' }, { value: 'sm', label: 'Subtle' }, { value: 'md', label: 'Pronounced' }]} />
        </Field>
        <Field label="Default appearance" htmlFor="ty-appearance" hint="What viewers see until they choose light or dark themselves.">
          <Select id="ty-appearance" value={t.appearance} onChange={(e) => setTokens({ appearance: e.target.value as ThemeTokens['appearance'] })} disabled={readOnly} options={[{ value: 'system', label: 'Follow the device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Field>
      </div>
    </Card>
  );

  const brandTab = (
    <div className="space-y-4">
      <Card title="Names & text">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Application name" htmlFor="br-name" hint="Shown in the console, browser tab and emails. Empty uses the General settings name." error={err('tokens.branding.appName')}>
            <Input id="br-name" value={t.branding.appName} onChange={(e) => setBranding('appName', e.target.value)} maxLength={80} disabled={readOnly} />
          </Field>
          <Field label="Support link" htmlFor="br-support" hint="https:// URL" error={err('tokens.branding.supportUrl')}>
            <Input id="br-support" type="url" value={t.branding.supportUrl} onChange={(e) => setBranding('supportUrl', e.target.value)} disabled={readOnly} />
          </Field>
          <Field label="Sign-in title" htmlFor="br-login" error={err('tokens.branding.loginTitle')}>
            <Input id="br-login" value={t.branding.loginTitle} onChange={(e) => setBranding('loginTitle', e.target.value)} maxLength={120} disabled={readOnly} />
          </Field>
          <Field label="Checkout title" htmlFor="br-checkout" error={err('tokens.branding.checkoutTitle')}>
            <Input id="br-checkout" value={t.branding.checkoutTitle} onChange={(e) => setBranding('checkoutTitle', e.target.value)} maxLength={120} disabled={readOnly} />
          </Field>
          <Field label="Sign-in subtitle" htmlFor="br-sub" className="sm:col-span-2" error={err('tokens.branding.loginSubtitle')}>
            <Input id="br-sub" value={t.branding.loginSubtitle} onChange={(e) => setBranding('loginSubtitle', e.target.value)} maxLength={300} disabled={readOnly} />
          </Field>
          <Field label="Email footer" htmlFor="br-footer" className="sm:col-span-2" hint="Plain text added to the bottom of system emails." error={err('tokens.branding.emailFooter')}>
            <Textarea id="br-footer" rows={2} value={t.branding.emailFooter} onChange={(e) => setBranding('emailFooter', e.target.value)} maxLength={500} disabled={readOnly} />
          </Field>
        </div>
      </Card>
      <Card title="Logos & images" description="PNG, JPEG, WebP, GIF, ICO or SVG up to 1 MB, or any https:// URL.">
        <div className="grid gap-5 sm:grid-cols-2">
          <AssetField label="Logo" hint="Console sidebar, sign-in, checkout, emails" value={work.assets.logoUrl} onChange={(v) => setAsset('logoUrl', v)} error={err('assets.logoUrl')} disabled={readOnly} />
          <AssetField label="Logo on dark backgrounds" hint="Optional; used in dark mode" value={work.assets.logoDarkUrl} onChange={(v) => setAsset('logoDarkUrl', v)} error={err('assets.logoDarkUrl')} disabled={readOnly} />
          <AssetField label="Favicon" hint="Browser tab icon (square, 32×32 or larger)" value={work.assets.faviconUrl} onChange={(v) => setAsset('faviconUrl', v)} error={err('assets.faviconUrl')} disabled={readOnly} />
          <AssetField label="Sign-in background" hint="Optional image behind hosted sign-in pages" value={work.assets.loginBackgroundUrl} onChange={(v) => setAsset('loginBackgroundUrl', v)} error={err('assets.loginBackgroundUrl')} disabled={readOnly} />
        </div>
      </Card>
    </div>
  );

  const cssTab = (
    <Card title="Custom CSS" description="Advanced overrides on top of the tokens. Imports, external URLs and anything script-like are stripped when you save.">
      <Textarea value={work.customCss} onChange={(e) => setWork((w) => ({ ...w, customCss: e.target.value }))} rows={14} maxLength={50_000} className="font-mono text-xs" placeholder={'/* e.g. */\n.sidebar { letter-spacing: .01em; }'} aria-label="Custom CSS" disabled={readOnly} spellCheck={false} />
      <p className="mt-2 text-xs text-muted-foreground">{work.customCss.length.toLocaleString()} / 50,000 characters</p>
    </Card>
  );

  const historyTab = (
    <Card padded={false} title="Revision history" description="Every published version is kept. Restoring publishes a copy of an earlier version.">
      <DataTable
        caption="Theme revisions"
        rows={theme.revisions}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No revisions" />}
        columns={[
          { key: 'version', header: 'Version', cell: (r) => <span className="font-mono">v{r.version}</span> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.id === theme.published_revision_id ? 'active' : r.status} /> },
          { key: 'note', header: 'Note', cell: (r) => r.note ?? <span className="text-muted-foreground">—</span> },
          { key: 'created', header: 'Saved', cell: (r) => <When value={r.created_at} /> },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right',
            cell: (r) => (
              <span className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setPreviewRev(previewRev?.id === r.id ? null : r)}>
                  {previewRev?.id === r.id ? 'Stop preview' : 'Preview'}
                </Button>
                {!readOnly && r.status !== 'draft' && r.id !== theme.published_revision_id && (
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<RotateCcw className="size-3.5" />}
                    onClick={async () => {
                      const { confirmed } = await confirm({ title: `Restore v${r.version}?`, description: 'A copy of that version is published as the newest version. Your draft is kept.', confirmLabel: 'Restore & publish' });
                      if (confirmed) publish.mutate(r.id);
                    }}
                  >
                    Restore
                  </Button>
                )}
              </span>
            ),
          },
        ]}
      />
    </Card>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Themes', to: '/platform/themes' }, { label: theme.name }]}
        title={theme.name}
        description={theme.description || undefined}
        meta={
          <>
            {theme.is_active && <Badge tone="success" dot>active · {theme.scope === 'global' ? 'global' : 'organization'}</Badge>}
            {theme.published ? <Badge>v{theme.published.version} published</Badge> : <Badge tone="warning">not published</Badge>}
            {theme.draft && <Badge tone="info">draft v{theme.draft.version}</Badge>}
            {theme.source === 'preset' && <Badge>preset · read-only</Badge>}
          </>
        }
        actions={
          <>
            <Button variant="outline" icon={inConsole ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => (inConsole ? stopConsolePreview() : void startConsolePreview())} loading={saveDraft.isPending && !inConsole} disabled={readOnly && !theme.published}>
              {inConsole ? 'Stop console preview' : 'Preview in console'}
            </Button>
            {theme.published && (
              <Button variant="outline" icon={<Download className="size-4" />} onClick={() => download(`/api/admin/themes/${theme.id}/export`, undefined, `${theme.key}.theme.json`).catch((e) => toast.error('Export failed', errorMessage(e)))}>
                Export
              </Button>
            )}
            {can('themes.themes.manage') && theme.published && !(theme.is_active && theme.scope === 'global') && (
              <Button variant="outline" icon={<Globe className="size-4" />} onClick={() => setActivating(true)}>
                Activate…
              </Button>
            )}
          </>
        }
      />
      {theme.source === 'preset' && (
        <div className="mb-4">
          <Callout tone="info" title="Presets are read-only" action={can('themes.themes.manage') && <Button size="sm" variant="outline" onClick={() => navigate('/platform/themes')}>Customize a copy</Button>}>
            Create a theme based on this preset to change its colours, fonts or logos.
          </Callout>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="min-w-0">
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'colors', label: 'Colours', content: colorsTab },
              { value: 'dark', label: 'Dark mode', content: darkTab },
              { value: 'type', label: 'Typography & layout', content: typeTab },
              { value: 'brand', label: 'Branding', content: brandTab },
              { value: 'css', label: 'Custom CSS', content: cssTab },
              { value: 'history', label: 'History', count: theme.revisions.length, content: historyTab },
            ]}
          />
          {!readOnly && (
            <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-ui border bg-surface/95 px-4 py-3 shadow-ui backdrop-blur">
              <span className="mr-auto text-sm text-muted-foreground">{dirty ? 'Unsaved changes' : theme.draft ? `Draft v${theme.draft.version} saved` : 'No changes'}</span>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change note (optional)" aria-label="Change note" maxLength={300} className="w-full sm:w-56" />
              <Button variant="outline" disabled={!dirty} onClick={() => setWork(initial)}>
                Discard
              </Button>
              <Button variant="outline" icon={<Save className="size-4" />} disabled={!dirty} loading={saveDraft.isPending} onClick={onSave}>
                Save draft
              </Button>
              <Button icon={<Send className="size-4" />} disabled={!dirty && !theme.draft} loading={publish.isPending} onClick={() => void onPublish()}>
                Publish
              </Button>
            </div>
          )}
        </div>
        <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">{previewRev ? `Preview of v${previewRev.version}` : 'Live preview'}</p>
            <div role="radiogroup" aria-label="Preview appearance" className="inline-flex rounded-ui-sm border bg-surface p-0.5">
              {(['light', 'dark'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx('inline-flex items-center gap-1 rounded-[calc(var(--radius)-3px)] px-2 py-1 text-xs font-medium', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {m === 'light' ? <Sun className="size-3.5" aria-hidden="true" /> : <Moon className="size-3.5" aria-hidden="true" />}
                  {m === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          {/* Fully sandboxed: no scripts, no access to the console. */}
          <iframe title="Theme preview" sandbox="" srcDoc={doc} className="h-[34rem] w-full rounded-ui border shadow-ui" />
          {previewRev && (
            <Button variant="link" size="sm" className="mt-2" onClick={() => setPreviewRev(null)}>
              Back to the current edit
            </Button>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Custom CSS written for the console’s own markup may not show in this miniature; use “Preview in console” to see everything.</p>
        </aside>
      </div>

      {inConsole && (
        <div role="status" className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-3 rounded-ui border bg-surface px-4 py-2.5 shadow-lg">
          <Eye className="size-4 text-primary" aria-hidden="true" />
          <span className="text-sm">Previewing {theme.name} in the console. Only you can see this.</span>
          <Button size="sm" onClick={stopConsolePreview}>
            Stop preview
          </Button>
        </div>
      )}
      {activating && <ThemeActivateDialog theme={theme} onClose={() => setActivating(false)} />}
    </>
  );
}

export default function ThemeEditorPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['theme', id], queryFn: () => api.get<ThemeDetail>(`/api/admin/themes/${id}`) });
  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const base = q.data.draft ?? q.data.published ?? q.data.revisions[0];
  if (!base) return <EmptyState title="This theme has no revisions" />;
  // Remount the editor when the stored version changes (after save, publish or restore).
  return <Editor key={`${base.id}:${base.created_at}:${q.data.published_revision_id}`} theme={q.data} base={base} />;
}
