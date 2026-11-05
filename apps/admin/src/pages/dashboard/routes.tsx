import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [{ index: true, element: page(() => import('./DashboardPage')) }];
