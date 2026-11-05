import type { Steward } from './client.js';
import type { Subject } from './types.js';

export interface GateInput extends Subject {
  /** Feature key to require (boolean, quota or config). Omit to only check the account status. */
  feature?: string;
  /** Units the operation needs (quota features). Default 1. */
  quantity?: number;
  /** Also reject suspended, banned or deleted users (default true; uses a short cache). */
  checkAccountStatus?: boolean;
}

export interface GateDecision {
  allowed: boolean;
  /** HTTP status to answer with when denied: 401 no subject, 403 inactive/unknown, 402 upgrade needed, 429 quota used up. */
  status: 200 | 401 | 402 | 403 | 429;
  reason: 'unauthenticated' | 'account_inactive' | 'unknown_feature' | 'not_in_plan' | 'limit_exceeded' | null;
  message: string;
  feature?: string;
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
}

const ALLOW: GateDecision = { allowed: true, status: 200, reason: null, message: 'Allowed' };

/**
 * Decide whether a request may proceed. Works in any framework: call it from a
 * route handler, middleware, server action or job, and translate a denial into
 * your response (`decision.status` is a sensible HTTP status).
 */
export async function gate(steward: Steward, input: GateInput): Promise<GateDecision> {
  if (!input.userId && !input.orgId) return { allowed: false, status: 401, reason: 'unauthenticated', message: 'Sign in to continue' };
  if (input.userId && input.checkAccountStatus !== false) {
    const status = await steward.users.status(input.userId);
    if (!status.allowed) {
      return { allowed: false, status: 403, reason: 'account_inactive', message: status.reason ? `Account ${status.status}: ${status.reason}` : `Account ${status.status}` };
    }
  }
  if (!input.feature) return ALLOW;
  const check = await steward.entitlements.check({ userId: input.userId, orgId: input.orgId, feature: input.feature, quantity: input.quantity ?? 1 });
  if (check.allowed) return { ...ALLOW, feature: input.feature, limit: check.limit, remaining: check.remaining, resetsAt: check.resetsAt };
  const base = { allowed: false, feature: input.feature, limit: check.limit, remaining: check.remaining, resetsAt: check.resetsAt };
  switch (check.reason) {
    case 'limit_exceeded':
      return { ...base, status: 429, reason: 'limit_exceeded', message: `You have used your ${input.feature} quota for this period` };
    case 'not_in_plan':
      return { ...base, status: 402, reason: 'not_in_plan', message: `Upgrade your plan to use ${input.feature}` };
    default:
      return { ...base, status: 403, reason: 'unknown_feature', message: `Unknown feature ${input.feature}` };
  }
}

export type SubjectResolver<Req> = (req: Req) => Subject | null | undefined | Promise<Subject | null | undefined>;

/** Build a reusable check for one feature: `const canExport = requireFeature(steward, 'exports', (req) => ({ userId: req.user.id }))`. */
export function requireFeature<Req>(steward: Steward, feature: string, getSubject: SubjectResolver<Req>, opts: { quantity?: number; checkAccountStatus?: boolean } = {}) {
  return async (req: Req): Promise<GateDecision> => {
    const subject = (await getSubject(req)) ?? {};
    return gate(steward, { ...subject, feature, quantity: opts.quantity, checkAccountStatus: opts.checkAccountStatus });
  };
}

function denialBody(d: GateDecision) {
  return { error: { code: d.reason, message: d.message, feature: d.feature, limit: d.limit, remaining: d.remaining, resetsAt: d.resetsAt } };
}

interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/**
 * Connect/Express-style middleware: `app.post('/export', stewardMiddleware(steward, { feature: 'exports', getSubject: (req) => ({ userId: req.user?.id }) }), handler)`.
 * The decision is attached as `req.steward`.
 */
export function connectMiddleware<Req extends object>(
  steward: Steward,
  opts: { feature?: string; quantity?: number; getSubject: SubjectResolver<Req>; checkAccountStatus?: boolean },
) {
  return (req: Req, res: NodeLikeResponse, next: (err?: unknown) => void): void => {
    (async () => {
      const subject = (await opts.getSubject(req)) ?? {};
      const decision = await gate(steward, { ...subject, feature: opts.feature, quantity: opts.quantity, checkAccountStatus: opts.checkAccountStatus });
      (req as Req & { steward?: GateDecision }).steward = decision;
      if (decision.allowed) return next();
      res.statusCode = decision.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(denialBody(decision)));
    })().catch(next);
  };
}

interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  send(body: unknown): unknown;
}

/** Fastify preHandler: `{ preHandler: fastifyPreHandler(steward, { feature: 'exports', getSubject: (req) => ({ userId: req.user.id }) }) }`. */
export function fastifyPreHandler<Req>(steward: Steward, opts: { feature?: string; quantity?: number; getSubject: SubjectResolver<Req>; checkAccountStatus?: boolean }) {
  return async (request: Req, reply: FastifyLikeReply): Promise<unknown> => {
    const subject = (await opts.getSubject(request)) ?? {};
    const decision = await gate(steward, { ...subject, feature: opts.feature, quantity: opts.quantity, checkAccountStatus: opts.checkAccountStatus });
    if (!decision.allowed) return reply.code(decision.status).send(denialBody(decision));
    return undefined;
  };
}

/** Fetch-API style (Next.js route handlers, Hono, Remix): returns a Response when denied, otherwise null. */
export async function denyResponse(steward: Steward, input: GateInput): Promise<Response | null> {
  const decision = await gate(steward, input);
  if (decision.allowed) return null;
  return new Response(JSON.stringify(denialBody(decision)), { status: decision.status, headers: { 'content-type': 'application/json' } });
}
