import { lazy, type ComponentType, type ReactElement } from 'react';

/**
 * Code-split route element. The nearest Suspense boundary (the app shell, or
 * the public layout for sign-in pages) shows a skeleton while the chunk loads.
 */
export function page(loader: () => Promise<{ default: ComponentType }>): ReactElement {
  const Component = lazy(loader);
  return <Component />;
}

/** Only allow same-origin, absolute-path redirects after sign-in (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
