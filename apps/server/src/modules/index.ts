import type { ModuleDefinition } from '../core/modules.js';
import { coreModule } from './core/module.js';
import { securityModule } from './security/module.js';
import { iamModule } from './iam/module.js';
import { customersModule } from './customers/module.js';
import { developersModule } from './developers/module.js';
import { catalogModule } from './catalog/module.js';
import { usageModule } from './usage/module.js';
import { billingModule } from './billing/module.js';
import { reportsModule } from './reports/module.js';
import { pluginsModule } from './plugins/module.js';
import { themesModule } from './themes/module.js';
import { identityModule } from './identity/module.js';
import { affiliatesModule } from './affiliates/module.js';
import { supportModule } from './support/module.js';
import { emailModule } from './email/module.js';
import { notificationsModule } from './notifications/module.js';
import { marketingModule } from './marketing/module.js';
import { accessModule } from './access/module.js';

/** Every module shipped with the platform. Order does not matter; dependencies are resolved at boot. */
export const allModules: ModuleDefinition[] = [
  coreModule,
  securityModule,
  iamModule,
  customersModule,
  developersModule,
  catalogModule,
  usageModule,
  billingModule,
  reportsModule,
  pluginsModule,
  themesModule,
  identityModule,
  affiliatesModule,
  supportModule,
  emailModule,
  notificationsModule,
  marketingModule,
  accessModule,
];
