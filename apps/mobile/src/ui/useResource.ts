import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { AdminApi, Page } from '../lib/api';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Load a resource with the signed-in API client; supports pull-to-refresh. */
export function useResource<T>(loader: (api: AdminApi) => Promise<T>, deps: unknown[]) {
  const { api } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(
    async (mode: 'load' | 'refresh') => {
      if (mode === 'refresh') setRefreshing(true);
      try {
        setData(await loaderRef.current(api));
        setError(null);
      } catch (err) {
        setError(message(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, ...deps],
  );

  useEffect(() => {
    setLoading(true);
    void run('load');
  }, [run]);

  return { data, error, loading, refreshing, refresh: () => run('refresh'), setData };
}

/** Infinite list over a paginated admin endpoint. */
export function usePaged<T>(loader: (api: AdminApi, page: number) => Promise<Page<T>>, deps: unknown[]) {
  const { api } = useAuth();
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(
    async (target: number, mode: 'load' | 'refresh' | 'more') => {
      const gen = mode === 'more' ? generation.current : ++generation.current;
      if (mode === 'refresh') setRefreshing(true);
      if (mode === 'more') setLoadingMore(true);
      try {
        const res = await loaderRef.current(api, target);
        if (gen !== generation.current) return; // a newer search replaced this one
        setItems((prev) => (target === 1 ? res.data : [...prev, ...res.data]));
        setTotal(res.total);
        setPage(target);
        setError(null);
      } catch (err) {
        if (gen === generation.current) setError(message(err));
      } finally {
        if (gen === generation.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, ...deps],
  );

  useEffect(() => {
    setLoading(true);
    void load(1, 'load');
  }, [load]);

  const hasMore = items.length < total;
  return {
    items,
    total,
    error,
    loading,
    refreshing,
    loadingMore,
    hasMore,
    refresh: () => load(1, 'refresh'),
    loadMore: () => {
      if (hasMore && !loadingMore && !loading) void load(page + 1, 'more');
    },
    replace: (fn: (items: T[]) => T[]) => setItems(fn),
  };
}
