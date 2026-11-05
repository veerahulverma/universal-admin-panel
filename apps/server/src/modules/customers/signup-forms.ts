import { z } from 'zod';
import type { Router } from '../../core/http.js';
import type { App } from '../../core/types.js';
import type { Db } from '../../core/db.js';
import { sql } from '../../core/sql.js';
import { newId } from '../../core/ids.js';
import { conflict, notFound, validationError } from '../../core/errors.js';
import { keySlug } from '../../core/validation.js';
import { diff } from '../../core/json.js';
import { checkCustomFields, loadFieldDefs, type FieldDef, type FieldIssue, type UserInput } from './service.js';
import { currentVersion, presentVersion, type AgreementVersionRow } from './agreements.js';

/**
 * Signup forms describe what a customer's app asks for at registration:
 * which profile and custom fields (and which of them are required), an
 * agreement to accept, the plans offered on the pricing step and where to
 * send the customer afterwards. The app renders the form from the public
 * route; registration (built-in identity or POST /api/v1/users) validates
 * submissions against it on the server.
 */

export const PROFILE_FIELDS = {
  name: { label: 'Full name', input: 'text' },
  phone: { label: 'Phone', input: 'tel' },
  locale: { label: 'Language', input: 'locale' },
  timezone: { label: 'Time zone', input: 'timezone' },
  country: { label: 'Country', input: 'country' },
  marketingConsent: { label: 'Send me product news and offers', input: 'checkbox' },
} as const;
type ProfileKey = keyof typeof PROFILE_FIELDS;

const formField = z.object({
  type: z.enum(['profile', 'custom']),
  key: z.string().trim().min(1).max(40),
  required: z.boolean().default(false),
  label: z.string().trim().max(100).optional(),
  helpText: z.string().trim().max(300).optional(),
});
type FormField = z.infer<typeof formField>;

