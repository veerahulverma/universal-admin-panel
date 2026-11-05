import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * List-page state (filters, sort, pagination) kept in the URL so views are
 * shareable, survive reloads and work with the back button.
 */
export function useUrlState<T extends Record<string, string | number | undefined>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => {
    const out: Record<string, string | number | undefined> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const raw = params.get(key);
      if (raw === null) continue;
      out[key] = typeof defaults[key] === 'number' ? Number(raw) : raw;
    }
    for (const [k, v] of params) if (!(k in out)) out[k] = v;
    return out as T & Record<string, string | number | undefined>;
  }, [params, defaults]);

  const set = useCallback(
    (patch: Partial<Record<string, string | number | undefined | null>>, opts: { resetPage?: boolean } = { resetPage: true }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '' || v === defaults[k]) next.delete(k);
            else next.set(k, String(v));
          }
          if (opts.resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaults],
  );

  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  return [state, set, reset] as const;
}

/** Global keyboard shortcut. `combo` like "mod+k", "g d" (sequence) or "?". */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const sequence = combo.split(' ');
    let step = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const part = sequence[step];
      const mod = part.startsWith('mod+');
      const key = mod ? part.slice(4) : part;
      if (typing && !mod) return;
      const hasMod = e.metaKey || e.ctrlKey;
      if (mod !== hasMod || e.key.toLowerCase() !== key.toLowerCase()) {
        step = 0;
        return;
      }
      if (step === sequence.length - 1) {
        e.preventDefault();
        step = 0;
        ref.current(e);
      } else {
        step++;
        clearTimeout(timer);
        timer = setTimeout(() => (step = 0), 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [combo, enabled]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
