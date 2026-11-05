import { Suspense, useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { applyBrand, pageTitle } from '../../lib/theme';
import { Spinner } from '../../components/ui';

interface PublicBranding {
  appName: string;
  assets: Record<string, string | undefined>;
}

/** Name, logo and theme for signed-out screens (the white-label applies before sign-in too). */
export function usePublicBranding() {
  return useQuery({
    queryKey: ['public-branding'],
    queryFn: async () => {
      try {
        const [branding, css] = await Promise.all([
          api.raw<PublicBranding>('GET', '/api/public/branding', { quiet401: true }),
          fetch('/api/public/theme.css').then((r) => (r.ok ? r.text() : '')),
        ]);
        return { ...branding, css };
      } catch {
        return null; // themes module disabled or unreachable: fall back to the defaults
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function PublicLayout() {
  const branding = usePublicBranding();
  useEffect(() => {
    if (branding.data) applyBrand({ css: branding.data.css, appName: branding.data.appName, faviconUrl: branding.data.assets?.faviconUrl });
  }, [branding.data]);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Suspense fallback={<Spinner className="size-6" />}>
        <Outlet />
      </Suspense>
    </div>
  );
}

export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const branding = usePublicBranding();
  const name = branding.data?.appName ?? 'Admin';
  const logo = branding.data?.assets?.logoUrl;
  useEffect(() => {
    pageTitle(title); // the brand name is appended once branding loads
  }, [title]);
  return (
    <main className="w-full max-w-sm animate-fade-in">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        {logo ? (
          <img src={logo} alt={name} className="h-10 max-w-40 object-contain" />
        ) : (
          <span className="flex size-10 items-center justify-center rounded-ui bg-primary text-lg font-bold text-primary-foreground" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-md text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="rounded-ui border bg-surface p-6 shadow-ui">{children}</div>
      {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}
