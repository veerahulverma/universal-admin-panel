import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'customers/users', element: page(() => import('./UsersPage')) },
  { path: 'customers/users/:id', element: page(() => import('./UserDetailPage')) },
  { path: 'customers/organizations', element: page(() => import('./OrganizationsPage')) },
  { path: 'customers/organizations/:id', element: page(() => import('./OrganizationDetailPage')) },
  { path: 'customers/privacy', element: page(() => import('./PrivacyPage')) },
  { path: 'customers/support', element: page(() => import('./SupportPage')) },
  { path: 'customers/support/:id', element: page(() => import('./TicketPage')) },
];
