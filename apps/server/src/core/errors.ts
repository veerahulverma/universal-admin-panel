export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const validationError = (details: unknown, message = 'Validation failed') =>
  new AppError(422, 'validation_error', message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'forbidden') =>
  new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new AppError(409, code, message, details);
export const tooManyRequests = (message: string, retryAfterSeconds?: number) =>
  new AppError(
    429,
    'rate_limited',
    message,
    retryAfterSeconds ? { retryAfterSeconds } : undefined,
    retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : undefined,
  );
export const moduleDisabled = (moduleId: string) =>
  new AppError(403, 'module_disabled', `The "${moduleId}" module is disabled`);
export const unprocessable = (message: string, code = 'unprocessable', details?: unknown) =>
  new AppError(422, code, message, details);

export function assert(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}
