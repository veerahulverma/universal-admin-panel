import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

/** Content & Access (protected resources, downloads, access log) and User Management → User groups. */
export const routes: RouteObject[] = [
  { path: 'customers/groups', element: page(() => import('./GroupsPage')) },
  { path: 'customers/groups/:id', element: page(() => import('./GroupDetailPage')) },
  { path: 'content/resources', element: page(() => import('./ResourcesPage')) },
  { path: 'content/resources/new', element: page(() => import('./ResourceEditPage')) },
  { path: 'content/resources/:id', element: page(() => import('./ResourceEditPage')) },
  { path: 'content/files', element: page(() => import('./FilesPage')) },
  { path: 'content/files/:id', element: page(() => import('./FileDetailPage')) },
  { path: 'content/log', element: page(() => import('./AccessLogPage')) },
];
