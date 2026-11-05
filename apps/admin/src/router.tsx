import { createBrowserRouter, Navigate, useLocation, useRouteError, type RouteObject } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { page } from './lib/page';
import { AppShell } from './components/layout/AppShell';
import { PublicLayout } from './pages/auth/AuthLayout';
import { Button, ErrorState, Spinner } from './components/ui';

/**
 * Each area of the console lives in `pages/<area>/routes.tsx` and exports its
 * routes; they are discovered here, so adding an area needs no central edit.
 * Pages themselves are code-split.
 */
const areas = import.meta.glob<{ routes: RouteObject[] }>('./pages/*/routes.tsx', { eager: true });
const areaRoutes = Object.values(areas).flatMap((m) => m.routes);

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-6">{children}</div>;
}

/** Signed-in area: resolves first-run setup, sign-in, 2FA challenge and enrollment before the shell. */
function RequireAuth() {
  const { me, loading, error, refresh } = useAuth();
  const location = useLocation();
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<{ needsSetup: boolean }>('/api/admin/setup/status'),
    enabled: !loading && !me && !error,
    staleTime: 30_000,
  });
  const next = encodeURIComponent(location.pathname + location.search);

  if (loading || (!me && !error && setup.isLoading)) {
    return (
      <FullScreen>
        <Spinner className="size-6" />
      </FullScreen>
    );
  }
  if (error || setup.error) {
    return (
      <FullScreen>
        <ErrorState title="Cannot reach the server" error={error ?? setup.error} onRetry={() => void refresh()} />
      </FullScreen>
    );
  }
  if (!me) return <Navigate to={setup.data?.needsSetup ? '/setup' : `/login?next=${next}`} replace />;
  if (me.session.mfaRequired) return <Navigate to={`/login?next=${next}`} replace />;
  if (me.session.enrollmentRequired) return <Navigate to="/two-factor" replace />;
  return <AppShell />;
}

function RouteError() {
  const error = useRouteError();
  return (
    <FullScreen>
      <div className="text-center">
        <ErrorState title="This page crashed" error={error} />
        <Button variant="outline" onClick={() => window.location.assign('/')}>
          Back to the dashboard
        </Button>
      </div>
    </FullScreen>
  );
}

export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: page(() => import('./pages/auth/LoginPage')) },
      { path: '/setup', element: page(() => import('./pages/auth/SetupPage')) },
      { path: '/accept-invite', element: page(() => import('./pages/auth/AcceptInvitePage')) },
      { path: '/forgot-password', element: page(() => import('./pages/auth/ForgotPasswordPage')) },
      { path: '/reset-password', element: page(() => import('./pages/auth/ResetPasswordPage')) },
      { path: '/two-factor', element: page(() => import('./pages/auth/TwoFactorSetupPage')) },
    ],
  },
  {
    path: '/',
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [...areaRoutes, { path: '*', element: page(() => import('./pages/NotFoundPage')) }],
  },
]);
