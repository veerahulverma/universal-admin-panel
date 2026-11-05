import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'growth/affiliates', element: page(() => import('./AffiliatesPage')) },
  { path: 'growth/affiliates/:id', element: page(() => import('./AffiliateDetailPage')) },
  { path: 'growth/campaigns', element: page(() => import('./CampaignsPage')) },
  { path: 'growth/campaigns/:id', element: page(() => import('./CampaignDetailPage')) },
  { path: 'growth/segments', element: page(() => import('./SegmentsPage')) },
  { path: 'growth/segments/new', element: page(() => import('./SegmentEditorPage')) },
  { path: 'growth/segments/:id', element: page(() => import('./SegmentEditorPage')) },
  { path: 'growth/email/messages', element: page(() => import('./EmailMessagesPage')) },
  { path: 'growth/email/messages/:id', element: page(() => import('./EmailMessageDetailPage')) },
  { path: 'growth/email/providers', element: page(() => import('./EmailProvidersPage')) },
  { path: 'growth/email/templates', element: page(() => import('./EmailTemplatesPage')) },
  { path: 'growth/email/templates/:id', element: page(() => import('./EmailTemplateEditorPage')) },
];