const httpUrl = z
  .string()
  .trim()
  .url()
  .max(1000)
  .refine((u) => /^https?:\/\//.test(u), 'Use an http(s) URL');

export const signupFormInput = z.object({
  key: keySlug,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  active: z.boolean().default(true),
  fields: z.array(formField).max(30).default([]),
  agreementId: z.string().nullable().default(null),
  /** Plans offered on the pricing step (any active plan, including ones hidden from the public catalog). Empty: no restriction. */
  planIds: z.array(z.string()).max(50).default([]),
  redirectUrl: httpUrl.nullable().default(null),
  /** Tags given to everyone who registers through this form. */
  tags: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
});
type SignupFormInput = z.infer<typeof signupFormInput>;

export interface SignupFormRow {
  id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  fields: FormField[];
  agreement_id: string | null;
  plan_ids: string[];
  redirect_url: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

function present(f: SignupFormRow, extra: Record<string, unknown> = {}) {
  return {
    id: f.id,
    key: f.key,
    name: f.name,
    description: f.description,
    active: f.active,
    fields: f.fields,
    agreementId: f.agreement_id,
    planIds: f.plan_ids,
    redirectUrl: f.redirect_url,
    tags: f.tags,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    ...extra,
  };
}

async function catalogAvailable(app: App, db: Db): Promise<boolean> {
  if (!app.modules.get('catalog') || !app.modules.isEnabled('catalog')) return false;
  return (await db.one<{ found: boolean }>(sql`SELECT to_regclass('products') IS NOT NULL AS found`)).found;
}

/** Check a definition against the custom fields, agreements and plans that exist now. */
async function checkDefinition(db: Db, app: App, input: SignupFormInput): Promise<void> {
  const issues: FieldIssue[] = [];
  const defs = await loadFieldDefs(db, 'user');
  const seen = new Set<string>();
  input.fields.forEach((f, i) => {
    if (seen.has(f.key)) issues.push({ path: ['fields', String(i), 'key'], message: `"${f.key}" appears twice` });
    seen.add(f.key);
    if (f.type === 'profile' && !(f.key in PROFILE_FIELDS)) issues.push({ path: ['fields', String(i), 'key'], message: `Unknown profile field "${f.key}"` });
    if (f.type === 'custom' && !defs.some((d) => d.key === f.key)) issues.push({ path: ['fields', String(i), 'key'], message: `No custom field "${f.key}"` });
    if (f.type === 'profile' && f.key === 'marketingConsent' && f.required) issues.push({ path: ['fields', String(i), 'required'], message: 'Marketing consent must stay optional' });
  });
  for (const d of defs.filter((d) => d.required)) {
    if (!input.fields.some((f) => f.type === 'custom' && f.key === d.key)) {
      issues.push({ path: ['fields'], message: `${d.label} is required for every customer; add it to the form` });
    }
  }
  if (input.agreementId) {
    const agreement = await db.maybe<{ archived_at: Date | null }>(sql`SELECT archived_at FROM agreements WHERE id = ${input.agreementId}`);
    if (!agreement || agreement.archived_at) issues.push({ path: ['agreementId'], message: 'Choose an active agreement' });
  }
  if (input.planIds.length) {
    if (!(await catalogAvailable(app, db))) issues.push({ path: ['planIds'], message: 'Plans need the catalog module' });
    else {
      const plans = await db.many<{ id: string }>(sql`SELECT id FROM products WHERE id IN ${sql.in(input.planIds)} AND kind = 'plan' AND status <> 'archived'`);
      const missing = input.planIds.filter((id) => !plans.some((p) => p.id === id));
      if (missing.length) issues.push({ path: ['planIds'], message: `Not an active plan: ${missing.join(', ')}` });
    }
  }
  if (issues.length) throw validationError(issues);
}

async function loadForm(db: Db, id: string): Promise<SignupFormRow> {
  const row = await db.maybe<SignupFormRow>(sql`SELECT * FROM signup_forms WHERE id = ${id}`);
  if (!row) throw notFound('Signup form');
  return row;
}

/** Plans for the form's pricing step: the allowed plans with their active prices. */
async function formPlans(db: Db, app: App, form: SignupFormRow) {
  if (!(await catalogAvailable(app, db))) return [];
  const products = await db.many<{ id: string; key: string; name: string; description: string; plan_type: string | null; trial_days: number; highlights: unknown; sort_order: number }>(sql`
    SELECT id, key, name, description, plan_type, trial_days, highlights, sort_order FROM products
    WHERE kind = 'plan' AND status = 'active' ${form.plan_ids.length ? sql`AND id IN ${sql.in(form.plan_ids)}` : sql`AND is_public`}
    ORDER BY sort_order, name
  `);
  if (!products.length) return [];
  const prices = await db.many<{ id: string; product_id: string; currency: string; type: string; interval: string | null; interval_count: number; pricing_model: string; unit_amount: number; intro_amount: number | null; intro_cycles: number | null }>(sql`
    SELECT id, product_id, currency, type, interval, interval_count, pricing_model, unit_amount, intro_amount, intro_cycles FROM prices
    WHERE active AND product_id IN ${sql.in(products.map((p) => p.id))} ORDER BY unit_amount
  `);
  return products.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    planType: p.plan_type,
    trialDays: p.trial_days,
    highlights: p.highlights,
    prices: prices
      .filter((x) => x.product_id === p.id)
      .map((x) => ({ id: x.id, currency: x.currency, type: x.type, interval: x.interval, intervalCount: x.interval_count, pricingModel: x.pricing_model, unitAmount: x.unit_amount, introAmount: x.intro_amount, introCycles: x.intro_cycles })),
  }));
}

function publicField(f: FormField, defs: readonly FieldDef[]) {
  if (f.type === 'profile') {
    const p = PROFILE_FIELDS[f.key as ProfileKey];
    return { key: f.key, type: f.type, label: f.label || p.label, required: f.required, input: p.input, helpText: f.helpText ?? null };
  }
  const d = defs.find((x) => x.key === f.key);
  return {
    key: f.key,
    type: f.type,
    label: f.label || d?.label || f.key,
    required: f.required || Boolean(d?.required),
    input: d?.type === 'boolean' ? 'checkbox' : d?.type ?? 'text',
    options: d?.type === 'select' ? d.options : undefined,
    helpText: f.helpText ?? null,
  };
}

