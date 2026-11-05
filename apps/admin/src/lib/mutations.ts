import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError, errorMessage } from './api';
import { useToast } from '../components/ui/feedback';

interface ActionOptions<V, R> {
  /** Toast shown on success (string, or built from the result). */
  success?: string | ((result: R, vars: V) => string | null);
  /** Title of the error toast; the server's message is the description. */
  error?: string;
  /** Query keys refreshed after success. */
  invalidate?: QueryKey[];
  onSuccess?: (result: R, vars: V) => void;
  onError?: (err: unknown) => void;
}

/**
 * A server action with consistent feedback: success/error toasts and cache
 * invalidation. A cancelled re-authentication is reported quietly.
 */
export function useAction<V = void, R = unknown>(fn: (vars: V) => Promise<R>, opts: ActionOptions<V, R> = {}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation<R, unknown, V>({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all((opts.invalidate ?? []).map((queryKey) => client.invalidateQueries({ queryKey })));
      const message = typeof opts.success === 'function' ? opts.success(result, vars) : opts.success;
      if (message) toast.success(message);
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'reauth_required') toast.info('Cancelled', 'Confirm your identity to continue.');
      else toast.error(opts.error ?? 'That did not work', errorMessage(err));
      opts.onError?.(err);
    },
  });
}
