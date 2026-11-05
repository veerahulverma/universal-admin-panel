import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'developers/api-keys', element: page(() => import('./ApiKeysPage')) },
  { path: 'developers/webhooks', element: page(() => import('./WebhooksPage')) },
  { path: 'developers/webhooks/:id', element: page(() => import('./WebhookDetailPage')) },
  { path: 'developers/logs', element: page(() => import('./LogsPage')) },
  { path: 'developers/explorer', element: page(() => import('./ExplorerPage')) },
  { path: 'developers/events', element: page(() => import('./EventsPage')) },
];
