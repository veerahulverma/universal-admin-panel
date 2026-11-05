import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'growth/email/autoresponders', element: page(() => import('./AutorespondersPage')) },
  { path: 'growth/email/autoresponders/new', element: page(() => import('./SequenceEditorPage')) },
  { path: 'growth/email/autoresponders/:id', element: page(() => import('./SequenceEditorPage')) },
];
