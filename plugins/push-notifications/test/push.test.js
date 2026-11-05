import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createMockContext } from '@steward/plugin-sdk';
import { activate } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));

/** Activate with exactly the declared permissions and scripted HTTP responses (no network). */
async function setup({ settings = {}, secrets = {}, responses = [] } = {}) {
  const calls = [];
  const ctx = createMockContext({
    id: manifest.id,
    permissions: manifest.permissions,
    settings,
    secrets,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const r = responses.shift() ?? { status: 500, body: { error: 'unexpected request' } };
      return { status: r.status ?? 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body ?? {}) };
    },
  });
  await activate(ctx);
  const provider = (key) => ctx.registered.push.find((p) => p.key === key);
  return { ctx, calls, provider };
}

const message = (recipients) => ({ notificationId: 'ntf_1', type: 'admin.message', title: 'Hello', body: 'Your report is ready', link: 'https://app.example.com/reports', severity: 'info', recipients });

test('registers OneSignal (by customer) and Firebase (by device) providers', async () => {
  const { ctx } = await setup();
  assert.deepEqual(ctx.registered.push.map((p) => [p.key, p.targets]), [['onesignal', 'users'], ['firebase', 'devices']]);
});

test('OneSignal reports itself unconfigured until both the app id and the API key are set', async () => {
  const { provider } = await setup({ settings: { onesignalAppId: 'app-1' } });
  assert.equal((await provider('onesignal').status()).configured, false);
  const ready = await setup({ settings: { onesignalAppId: 'app-1' }, secrets: { onesignal_api_key: 'os_v2_app_key' } });
  assert.deepEqual(await ready.provider('onesignal').status(), { configured: true, message: 'App app-1, customers identified by their Steward user id' });
});

test('OneSignal sends one request for the customers, by Steward user id, with the right key scheme', async () => {
  const { provider, calls } = await setup({
    settings: { onesignalAppId: 'app-1' },
    secrets: { onesignal_api_key: 'os_v2_app_key' },
    responses: [{ status: 200, body: { id: 'os-msg-1', errors: { invalid_aliases: { external_id: ['usr_2'] } } } }],
  });
  const out = await provider('onesignal').send(message([{ userId: 'usr_1', externalId: null, devices: [] }, { userId: 'usr_2', externalId: null, devices: [] }]));
  assert.equal(calls[0].url, 'https://api.onesignal.com/notifications?c=push');
  assert.equal(calls[0].init.headers.authorization, 'Key os_v2_app_key');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.include_aliases, { external_id: ['usr_1', 'usr_2'] });
  assert.deepEqual([body.app_id, body.headings.en, body.contents.en, body.url], ['app-1', 'Hello', 'Your report is ready', 'https://app.example.com/reports']);
  assert.deepEqual(out.results, [
    { userId: 'usr_1', status: 'sent', providerMessageId: 'os-msg-1' },
    { userId: 'usr_2', status: 'skipped', error: 'No subscribed device in OneSignal' },
  ]);
});

test('OneSignal can identify customers by your own user id, skips customers without one, and retries outages', async () => {
  const { provider, calls } = await setup({
    settings: { onesignalAppId: 'app-1', onesignalIdentity: 'external_id' },
    secrets: { onesignal_api_key: 'legacy-rest-key' },
    responses: [{ status: 200, body: { id: '', errors: ['All included players are not subscribed'] } }, { status: 503 }],
  });
  const out = await provider('onesignal').send(message([{ userId: 'usr_1', externalId: 'cust-42', devices: [] }, { userId: 'usr_2', externalId: null, devices: [] }]));
  assert.equal(calls[0].init.headers.authorization, 'Basic legacy-rest-key');
  assert.deepEqual(JSON.parse(calls[0].init.body).include_aliases.external_id, ['cust-42']);
  assert.deepEqual(out.results.map((r) => r.status), ['skipped', 'skipped']);
  await assert.rejects(provider('onesignal').send(message([{ userId: 'usr_1', externalId: 'cust-42', devices: [] }])), /503/);
});

test('Firebase signs in with the service account, sends to each device, and reports invalid tokens', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { type: 'service_account', project_id: 'acme-app', client_email: 'push@acme-app.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const { provider, calls } = await setup({
    secrets: { firebase_service_account: JSON.stringify(account) },
    responses: [
      { status: 200, body: { access_token: 'ya29.token', expires_in: 3599 } },
      { status: 200, body: { name: 'projects/acme-app/messages/1' } },
      { status: 404, body: { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } } },
      { status: 200, body: { name: 'projects/acme-app/messages/2' } },
    ],
  });
  assert.deepEqual(await provider('firebase').status(), { configured: true, message: 'Project acme-app' });
  const devices = [{ id: 'pdev_1', token: 'token-1', platform: 'android' }, { id: 'pdev_2', token: 'token-2', platform: 'ios' }];
  const out = await provider('firebase').send(message([{ userId: 'usr_1', externalId: null, devices }]));

  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const [header, claims, signature] = assertion.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { ...JSON.parse(Buffer.from(claims, 'base64url')), iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/acme-app/messages:send');
  assert.equal(calls[1].init.headers.authorization, 'Bearer ya29.token');
  assert.deepEqual(JSON.parse(calls[1].init.body).message.notification, { title: 'Hello', body: 'Your report is ready' });
  assert.deepEqual(out.results, [{ userId: 'usr_1', status: 'sent', error: null, providerMessageId: 'projects/acme-app/messages/1', invalidDeviceIds: ['pdev_2'] }]);

  // The access token is reused for the next send.
  await provider('firebase').send(message([{ userId: 'usr_1', externalId: null, devices: [devices[0]] }]));
  assert.equal(calls.filter((c) => c.url === 'https://oauth2.googleapis.com/token').length, 1);
});

test('Firebase refuses a malformed credential and retries an outage only before anything was sent', async () => {
  const bad = await setup({ secrets: { firebase_service_account: '{"project_id":"x"}' } });
  assert.equal((await bad.provider('firebase').status()).configured, false);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { project_id: 'acme-app', client_email: 'push@acme-app.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const { provider } = await setup({
    secrets: { firebase_service_account: JSON.stringify(account) },
    responses: [{ status: 200, body: { access_token: 'ya29.token', expires_in: 3599 } }, { status: 503, body: { error: { status: 'UNAVAILABLE', message: 'Try again' } } }],
  });
  await assert.rejects(provider('firebase').send(message([{ userId: 'usr_1', externalId: null, devices: [{ id: 'pdev_1', token: 't', platform: 'web' }] }])), /503/);
});
