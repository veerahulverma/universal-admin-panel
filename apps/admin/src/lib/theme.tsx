import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Appearance = 'light' | 'dark' | 'system';

interface ThemeState {
  appearance: Appearance;
  resolved: 'light' | 'dark';
  setAppearance: (a: Appearance) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
const KEY = 'stw.appearance';

function read(): Appearance {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(read);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
    root.dataset.theme = resolved;
  }, [resolved]);

  const setAppearance = (a: Appearance) => {
    setAppearanceState(a);
    try {
      localStorage.setItem(KEY, a);
    } catch {
      /* private mode */
    }
  };

  return <ThemeContext.Provider value={{ appearance, resolved, setAppearance }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

let brandName = 'Admin';
let currentPage: string | null = null;

/** Set the browser tab title for a page ("Users · Acme Admin"). */
export function pageTitle(title?: string | null): void {
  currentPage = title ?? null;
  document.title = currentPage ? `${currentPage} · ${brandName}` : brandName;
}

/** Inject the server's white-label theme CSS (design tokens) and brand assets. */
export function applyBrand(brand: { css?: string; appName?: string; faviconUrl?: string; primary?: string } | null): void {
  let style = document.getElementById('stw-brand') as HTMLStyleElement | null;
  if (brand?.css) {
    if (!style) {
      style = document.createElement('style');
      style.id = 'stw-brand';
      document.head.appendChild(style);
    }
    style.textContent = brand.css;
  } else style?.remove();
  if (brand?.appName) {
    brandName = brand.appName;
    pageTitle(currentPage);
  }
  if (brand?.faviconUrl) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = brand.faviconUrl;
  }
  if (brand?.primary) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', brand.primary);
}
