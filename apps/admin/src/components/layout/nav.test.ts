import { describe, expect, it } from 'vitest';
import { activeNavItem, groupNav, sectionLabel, type NavItem } from './nav';

const item = (id: string, path: string, section: string, order?: number): NavItem => ({ id, label: id, path, icon: 'circle', section, order });

const NAV: NavItem[] = [
  item('settings', '/platform/settings', 'admin', 90),
  item('team', '/admin/team', 'admin', 0),
  item('dashboard', '/', 'overview', 0),
  item('plugins', '/platform/plugins', 'platform', 10),
  item('plugin-acme-report', '/platform/plugins/acme/pages/report', 'platform', 100),
  item('orders', '/revenue/orders', 'revenue', 30),
  item('subscriptions', '/revenue/subscriptions', 'catalog', 20),
  item('custom', '/custom', 'partners'),
];

describe('groupNav', () => {
  it('orders menus as the sidebar lists them and items by their order', () => {
    const groups = groupNav(NAV);
    expect(groups.map((g) => g.id)).toEqual(['overview', 'catalog', 'revenue', 'platform', 'admin', 'partners']);
    expect(groups.find((g) => g.id === 'admin')?.items.map((i) => i.id)).toEqual(['team', 'settings']);
  });

  it('shows overview items as top-level links and drops empty menus', () => {
    const groups = groupNav(NAV);
    expect(groups[0]).toMatchObject({ id: 'overview', flat: true });
    expect(groups.some((g) => g.id === 'growth')).toBe(false);
  });

  it('keeps items from an unknown section in a menu of their own', () => {
    expect(groupNav(NAV).at(-1)).toMatchObject({ id: 'partners', label: 'Partners', items: [expect.objectContaining({ id: 'custom' })] });
  });

  it('labels sections with the names admins see', () => {
    expect(sectionLabel('customers')).toBe('User Management');
    expect(sectionLabel('admin')).toBe('System');
    expect(sectionLabel('nope')).toBeUndefined();
  });
});

describe('activeNavItem', () => {
  it('matches the dashboard only on the root path', () => {
    expect(activeNavItem(NAV, '/')?.id).toBe('dashboard');
    expect(activeNavItem(NAV, '/account')).toBeUndefined();
  });

  it('keeps a list item active on its detail pages', () => {
    expect(activeNavItem(NAV, '/revenue/subscriptions/sub_1')?.id).toBe('subscriptions');
    expect(activeNavItem(NAV, '/platform/settings/billing')?.id).toBe('settings');
  });

  it('prefers the most specific path', () => {
    expect(activeNavItem(NAV, '/platform/plugins/acme/pages/report')?.id).toBe('plugin-acme-report');
    expect(activeNavItem(NAV, '/platform/plugins/acme')?.id).toBe('plugins');
  });

  it('only matches whole path segments', () => {
    expect(activeNavItem(NAV, '/revenue/orders-archive')).toBeUndefined();
  });
});