export interface SignupSubmission {
  formKey: string;
  /** Profile and custom field values keyed by the form's field keys. */
  values: Record<string, unknown>;
  /** Refuse values for fields that are not on the form (registration through the built-in identity). */
  strict: boolean;
  agreementVersionId?: string | null;
  /** Plan key or id chosen on the pricing step. */
  plan?: string | null;
}

export interface AppliedSignupForm {
  form: SignupFormRow;
  input: Partial<UserInput>;
  agreementVersion: AgreementVersionRow | null;
  plan: { id: string; key: string } | null;
  redirectUrl: string | null;
}

const profileValidators: Record<ProfileKey, z.ZodType> = {
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(3).max(40),
  locale: z.string().trim().min(2).max(10),
  timezone: z.string().trim().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone'),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code').transform((s) => s.toUpperCase()),
  marketingConsent: z.boolean(),
};

/**
 * Validate a registration against a signup form and turn it into user input.
 * Issues are reported per field under `fields.<key>` so apps can show them inline.
 */
export async function applySignupForm(db: Db, app: App, sub: SignupSubmission): Promise<AppliedSignupForm> {
  const form = await db.maybe<SignupFormRow>(sql`SELECT * FROM signup_forms WHERE key = ${sub.formKey}`);
  if (!form || !form.active) throw validationError([{ path: ['formKey'], message: 'Unknown or inactive signup form' }]);
  const defs = await loadFieldDefs(db, 'user');
  const issues: FieldIssue[] = [];
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const input: Partial<UserInput> = {};
  const custom: Record<string, unknown> = {};

  for (const f of form.fields) {
    const raw = sub.values[f.key];
    const label = publicField(f, defs).label;
    if (blank(raw)) {
      if (f.required) issues.push({ path: ['fields', f.key], message: `${label} is required` });
      continue;
    }
    if (f.type === 'custom') {
      custom[f.key] = raw;
      continue;
    }
    const parsed = profileValidators[f.key as ProfileKey].safeParse(raw);
    if (!parsed.success) issues.push({ path: ['fields', f.key], message: `${label}: ${parsed.error.issues[0]?.message}` });
    else (input as Record<string, unknown>)[f.key] = parsed.data;
  }
  if (sub.strict) {
    for (const key of Object.keys(sub.values)) {
      if (!form.fields.some((f) => f.key === key)) issues.push({ path: ['fields', key], message: 'This field is not part of the form' });
    }
  }
  const checked = checkCustomFields(defs, custom, { partial: false, path: ['fields'] });
  issues.push(...checked.issues.filter((i) => !issues.some((x) => x.path.join('.') === i.path.join('.'))));
  if (Object.keys(checked.values).length) input.customFields = checked.values;

  let agreementVersion: AgreementVersionRow | null = null;
  if (form.agreement_id) {
    agreementVersion = await currentVersion(db, app, form.agreement_id);
    if (!agreementVersion) throw conflict('The agreement for this form has no version in effect', 'agreement_unavailable');
    if (!sub.agreementVersionId) issues.push({ path: ['agreementVersionId'], message: `Accept "${agreementVersion.title}" to continue` });
    else if (sub.agreementVersionId !== agreementVersion.id) {
      throw conflict('The agreement changed since the form was loaded; show the current version and accept it', 'agreement_version_outdated', { currentVersionId: agreementVersion.id });
    }
  }

  let plan: AppliedSignupForm['plan'] = null;
  if (sub.plan) {
    const offered = (await formPlans(db, app, form)).find((p) => p.key === sub.plan || p.id === sub.plan);
    if (!offered) issues.push({ path: ['plan'], message: 'This plan is not offered on this form' });
    else plan = { id: offered.id, key: offered.key };
  }
  if (issues.length) throw validationError(issues);

  if (form.tags.length) input.tags = form.tags;
  input.metadata = { signupForm: form.key, ...(plan ? { signupPlan: plan.key } : {}) };
  return { form, input, agreementVersion, plan, redirectUrl: form.redirect_url };
}

