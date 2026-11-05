import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [{ path: 'platform/health', element: page(() => import('./IntegrationHealthPage')) }];
