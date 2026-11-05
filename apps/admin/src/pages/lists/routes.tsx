import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'growth/lists', element: page(() => import('./MailingListsPage')) },
  { path: 'growth/lists/:id', element: page(() => import('./MailingListDetailPage')) },
];
