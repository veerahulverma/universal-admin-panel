import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'admin/team', element: page(() => import('./TeamPage')) },
  { path: 'admin/team/:id', element: page(() => import('./AdminDetailPage')) },
  { path: 'admin/roles', element: page(() => import('./RolesPage')) },
  { path: 'admin/roles/new', element: page(() => import('./RoleEditorPage')) },
  { path: 'admin/roles/:id', element: page(() => import('./RoleEditorPage')) },
  { path: 'admin/approvals', element: page(() => import('./ApprovalsPage')) },
  { path: 'admin/security', element: page(() => import('./SecurityPage')) },
  { path: 'admin/audit', element: page(() => import('./AuditPage')) },
];
