export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: string;
  section: string;
  permission?: string;
  order?: number;
  module?: string;
}

export interface Bootstrap {
  app: { name: string; logoUrl: string; faviconUrl: string; version: string };
  locale: { locale: string; timezone: string; dateFormat: string; currency: string; currencies: string[] };
  nav: NavItem[];
  modules: { id: string; enabled: boolean }[];
  theme: { name: string; revision: number; tokens: any; assets: Record<string, string>; css: string } | null;
}

export interface NavSection {
  id: string;
  label: string;
  icon: string;
  /** Items show as top-level links instead of under an expandable parent menu. */
  flat?: boolean;
}

/**
 * Sidebar parent menus in display order. Each module places its nav items in one by `section`
 * (apps/server/src/core/modules.ts). Section ids are stable keys; admins only see the labels.
 */
export const SECTIONS: NavSection[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard', flat: true },
  { id: 'customers', label: 'User Management', icon: 'users' },
  { id: 'catalog', label: 'Products & Plans', icon: 'package' },
  { id: 'revenue', label: 'Billing & Payments', icon: 'credit-card' },
  { id: 'content', label: 'Content & Access', icon: 'shield-check' },
  { id: 'platform', label: 'Integrations', icon: 'puzzle' },
  { id: 'developers', label: 'Developers', icon: 'code' },
  { id: 'growth', label: 'Marketing', icon: 'megaphone' },
  { id: 'email', label: 'Email', icon: 'mail' },
  { id: 'admin', label: 'System', icon: 'server-cog' },
];

export interface NavGroup extends NavSection {
  items: NavItem[];
}

const byOrder = (a: NavItem, b: NavItem) => (a.order ?? 50) - (b.order ?? 50) || a.label.localeCompare(b.label);

/** Items grouped by section in SECTIONS order; an unknown section gets its own menu at the end. */
export function groupNav(items: NavItem[]): NavGroup[] {
  const known = new Set(SECTIONS.map((s) => s.id));
  const extra = [...new Set(items.map((i) => i.section))]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), icon: 'circle' }));
  return [...SECTIONS, ...extra].map((s) => ({ ...s, items: items.filter((i) => i.section === s.id).sort(byOrder) })).filter((g) => g.items.length > 0);
}

/** The item a location belongs to: the longest nav path equal to it or a parent of it. */
export function activeNavItem(items: NavItem[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of items) {
    const match = item.path === '/' ? pathname === '/' : pathname === item.path || pathname.startsWith(`${item.path}/`);
    if (match && (!best || item.path.length > best.path.length)) best = item;
  }
  return best;
}

export function sectionLabel(id: string): string | undefined {
  return SECTIONS.find((s) => s.id === id)?.label;
}
