import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'customers/kb', element: page(() => import('./KnowledgeBasePage')) },
  { path: 'customers/kb/new', element: page(() => import('./ArticleEditorPage')) },
  { path: 'customers/kb/:id', element: page(() => import('./ArticleEditorPage')) },
];
