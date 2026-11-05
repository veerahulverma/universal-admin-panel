import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [{ path: 'growth/push', element: page(() => import('./PushPage')) }];
