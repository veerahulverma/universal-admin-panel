import { z } from 'zod';

const color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour like #4f46e5');
const assetUrl = z.string().max(2000).refine((v) => v === '' || /^https:\/\//.test(v) || /^\/[A-Za-z0-9/_.-]*$/.test(v), 'Use an https:// URL or a site-relative path').default('');
const fontStack = z.string().max(200).regex(/^[A-Za-z0-9 ,'"\-]*$/, 'Font names may only contain letters, numbers, spaces, commas, quotes and dashes');

export const colorTokens = z.object({
  primary: color,
  primaryForeground: color,
  background: color,
  foreground: color,
  surface: color,
  muted: color,
  mutedForeground: color,
  border: color,
  accent: color,
  success: color,
  warning: color,
  danger: color,
  info: color,
});

export const themeTokens = z.object({
  colors: colorTokens,
  dark: colorTokens.partial().default({}),
  typography: z
    .object({
      fontFamily: fontStack.default("Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"),
      headingFamily: fontStack.default(''),
      monoFamily: fontStack.default("ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"),
      baseSize: z.number().int().min(12).max(18).default(14),
    })
    .default({ fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif", headingFamily: '', monoFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace", baseSize: 14 }),
  radius: z.number().int().min(0).max(24).default(8),
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  shadow: z.enum(['none', 'sm', 'md']).default('sm'),
  appearance: z.enum(['light', 'dark', 'system']).default('system'),
  branding: z
    .object({
      appName: z.string().max(80).default(''),
      loginTitle: z.string().max(120).default(''),
      loginSubtitle: z.string().max(300).default(''),
      checkoutTitle: z.string().max(120).default(''),
      emailFooter: z.string().max(500).default(''),
      supportUrl: assetUrl,
    })
    .default({ appName: '', loginTitle: '', loginSubtitle: '', checkoutTitle: '', emailFooter: '', supportUrl: '' }),
});
export type ThemeTokens = z.infer<typeof themeTokens>;

export const themeAssets = z
  .object({ logoUrl: assetUrl, logoDarkUrl: assetUrl, faviconUrl: assetUrl, loginBackgroundUrl: assetUrl })
  .default({ logoUrl: '', logoDarkUrl: '', faviconUrl: '', loginBackgroundUrl: '' });
export type ThemeAssets = z.infer<typeof themeAssets>;

const base = {
  background: '#ffffff',
  foreground: '#0f1115',
  surface: '#ffffff',
  muted: '#f4f5f7',
  mutedForeground: '#5b6170',
  border: '#e4e6eb',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  info: '#2563eb',
};
const darkBase = { background: '#0b0d10', foreground: '#e8eaee', surface: '#13161b', muted: '#1b1f26', mutedForeground: '#9aa1ad', border: '#262b33' };

function preset(primary: string, accent: string, dark?: Partial<z.infer<typeof colorTokens>>, extra: Partial<ThemeTokens> = {}): ThemeTokens {
  return themeTokens.parse({
    colors: { ...base, primary, primaryForeground: '#ffffff', accent },
    dark: { ...darkBase, primary, accent, ...dark },
    ...extra,
  });
}

export const PRESETS: { key: string; name: string; description: string; tokens: ThemeTokens }[] = [
  { key: 'default', name: 'Steward', description: 'Calm indigo with neutral surfaces.', tokens: preset('#4f46e5', '#eef2ff', { accent: '#1e1b4b' }) },
  { key: 'slate', name: 'Slate', description: 'Understated monochrome for dense operational work.', tokens: preset('#334155', '#f1f5f9', { primary: '#cbd5e1', primaryForeground: '#0f172a', accent: '#1e293b' }, { radius: 6, density: 'compact' }) },
  { key: 'emerald', name: 'Emerald', description: 'Fresh green accent.', tokens: preset('#059669', '#ecfdf5', { accent: '#064e3b' }) },
  { key: 'ocean', name: 'Ocean', description: 'Trustworthy blue, common in finance tools.', tokens: preset('#0369a1', '#f0f9ff', { accent: '#0c4a6e' }) },
  { key: 'sunset', name: 'Sunset', description: 'Warm orange for friendly consumer brands.', tokens: preset('#ea580c', '#fff7ed', { accent: '#431407' }, { radius: 12 }) },
  { key: 'rose', name: 'Rose', description: 'Bold rose accent.', tokens: preset('#e11d48', '#fff1f2', { accent: '#4c0519' }, { radius: 10 }) },
  { key: 'midnight', name: 'Midnight', description: 'Dark-first theme with violet highlights.', tokens: preset('#7c3aed', '#f5f3ff', { accent: '#2e1065' }, { appearance: 'dark', shadow: 'none' }) },
];

/**
 * Custom CSS is accepted from administrators but still treated as untrusted
 * markup: anything that could break out of the <style> element, load remote
 * code or run script is stripped.
 */
export function sanitizeCss(css: string): string {
  return css
    .slice(0, 50_000)
    .replace(/<\/?\s*style/gi, '')
    .replace(/<!--|-->/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/(javascript|vbscript)\s*:/gi, '')
    .replace(/behavior\s*:/gi, '')
    .replace(/-moz-binding\s*:/gi, '')
    .replace(/url\(\s*(['"]?)(?!(https:\/\/|data:image\/(png|gif|jpeg|webp);|\/))[^)]*\)/gi, 'url()');
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function vars(colors: Partial<z.infer<typeof colorTokens>>): string {
  return Object.entries(colors)
    .map(([k, v]) => `--color-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v}; --rgb-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${hexToRgb(v as string)};`)
    .join(' ');
}

/** Render tokens as CSS custom properties consumed by the admin UI, hosted pages and the client SDK. */
export function themeCss(tokens: ThemeTokens, customCss = ''): string {
  const shadow = { none: 'none', sm: '0 1px 2px rgb(0 0 0 / 0.06)', md: '0 4px 12px rgb(0 0 0 / 0.08)' }[tokens.shadow];
  const scale = tokens.density === 'compact' ? 0.875 : 1;
  const root = `:root { ${vars(tokens.colors)} --font-sans: ${tokens.typography.fontFamily}; --font-heading: ${tokens.typography.headingFamily || tokens.typography.fontFamily}; --font-mono: ${tokens.typography.monoFamily}; --font-size-base: ${tokens.typography.baseSize}px; --radius: ${tokens.radius}px; --shadow: ${shadow}; --density: ${scale}; }`;
  const dark = Object.keys(tokens.dark).length ? `:root.dark, [data-theme="dark"] { ${vars(tokens.dark)} }` : '';
  const system =
    tokens.appearance === 'system' && Object.keys(tokens.dark).length
      ? `@media (prefers-color-scheme: dark) { :root:not(.light):not([data-theme="light"]) { ${vars(tokens.dark)} } }`
      : '';
  const sanitized = sanitizeCss(customCss);
  return [root, dark, system, sanitized ? `/* custom */\n${sanitized}` : ''].filter(Boolean).join('\n');
}
