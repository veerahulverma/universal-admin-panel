import type { RouteObject } from 'react-router';
import { page } from '../../lib/page';

export const routes: RouteObject[] = [
  { path: 'platform/modules', element: page(() => import('./ModulesPage')) },
  { path: 'platform/system', element: page(() => import('./SystemPage')) },
  { path: 'platform/settings', element: page(() => import('./SettingsPage')) },
  { path: 'platform/settings/:section', element: page(() => import('./SettingsPage')) },
  { path: 'platform/gateways', element: page(() => import('./GatewaysPage')) },
  { path: 'platform/gateways/:id', element: page(() => import('./GatewayDetailPage')) },
  { path: 'platform/plugins', element: page(() => import('./PluginsPage')) },
  { path: 'platform/plugins/:id', element: page(() => import('./PluginDetailPage')) },
  { path: 'platform/plugins/:id/pages/:pageId', element: page(() => import('./PluginAdminPage')) },
  { path: 'platform/themes', element: page(() => import('./ThemesPage')) },
  { path: 'platform/themes/:id', element: page(() => import('./ThemeEditorPage')) },
];
