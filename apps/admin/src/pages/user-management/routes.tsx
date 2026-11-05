import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'customers/signup-forms', element: page(() => import('./SignupFormsPage')) },
  { path: 'customers/signup-forms/:id', element: page(() => import('./SignupFormEditorPage')) },
  { path: 'customers/agreements', element: page(() => import('./AgreementsPage')) },
  { path: 'customers/agreements/:id', element: page(() => import('./AgreementDetailPage')) },
  { path: 'customers/social-sign-in', element: page(() => import('./SocialSignInPage')) },
];