/** Combine form-derived input with what the caller sent; form tags and metadata are added, never replacing. */
export function withFormInput<T extends Partial<UserInput>>(base: T, applied: AppliedSignupForm): T {
  return {
    ...base,
    ...applied.input,
    tags: [...new Set([...(base.tags ?? []), ...(applied.input.tags ?? [])])],
    customFields: { ...(base.customFields ?? {}), ...(applied.input.customFields ?? {}) },
    metadata: { ...(base.metadata ?? {}), ...(applied.input.metadata ?? {}) },
    registrationSource: base.registrationSource ?? `signup_form:${applied.form.key}`,
  };
}

export function registerSignupFormRoutes(r: Router, app: App): void {
  r.route({
    method: 'GET',
    url: '/api/admin/signup-forms',
    auth: 'admin',
    permission: 'customers.forms.view',
    summary: 'Signup forms',
    tags: ['Signup forms'],
    handler: async () => {
      const rows = await app.db.many<SignupFormRow & { signups: number; agreement_title: string | null }>(sql`
        SELECT f.*, a.title AS agreement_title,
          (SELECT count(*)::int FROM users u WHERE u.metadata->>'signupForm' = f.key AND u.deleted_at IS NULL) AS signups
        FROM signup_forms f LEFT JOIN agreements a ON a.id = f.agreement_id ORDER BY f.name
      `);
      return { data: rows.map((f) => present(f, { signups: f.signups, agreementTitle: f.agreement_title })) };
    },
  });

  r.route({
    method: 'GET',
    url: '/api/admin/signup-forms/options',
    auth: 'admin',
    permission: 'customers.forms.view',
    summary: 'Fields, agreements and plans a signup form can use',
    tags: ['Signup forms'],
    handler: async () => {
      const [defs, agreements, plans] = await Promise.all([
        loadFieldDefs(app.db, 'user'),
        app.db.many<{ id: string; key: string; title: string; required: boolean }>(sql`SELECT id, key, title, required FROM agreements WHERE archived_at IS NULL ORDER BY title`),
        (async () =>
          (await catalogAvailable(app, app.db))
            ? app.db.many<{ id: string; key: string; name: string; status: string; is_public: boolean }>(sql`
                SELECT id, key, name, status, is_public FROM products WHERE kind = 'plan' AND status <> 'archived' ORDER BY sort_order, name
              `)
            : [])(),
      ]);
      return {
        profileFields: Object.entries(PROFILE_FIELDS).map(([key, p]) => ({ key, label: p.label, input: p.input })),
        customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, required: d.required })),
        agreements,
        plans: plans.map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status, public: p.is_public })),
      };
    },
  });

  r.route({
    method: 'POST',
    url: '/api/admin/signup-forms',
    auth: 'admin',
    permission: 'customers.forms.manage',
    summary: 'Create a signup form',
    tags: ['Signup forms'],
    body: signupFormInput,
    handler: async (c) =>
      app.db.tx(async (tx) => {
        if (await tx.maybe(sql`SELECT 1 FROM signup_forms WHERE key = ${c.body.key}`)) throw conflict('A signup form with this key already exists', 'form_key_taken');
        await checkDefinition(tx, app, c.body);
        const now = app.clock.now();
        const row = await tx.one<SignupFormRow>(sql.insert('signup_forms', {
          id: newId('sfm'),
          key: c.body.key,
          name: c.body.name,
          description: c.body.description,
          active: c.body.active,
          fields: c.body.fields,
          agreement_id: c.body.agreementId,
          plan_ids: c.body.planIds,
          redirect_url: c.body.redirectUrl,
          tags: c.body.tags,
          created_by: c.admin().adminId,
          created_at: now,
          updated_at: now,
        }));
        await c.audit(tx, 'signup_form.create', { type: 'signup_form', id: row.id }, { key: row.key, fields: row.fields.length });
        return present(row);
      }),
  });

  r.route({
    method: 'GET',
    url: '/api/admin/signup-forms/:id',
    auth: 'admin',
    permission: 'customers.forms.view',
    summary: 'A signup form',
    tags: ['Signup forms'],
    params: z.object({ id: z.string() }),
    handler: async (c) => present(await loadForm(app.db, c.params.id)),
  });

  r.route({
    method: 'PATCH',
    url: '/api/admin/signup-forms/:id',
    auth: 'admin',
    permission: 'customers.forms.manage',
    summary: 'Update a signup form',
    tags: ['Signup forms'],
    params: z.object({ id: z.string() }),
    body: signupFormInput.partial(),
    handler: async (c) =>
      app.db.tx(async (tx) => {
        const before = await loadForm(tx, c.params.id);
        const next: SignupFormInput = {
          key: c.body.key ?? before.key,
          name: c.body.name ?? before.name,
          description: c.body.description ?? before.description,
          active: c.body.active ?? before.active,
          fields: c.body.fields ?? before.fields,
          agreementId: c.body.agreementId === undefined ? before.agreement_id : c.body.agreementId,
          planIds: c.body.planIds ?? before.plan_ids,
          redirectUrl: c.body.redirectUrl === undefined ? before.redirect_url : c.body.redirectUrl,
          tags: c.body.tags ?? before.tags,
        };
        if (next.key !== before.key && (await tx.maybe(sql`SELECT 1 FROM signup_forms WHERE key = ${next.key}`))) throw conflict('A signup form with this key already exists', 'form_key_taken');
        await checkDefinition(tx, app, next);
        const patch = {
          key: next.key,
          name: next.name,
          description: next.description,
          active: next.active,
          fields: next.fields,
          agreement_id: next.agreementId,
          plan_ids: next.planIds,
          redirect_url: next.redirectUrl,
          tags: next.tags,
        };
        const changes = diff(before as unknown as Record<string, unknown>, patch);
        if (!Object.keys(changes).length) return present(before);
        const row = await tx.one<SignupFormRow>(sql`UPDATE signup_forms SET ${sql.set({ ...patch, updated_at: app.clock.now() })} WHERE id = ${before.id} RETURNING *`);
        await c.audit(tx, 'signup_form.update', { type: 'signup_form', id: row.id }, { changes });
        return present(row);
      }),
  });

  r.route({
    method: 'DELETE',
    url: '/api/admin/signup-forms/:id',
    auth: 'admin',
    permission: 'customers.forms.manage',
    summary: 'Delete a signup form (customers who used it keep the form key in their metadata)',
    tags: ['Signup forms'],
    params: z.object({ id: z.string() }),
    handler: async (c) => {
      await app.db.tx(async (tx) => {
        const form = await loadForm(tx, c.params.id);
        await tx.exec(sql`DELETE FROM signup_forms WHERE id = ${form.id}`);
        await c.audit(tx, 'signup_form.delete', { type: 'signup_form', id: form.id }, { key: form.key });
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/api/public/signup-forms/:key',
    auth: 'public',
    summary: 'A signup form for your app to render: fields, the agreement to accept, plans and the redirect',
    description: 'Submit registrations with `formKey`, the field values in `fields` and the accepted `agreementVersionId` to POST /api/v1/identity/register (or with the same values to POST /api/v1/users).',
    tags: ['Signup forms'],
    rateLimit: { max: 120, windowSec: 60 },
    params: z.object({ key: z.string().max(64) }),
    handler: async (c) => {
      const form = await app.db.maybe<SignupFormRow>(sql`SELECT * FROM signup_forms WHERE key = ${c.params.key} AND active`);
      if (!form) throw notFound('Signup form');
      const defs = await loadFieldDefs(app.db, 'user');
      const agreement = form.agreement_id ? await app.db.maybe<{ id: string; key: string }>(sql`SELECT id, key FROM agreements WHERE id = ${form.agreement_id} AND archived_at IS NULL`) : null;
      const version = agreement ? await currentVersion(app.db, app, agreement.id) : null;
      return {
        key: form.key,
        name: form.name,
        description: form.description,
        fields: [{ key: 'email', type: 'profile', label: 'Email', required: true, input: 'email', helpText: null }, ...form.fields.map((f) => publicField(f, defs))],
        passwordRequired: app.modules.isEnabled('identity'),
        agreement: agreement && version ? presentVersion(agreement, version) : null,
        plans: await formPlans(app.db, app, form),
        redirectUrl: form.redirect_url,
      };
    },
  });
}
