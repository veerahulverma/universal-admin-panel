import { Badge } from '../../components/ui';

export interface TemplateSummary {
  id: string;
  key: string;
  locale: string;
  name: string;
  description: string;
  category: 'transactional' | 'security' | 'billing' | 'marketing';
  subject: string;
  variables: string[];
  is_system: boolean;
  edited: boolean;
  version: number;
  updated_at: string;
}

export interface TemplateFull extends TemplateSummary {
  html: string;
  text: string | null;
  sample_data: Record<string, unknown>;
}

export const CATEGORY_HELP: Record<string, string> = {
  transactional: 'Account and product messages; always delivered',
  security: 'Sign-in, password and verification; always delivered',
  billing: 'Invoices, receipts and payment issues; always delivered',
  marketing: 'Promotional; needs consent and includes an unsubscribe link',
};

export function templateState(t: Pick<TemplateSummary, 'is_system' | 'edited'>) {
  if (!t.is_system) return <Badge tone="info">custom</Badge>;
  return t.edited ? <Badge tone="warning">customized</Badge> : <Badge>default</Badge>;
}
