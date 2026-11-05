/** Error returned by the Steward API (or raised by the SDK when it cannot reach it). */
export class StewardError extends Error {
  override readonly name: string = 'StewardError';

  constructor(
    /** HTTP status; 0 for network errors and timeouts. */
    readonly status: number,
    /** Machine-readable code, e.g. `insufficient_scope`, `rate_limited`, `not_found`. */
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Network failure, DNS error or timeout before a response arrived. */
export class StewardConnectionError extends StewardError {
  override readonly name = 'StewardConnectionError';

  constructor(message: string, cause?: unknown) {
    super(0, 'connection_error', message);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** A webhook failed verification. Respond 400 and do not process it. */
export class StewardWebhookError extends Error {
  override readonly name = 'StewardWebhookError';

  constructor(
    readonly code: 'missing_signature' | 'invalid_signature' | 'timestamp_out_of_tolerance' | 'invalid_payload',
    message: string,
  ) {
    super(message);
  }
}
