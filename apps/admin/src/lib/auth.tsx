import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, onUnauthorized, setCsrfToken } from './api';

export interface Me {
  admin: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    totpEnabled: boolean;
    recoveryCodesLeft: number;
    orgScope: string[] | null;
    roles: { id: string; key: string; name: string }[];
    lastLoginAt: string | null;
  };
  grants: string[];
  permissions: string[];
  session: { id: string; mfaRequired: boolean; enrollmentRequired: boolean; reauthValidUntil: string | null; expiresAt: string };
  csrfToken: string;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  /** Set when the session check failed for a reason other than "signed out" (server unreachable...). */
  error: unknown;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.raw<Me>('GET', '/api/admin/auth/me', { quiet401: true });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => setCsrfToken(query.data?.csrfToken ?? null), [query.data]);

  useEffect(() => {
    onUnauthorized(() => {
      setCsrfToken(null);
      client.setQueryData(['me'], null);
    });
    return () => onUnauthorized(null);
  }, [client]);

  const permissions = useMemo(() => new Set(query.data?.permissions ?? []), [query.data]);
  const can = useCallback((p: string) => permissions.has(p), [permissions]);
  const canAny = useCallback((...ps: string[]) => ps.some((p) => permissions.has(p)), [permissions]);

  const refresh = useCallback(async () => {
    const result = await query.refetch();
    return result.data ?? null;
  }, [query]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/admin/auth/logout', {});
    } finally {
      setCsrfToken(null);
      client.clear();
      client.setQueryData(['me'], null);
    }
  }, [client]);

  const value: AuthState = { me: query.data ?? null, loading: query.isLoading, error: query.error, can, canAny, refresh, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Render children only when the admin holds the permission (the server enforces it regardless). */
export function Can({ permission, children, fallback = null }: { permission: string | string[]; children: ReactNode; fallback?: ReactNode }) {
  const { canAny } = useAuth();
  const list = Array.isArray(permission) ? permission : [permission];
  return <>{canAny(...list) ? children : fallback}</>;
}
