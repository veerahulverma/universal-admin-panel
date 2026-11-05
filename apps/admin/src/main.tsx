import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import './styles.css';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ConfirmProvider, ToastProvider, TooltipProvider } from './components/ui';
import { ReauthDialog } from './components/ReauthDialog';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Client errors (403, 404, validation) will not fix themselves; only retry transient failures.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider delayDuration={300}>
            <ToastProvider>
              <ConfirmProvider>
                <RouterProvider router={router} />
                <ReauthDialog />
              </ConfirmProvider>
            </ToastProvider>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Installable PWA: the worker caches the app shell only, never API responses or payment pages.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
