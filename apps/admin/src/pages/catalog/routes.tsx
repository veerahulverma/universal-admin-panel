import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'catalog/products', element: page(() => import('./ProductsPage')) },
  { path: 'catalog/products/:id', element: page(() => import('./ProductDetailPage')) },
  { path: 'catalog/features', element: page(() => import('./FeaturesPage')) },
  { path: 'catalog/coupons', element: page(() => import('./CouponsPage')) },
  { path: 'catalog/usage', element: page(() => import('./UsagePage')) },
];
