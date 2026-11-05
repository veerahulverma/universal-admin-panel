import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { Bell, ChevronDown, ChevronsLeft, ChevronsRight, Keyboard, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun, UserCog } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { applyBrand, useTheme } from '../../lib/theme';
import { useHotkey, useLocalStorage } from '../../lib/hooks';
import { NavIcon } from '../../lib/icons';
import { ago } from '../../lib/format';
import { Avatar, Button, Menu, Modal, PageSkeleton, Popover, Sheet, Tip } from '../ui';
import { CommandPalette } from './CommandPalette';
import { activeNavItem, groupNav, type Bootstrap, type NavGroup, type NavItem } from './nav';

export function useBootstrap() {
  return useQuery({ queryKey: ['bootstrap'], queryFn: () => api.get<Bootstrap>('/api/admin/bootstrap'), staleTime: 5 * 60_000 });
}

function Brand({ boot, collapsed }: { boot?: Bootstrap; collapsed?: boolean }) {
  const logo = boot?.theme?.assets?.logoUrl || boot?.app.logoUrl;
  const name = boot?.theme?.tokens?.branding?.appName || boot?.app.name || 'Admin';
  return (
    <Link to="/" className="flex h-14 shrink-0 items-center gap-3 px-5 text-base font-semibold">
      {logo ? (
        <img src={logo} alt="" className="size-8 rounded-ui-sm object-contain" />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-ui-sm bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {!collapsed && <span className="truncate">{name}</span>}
    </Link>
  );
}

const ROW = 'flex w-full items-center gap-3 rounded-ui-sm px-3 py-2 text-md transition-colors';
const RAIL = 'mx-auto flex size-11 items-center justify-center rounded-ui-sm transition-colors';
const IDLE = 'text-muted-foreground hover:bg-muted hover:text-foreground';
const CURRENT = 'bg-primary/10 font-medium text-primary';

/** Collapsed sidebar: a parent menu's icon opens its pages in a flyout. */
function RailMenu({ group, activeId }: { group: NavGroup; activeId?: string }) {
  const picked = useRef(false);
  return (
    <DropdownMenu.Root>
      <Tip content={group.label} side="right">
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={group.label} className={clsx(RAIL, group.items.some((i) => i.id === activeId) ? CURRENT : IDLE)}>
            <NavIcon name={group.icon} className="size-5" />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={10}
          // After picking a page, focus stays with the page instead of re-opening the tooltip.
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault();
            picked.current = false;
          }}
          className="z-50 min-w-56 rounded-ui border bg-surface p-1 shadow-lg animate-pop-in"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</DropdownMenu.Label>
          {group.items.map((item) => (
            <DropdownMenu.Item key={item.id} asChild onSelect={() => (picked.current = true)}>
              <Link
                to={item.path}
                aria-current={item.id === activeId ? 'page' : undefined}
                className={clsx('flex cursor-pointer select-none items-center gap-2.5 rounded-ui-sm px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-muted', item.id === activeId && 'font-medium text-primary')}
              >
                <NavIcon name={item.icon} className="size-4 shrink-0" />
                {item.label}
              </Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SidebarNav({ nav, collapsed, onNavigate }: { nav: NavItem[]; collapsed?: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const groups = useMemo(() => groupNav(nav), [nav]);
  const active = activeNavItem(nav, pathname);
  const [open, setOpen] = useState(active?.section);
  const ref = useRef<HTMLElement>(null);

  // Opening a page expands its parent menu and closes the others.
  useEffect(() => {
    if (active?.section) setOpen(active.section);
  }, [active?.section, pathname]);

  // Once the menu has expanded, scroll the current page into view if it is below the fold.
  useEffect(() => {
    if (collapsed) return;
    const timer = setTimeout(() => {
      const box = ref.current;
      const el = box?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!box || !el) return;
      const outer = box.getBoundingClientRect();
      const inner = el.getBoundingClientRect();
      if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom + 8;
      else if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top + 8;
    }, 220);
    return () => clearTimeout(timer);
  }, [active?.id, collapsed]);

  if (collapsed) {
    return (
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-1">
          {groups.map((g) =>
            g.flat ? (
              g.items.map((item) => (
                <li key={item.id}>
                  <Tip content={item.label} side="right">
                    <Link to={item.path} aria-label={item.label} aria-current={item.id === active?.id ? 'page' : undefined} className={clsx(RAIL, item.id === active?.id ? CURRENT : IDLE)}>
                      <NavIcon name={item.icon} className="size-5" />
                    </Link>
                  </Tip>
                </li>
              ))
            ) : (
              <li key={g.id}>
                <RailMenu group={g} activeId={active?.id} />
              </li>
            ),
          )}
        </ul>
      </nav>
    );
  }

  return (
    <nav ref={ref} aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3">
      <ul className="space-y-1">
        {groups.map((g) => {
          if (g.flat) {
            return g.items.map((item) => (
              <li key={item.id}>
                <Link to={item.path} onClick={onNavigate} aria-current={item.id === active?.id ? 'page' : undefined} className={clsx(ROW, item.id === active?.id ? CURRENT : IDLE)}>
                  <NavIcon name={item.icon} className="size-5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            ));
          }
          const expanded = open === g.id;
          const current = active?.section === g.id;
          return (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? undefined : g.id)}
                aria-expanded={expanded}
                aria-controls={`nav-${g.id}`}
                className={clsx(ROW, current ? 'font-medium text-foreground hover:bg-muted' : IDLE)}
              >
                <NavIcon name={g.icon} className={clsx('size-5 shrink-0', current && 'text-primary')} />
                <span className="min-w-0 flex-1 truncate text-left">{g.label}</span>
                <ChevronDown className={clsx('size-4 shrink-0 text-muted-foreground transition-transform duration-200', expanded && 'rotate-180')} aria-hidden="true" />
              </button>
              {/* Rows animate open; inert keeps the links of a closed menu out of the tab order. */}
              <div id={`nav-${g.id}`} inert={!expanded} className={clsx('grid transition-[grid-template-rows] duration-200 ease-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                <div className="overflow-hidden">
                  <ul className="my-1 ml-[1.375rem] space-y-0.5 border-l pl-2">
                    {g.items.map((item) => {
                      const on = item.id === active?.id;
                      return (
                        <li key={item.id}>
                          <Link
                            to={item.path}
                            onClick={onNavigate}
                            aria-current={on ? 'page' : undefined}
                            className={clsx(
                              'relative flex rounded-ui-sm px-3 py-1.5 text-md transition-colors',
                              on ? `${CURRENT} before:absolute before:inset-y-1.5 before:-left-[calc(0.5rem+1px)] before:w-0.5 before:rounded-full before:bg-primary` : IDLE,
                            )}
                          >
                            <span className="truncate">{item.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
}

function Notifications() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: NotificationRow[]; unread: number }>('/api/admin/notifications', { pageSize: 15 }),
    refetchInterval: 60_000,
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/api/admin/notifications/read', { all: true }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = q.data?.unread ?? 0;
  return (
    <Popover
      className="w-[min(24rem,calc(100vw-1rem))]"
      trigger={
        <button type="button" className="relative rounded-ui-sm p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell className="size-[18px]" />
          {unread > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-danger px-1 text-center text-2xs font-semibold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
        </button>
      }
    >
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <p className="text-sm font-semibold">Notifications</p>
        {unread > 0 && (
          <Button variant="link" size="sm" onClick={() => markAll.mutate()}>
            Mark all read
          </Button>
        )}
      </div>
      <ul className="max-h-96 overflow-y-auto">
        {(q.data?.data ?? []).length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">You're all caught up.</li>}
        {(q.data?.data ?? []).map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={async () => {
                if (!n.read_at) await api.post('/api/admin/notifications/read', { ids: [n.id] }).catch(() => undefined);
                client.invalidateQueries({ queryKey: ['notifications'] });
                if (n.link) navigate(n.link);
              }}
              className="flex w-full items-start gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-muted/50"
            >
              <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : n.severity === 'critical' ? 'bg-danger' : n.severity === 'warning' ? 'bg-warning' : 'bg-primary')} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{n.title}</span>
                {n.body && <span className="block truncate text-xs text-muted-foreground">{n.body}</span>}
                <span className="text-xs text-muted-foreground">{ago(n.created_at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl / ⌘ + K', 'Search everything'],
  ['/', 'Focus the search box on a list'],
  ['g then d', 'Dashboard'],
  ['g then u', 'Users'],
  ['g then s', 'Subscriptions'],
  ['g then p', 'Payments'],
  ['?', 'Show keyboard shortcuts'],
];

export function AppShell() {
  const { me, logout } = useAuth();
  const { appearance, setAppearance } = useTheme();
  const boot = useBootstrap();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useLocalStorage('stw.sidebar.collapsed', false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const nav = useMemo(() => boot.data?.nav ?? [], [boot.data]);

  useEffect(() => {
    const theme = boot.data?.theme;
    applyBrand(theme ? { css: theme.css, appName: theme.tokens?.branding?.appName || boot.data?.app.name, faviconUrl: theme.assets?.faviconUrl || boot.data?.app.faviconUrl, primary: theme.tokens?.colors?.primary } : boot.data ? { appName: boot.data.app.name } : null);
  }, [boot.data]);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  useHotkey('mod+k', () => setPaletteOpen(true));
  useHotkey('?', () => setHelpOpen(true));
  useHotkey('/', () => document.querySelector<HTMLInputElement>('[data-search-input]')?.focus());
  useHotkey('g d', () => navigate('/'));
  useHotkey('g u', () => navigate('/customers/users'));
  useHotkey('g s', () => navigate('/revenue/subscriptions'));
  useHotkey('g p', () => navigate('/revenue/payments'));

  const ThemeIcon = appearance === 'dark' ? Moon : appearance === 'light' ? Sun : Monitor;

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className={clsx('sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-surface lg:flex', collapsed ? 'w-18' : 'w-68')}>
        <Brand boot={boot.data} collapsed={collapsed} />
        <SidebarNav nav={nav} collapsed={collapsed} />
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className={clsx('flex shrink-0 items-center gap-3 border-t py-3 text-sm text-muted-foreground hover:text-foreground', collapsed ? 'justify-center' : 'px-6')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="size-5" /> : <ChevronsLeft className="size-5" />}
          {!collapsed && 'Collapse'}
        </button>
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="Navigation">
        <Brand boot={boot.data} />
        <SidebarNav nav={nav} onNavigate={() => setMobileOpen(false)} />
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-surface/90 px-3 backdrop-blur sm:px-4">
          <button type="button" className="rounded-ui-sm p-2 text-muted-foreground hover:bg-muted lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <MenuIcon className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-ui-sm border bg-background px-3 text-sm text-muted-foreground hover:border-muted-foreground/40 sm:max-w-md"
            aria-label="Search"
          >
            <Search className="size-4 shrink-0" />
            <span className="truncate">Search…</span>
            <kbd className="ml-auto hidden rounded border bg-surface px-1.5 text-2xs sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <Menu
              trigger={
                <button type="button" className="rounded-ui-sm p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Appearance">
                  <ThemeIcon className="size-[18px]" />
                </button>
              }
              items={[
                { label: 'Light', icon: <Sun className="size-4" />, onSelect: () => setAppearance('light') },
                { label: 'Dark', icon: <Moon className="size-4" />, onSelect: () => setAppearance('dark') },
                { label: 'System', icon: <Monitor className="size-4" />, onSelect: () => setAppearance('system') },
              ]}
            />
            <Menu
              trigger={
                <button type="button" className="ml-1 rounded-full" aria-label="Account menu">
                  <Avatar name={me?.admin.name} email={me?.admin.email} src={me?.admin.avatarUrl} />
                </button>
              }
              items={[
                { label: <span className="block max-w-56 truncate text-xs text-muted-foreground">{me?.admin.email}</span>, disabled: true },
                { separator: true, label: '' },
                { label: 'Account & security', icon: <UserCog className="size-4" />, onSelect: () => navigate('/account') },
                { label: 'Keyboard shortcuts', icon: <Keyboard className="size-4" />, onSelect: () => setHelpOpen(true) },
                { separator: true, label: '' },
                { label: 'Sign out', icon: <LogOut className="size-4" />, danger: true, onSelect: () => void logout().then(() => navigate('/login')) },
              ]}
            />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 lg:py-6">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} nav={nav} />
      <Modal open={helpOpen} onOpenChange={setHelpOpen} title="Keyboard shortcuts" size="sm">
        <dl className="space-y-2">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{v}</dt>
              <dd>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}
