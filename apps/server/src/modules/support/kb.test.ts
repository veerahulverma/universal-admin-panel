import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSession, createTestPlatform, type AdminSession, type TestPlatform } from '../../test/harness.js';
import { apiKey, apiUser, call } from '../../test/fixtures.js';
import { sql } from '../../core/sql.js';
import { sanitizeHtml, htmlToPlainText } from './html.js';
import { suggestionQuery } from './kb.js';

let t: TestPlatform;
let admin: AdminSession;
let key: string;

beforeEach(async () => {
  t = await createTestPlatform();
  t.clock.set('2026-03-02T10:00:00Z');
  admin = await adminSession(t);
  key = await apiKey(t, admin);
});
afterEach(async () => {
  await t.close();
});

async function session(userId: string, orgId?: string): Promise<string> {
  const res = await t.request({ method: 'POST', url: '/api/v1/customer-sessions', bearer: key, body: { userId, orgId } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
}

async function article(body: Record<string, unknown>) {
  const res = await t.request({ method: 'POST', url: '/api/admin/support/kb/articles', as: admin, body: { status: 'published', body: '<p>Body</p>', ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function product(keyName: string, kind = 'plan') {
  return call(t, admin, 'POST', '/api/admin/products', { key: keyName, name: keyName.toUpperCase(), kind, planType: 'paid' });
}

const titles = (res: { body: { data: { title: string }[] } }) => res.body.data.map((a) => a.title).sort();

describe('sanitizing article HTML', () => {
  it('keeps formatting and safe links, and drops scripts, handlers, styles and unsafe URLs', () => {
    const dirty = [
      '<h2 onclick="steal()">Setup</h2><p style="position:fixed">Read <a href="https://docs.example.com/x?a=1&b=2" target="_blank" onmouseover="x()">the docs</a>.</p>',
      '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test"></iframe>',
      '<a href="javascript:alert(1)">js</a><a href="  JaVa&#x09;ScRiPt&colon;alert(2)">obfuscated</a><a href="data:text/html,<b>x</b>">data</a>',
      '<img src="https://cdn.example.com/a.png" onerror="alert(3)" alt="Shot"><img src="data:image/png;base64,AAAA">',
      '<svg><g><script>alert(4)</script></g></svg><form action="/x"><input name="q">Keep me</form>',
      '<scr<script>ipt>alert(5)</script> 1 < 2 &amp; &copy; &bogus; <!-- note --><b>bold<i>nested</b>',
    ].join('');
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain('<h2>Setup</h2>');
    expect(clean).toContain('<a href="https://docs.example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">the docs</a>');
    expect(clean).toContain('<img src="https://cdn.example.com/a.png" alt="Shot">');
    expect(clean).toContain('<a>js</a><a>obfuscated</a><a>data</a>');
    expect(clean).toContain('Keep me');
    expect(clean).toContain('1 &lt; 2 &amp; © &amp;bogus;');
    expect(clean).toContain('<b>bold<i>nested</i></b>');
    for (const bad of ['<script', 'onclick', 'onerror', 'onmouseover', 'style', 'iframe', 'javascript', 'data:', '<svg', '<form', '<input', 'alert(1)', 'alert(4)', '<!--']) {
      expect(clean.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    expect(sanitizeHtml(clean)).toBe(clean);
    expect(htmlToPlainText('<p>One</p><ul><li>Two</li><li>Three &amp; four</li></ul>')).toBe('One\nTwo\nThree & four');
  });

  it('treats tag names like "constructor" as unknown tags instead of crashing', () => {
    expect(sanitizeHtml('<constructor title="x" onclick="y()">kept</constructor><p>after</p>')).toBe('kept<p>after</p>');
  });

  it('builds OR queries from the words of a ticket subject', () => {
    expect(suggestionQuery("Can't export my invoices (CSV)!")).toBe('can | export | invoices | csv');
    expect(suggestionQuery('a b ?')).toBeNull();
  });
});

describe('knowledge base', () => {
  it('shows each audience only the articles meant for it', async () => {
    const billing = await call(t, admin, 'POST', '/api/admin/support/kb/categories', { name: 'Billing & invoices' });
    expect(billing.slug).toBe('billing-invoices');
    const pro = await product('pro');
    const team = await product('team');
    await article({ title: 'Exporting invoices to CSV', categoryId: billing.id, body: '<p>Open Billing, choose <b>Export</b> and pick CSV.</p>', tags: ['export'] });
    await article({ title: 'Changing your password', visibility: 'customers' });
    await article({ title: 'Pro API limits', visibility: 'products', productIds: [pro.id] });
    await article({ title: 'Team SSO setup', visibility: 'products', productIds: [team.id] });
    await article({ title: 'Upcoming roadmap', status: 'draft' });
    const restricted = await t.app.db.one<{ slug: string }>(sql`SELECT slug FROM kb_articles WHERE title = 'Changing your password'`);

    // Anonymous readers: public, published only, and restricted articles look missing.
    const pub = await t.request({ url: '/api/public/kb/articles' });
    expect(titles(pub)).toEqual(['Exporting invoices to CSV']);
    expect(pub.body.data[0]).toMatchObject({ category: { slug: 'billing-invoices', name: 'Billing & invoices' }, helpful: { yes: 0, no: 0 } });
    expect(pub.body.data[0].body).toBeUndefined();
    expect(JSON.stringify(pub.body)).not.toContain(pro.id);
    expect((await t.request({ url: `/api/public/kb/articles/${restricted.slug}` })).status).toBe(404);
    expect((await t.request({ url: '/api/public/kb/articles/upcoming-roadmap' })).status).toBe(404);
    expect((await t.request({ url: '/api/public/kb/categories' })).body.data).toEqual([expect.objectContaining({ slug: 'billing-invoices', articles: 1 })]);

    // Signed-in customers see customer articles, and product articles only for products they have.
    const plain = await apiUser(t, key, 'plain@example.com');
    const plainSession = await session(plain.id);
    expect(titles(await t.request({ url: '/api/client/kb/articles', bearer: plainSession }))).toEqual(['Changing your password', 'Exporting invoices to CSV']);
    expect((await t.request({ url: '/api/client/kb/articles/pro-api-limits', bearer: plainSession })).status).toBe(404);

    const buyer = await apiUser(t, key, 'buyer@example.com');
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { userId: buyer.id, productId: pro.id, reason: 'test purchase' });
    const buyerSession = await session(buyer.id);
    expect(titles(await t.request({ url: '/api/client/kb/articles', bearer: buyerSession }))).toEqual(['Changing your password', 'Exporting invoices to CSV', 'Pro API limits']);
    const read = await t.request({ url: '/api/client/kb/articles/pro-api-limits', bearer: buyerSession });
    expect(read.status).toBe(200);
    expect(read.body.body).toBe('<p>Body</p>');

    // Products held by an organization count for its members.
    const org = await call(t, admin, 'POST', '/api/admin/organizations', { name: 'Acme' });
    const member = await apiUser(t, key, 'member@acme.test');
    await call(t, admin, 'POST', `/api/admin/organizations/${org.id}/members`, { userId: member.id });
    await call(t, admin, 'POST', '/api/admin/entitlement-grants', { orgId: org.id, productId: team.id, reason: 'team deal' });
    expect(titles(await t.request({ url: '/api/client/kb/articles', bearer: await session(member.id) }))).toContain('Team SSO setup');

    // Access ends with the grant.
    const grant = await t.app.db.one<{ id: string }>(sql`SELECT id FROM entitlement_grants WHERE subject_id = ${buyer.id}`);
    await call(t, admin, 'POST', `/api/admin/entitlement-grants/${grant.id}/revoke`, {});
    expect((await t.request({ url: '/api/client/kb/articles/pro-api-limits', bearer: buyerSession })).status).toBe(404);

    // Staff see drafts.
    const all = await call(t, admin, 'GET', '/api/admin/support/kb/articles?pageSize=50');
    expect(all.total).toBe(5);
    expect((await call(t, admin, 'GET', '/api/admin/support/kb/articles?status=draft')).data.map((a: any) => a.title)).toEqual(['Upcoming roadmap']);
  });

  it('searches with stemming and suggests articles for a ticket subject', async () => {
    await article({ title: 'Exporting invoices to CSV', body: '<p>Use the export button on the billing page.</p>' });
    await article({ title: 'Reset two-factor authentication', body: '<p>Lost your phone? Use a recovery code.</p>', tags: ['2fa', 'security'] });
    await article({ title: 'Paying by bank transfer', body: '<p>Invoices can be paid by wire transfer.</p>' });
    await article({ title: 'Members only: invoice disputes', visibility: 'customers', body: '<p>How to dispute an invoice.</p>' });

    const search = await t.request({ url: '/api/public/kb/articles', query: { q: 'export invoice' } });
    expect(search.body.data.map((a: any) => a.title)).toEqual(['Exporting invoices to CSV']);
    const byBody = await t.request({ url: '/api/public/kb/articles', query: { q: 'recovery code' } });
    expect(byBody.body.data.map((a: any) => a.title)).toEqual(['Reset two-factor authentication']);
    const byTag = await t.request({ url: '/api/public/kb/articles', query: { tag: '2fa' } });
    expect(byTag.body.total).toBe(1);

    const suggestions = await t.request({ url: '/api/public/kb/suggestions', query: { subject: 'I cannot export my invoices' } });
    expect(suggestions.body.data[0].title).toBe('Exporting invoices to CSV');
    expect(suggestions.body.data.map((a: any) => a.title)).toContain('Paying by bank transfer');
    expect(suggestions.body.data.map((a: any) => a.title)).not.toContain('Members only: invoice disputes');

    const user = await apiUser(t, key, 'reader@example.com');
    const client = await t.request({ url: '/api/client/kb/suggestions', bearer: await session(user.id), query: { subject: 'Dispute an invoice' } });
    expect(client.body.data[0].title).toBe('Members only: invoice disputes');
    expect((await t.request({ url: '/api/public/kb/suggestions', query: { subject: 'zzzz qqqq' } })).body.data).toEqual([]);

    await call(t, admin, 'PATCH', '/api/admin/settings/support', { kbArticleUrl: 'https://help.example.com/articles/{slug}' });
    const agent = await call(t, admin, 'GET', '/api/admin/support/kb/suggestions?subject=two-factor%20phone%20lost');
    expect(agent.data[0]).toMatchObject({ title: 'Reset two-factor authentication', url: 'https://help.example.com/articles/reset-two-factor-authentication' });
  });

  it('sanitizes on save, keeps slugs stable, counts views and records one vote per reader', async () => {
    const created = await article({ title: 'Webhooks', body: '<p>Sign <script>alert(1)</script>every request.</p>', status: 'draft' });
    expect(created).toMatchObject({ slug: 'webhooks', body: '<p>Sign every request.</p>', excerpt: 'Sign every request.', excerpt_generated: true });
    const dup = await article({ title: 'Webhooks', status: 'draft' });
    expect(dup.slug).toBe('webhooks-2');
    expect((await t.request({ method: 'PATCH', url: `/api/admin/support/kb/articles/${dup.id}`, as: admin, body: { slug: 'webhooks' } })).status).toBe(409);

    const edited = await call(t, admin, 'PATCH', `/api/admin/support/kb/articles/${created.id}`, { title: 'Signed webhooks', body: '<p>Verify the signature header.</p>', status: 'published' });
    expect(edited).toMatchObject({ slug: 'webhooks', excerpt: 'Verify the signature header.', status: 'published' });
    expect(edited.published_at).not.toBeNull();
    const events = (await t.app.db.many<{ type: string }>(sql`SELECT type FROM events WHERE type LIKE 'kb.%' ORDER BY created_at, id`)).map((e) => e.type);
    expect(events).toEqual(['kb.article_published']);
    const custom = await call(t, admin, 'PATCH', `/api/admin/support/kb/articles/${created.id}`, { excerpt: 'Hand-written summary' });
    expect(custom.excerpt_generated).toBe(false);
    expect((await call(t, admin, 'PATCH', `/api/admin/support/kb/articles/${created.id}`, { body: '<p>New body.</p>' })).excerpt).toBe('Hand-written summary');

    const preview = await call(t, admin, 'POST', '/api/admin/support/kb/preview', { body: '<p onclick="x()">Hi <a href="javascript:x()">there</a></p>' });
    expect(preview).toMatchObject({ html: '<p>Hi <a>there</a></p>', text: 'Hi there' });

    for (let i = 0; i < 3; i++) await t.request({ url: '/api/public/kb/articles/webhooks' });
    const user = await apiUser(t, key, 'voter@example.com');
    const voter = await session(user.id);
    await t.request({ url: '/api/client/kb/articles/webhooks', bearer: voter });
    expect((await t.app.db.one(sql`SELECT view_count FROM kb_articles WHERE id = ${created.id}`)).view_count).toBe(4);

    const vote = (helpful: boolean, opts: { bearer?: string; ip?: string } = {}) =>
      t.request({ method: 'POST', url: `/api/${opts.bearer ? 'client' : 'public'}/kb/articles/webhooks/vote`, body: { helpful }, ...opts });
    expect((await vote(true, { bearer: voter })).body.helpful).toEqual({ yes: 1, no: 0 });
    expect((await vote(true, { bearer: voter })).body.helpful).toEqual({ yes: 1, no: 0 });
    expect((await vote(false, { bearer: voter })).body.helpful).toEqual({ yes: 0, no: 1 });
    expect((await vote(true, { ip: '198.51.100.7' })).body.helpful).toEqual({ yes: 1, no: 1 });
    expect((await vote(true, { ip: '198.51.100.7' })).body.helpful).toEqual({ yes: 1, no: 1 });
    expect((await vote(true, { ip: '198.51.100.8' })).body.helpful).toEqual({ yes: 2, no: 1 });
    const stored = await t.app.db.many<{ voter: string }>(sql`SELECT voter FROM kb_article_votes`);
    expect(stored.map((v) => v.voter).join(' ')).not.toContain('198.51.100');

    await call(t, admin, 'PATCH', `/api/admin/support/kb/articles/${created.id}`, { status: 'draft' });
    expect((await t.request({ url: '/api/public/kb/articles/webhooks' })).status).toBe(404);
    expect((await vote(true, { ip: '198.51.100.9' })).status).toBe(404);
  });

  it('validates audiences and enforces knowledge base permissions', async () => {
    const missing = await t.request({ method: 'POST', url: '/api/admin/support/kb/articles', as: admin, body: { title: 'Gated', visibility: 'products' } });
    expect(missing.status).toBe(422);
    const unknown = await t.request({ method: 'POST', url: '/api/admin/support/kb/articles', as: admin, body: { title: 'Gated', visibility: 'products', productIds: ['prod_nope'] } });
    expect(unknown.status).toBe(422);
    const badCategory = await t.request({ method: 'POST', url: '/api/admin/support/kb/articles', as: admin, body: { title: 'X', categoryId: 'kbc_nope' } });
    expect(badCategory.status).toBe(422);

    const draft = await article({ title: 'Internal draft', status: 'draft' });
    const agent = await adminSession(t, ['support']);
    expect((await t.request({ method: 'PATCH', url: `/api/admin/support/kb/articles/${draft.id}`, as: agent, body: { status: 'published' } })).status).toBe(200);
    const analyst = await adminSession(t, ['analyst']);
    expect((await t.request({ url: '/api/admin/support/kb/articles', as: analyst })).status).toBe(200);
    expect((await t.request({ method: 'POST', url: '/api/admin/support/kb/articles', as: analyst, body: { title: 'Nope' } })).status).toBe(403);
    expect((await t.request({ method: 'DELETE', url: `/api/admin/support/kb/articles/${draft.id}`, as: analyst })).status).toBe(403);
    const billing = await adminSession(t, ['billing_manager']);
    expect((await t.request({ url: '/api/admin/support/kb/articles', as: billing })).status).toBe(403);
    expect((await t.request({ url: '/api/client/kb/articles' })).status).toBe(401);

    await call(t, admin, 'DELETE', `/api/admin/support/kb/articles/${draft.id}`);
    const audit = await t.app.db.many<{ action: string }>(sql`SELECT action FROM audit_logs WHERE action LIKE 'kb_article.%' ORDER BY seq`);
    expect(audit.map((a) => a.action)).toEqual(['kb_article.create', 'kb_article.update', 'kb_article.delete']);
  });
});
