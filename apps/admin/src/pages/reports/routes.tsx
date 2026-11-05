import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [{ path: 'reports', element: page(() => import('./ReportsPage')) }];
