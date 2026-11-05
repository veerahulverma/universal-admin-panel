import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'revenue/subscriptions', element: page(() => import('./SubscriptionsPage')) },
  { path: 'revenue/subscriptions/:id', element: page(() => import('./SubscriptionDetailPage')) },
  { path: 'revenue/invoices', element: page(() => import('./InvoicesPage')) },
  { path: 'revenue/invoices/:id', element: page(() => import('./InvoiceDetailPage')) },
  { path: 'revenue/payments', element: page(() => import('./PaymentsPage')) },
  { path: 'revenue/payments/:id', element: page(() => import('./PaymentDetailPage')) },
  { path: 'revenue/orders', element: page(() => import('./OrdersPage')) },
  { path: 'revenue/disputes', element: page(() => import('./DisputesPage')) },
  { path: 'revenue/taxes', element: page(() => import('./TaxesPage')) },
  // Gift vouchers belong to billing (they grant products and account credit) but sit in the Marketing menu.
  { path: 'growth/vouchers', element: page(() => import('./VouchersPage')) },
];
