import { createSign } from 'node:crypto';

/*
 * Push notifications through OneSignal and Firebase Cloud Messaging. Steward decides who gets a
 * notification and records the outcome; these providers only deliver. A provider that is not set up
 * reports itself as not configured, and Steward does not use it.
 */

const ONESIGNAL_URL = 'https://api.onesignal.com/notifications?c=push';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};
const b64u = (value) => Buffer.from(value).toString('base64url');

/** A rate limit or an outage: worth retrying later. */
const transient = (status) => status === 429 || status >= 500;

/** OneSignal finds customers by the external id your app set with OneSignal.login(). */
export function oneSignalProvider(ctx) {
  const config = async () => {
    const settings = (await ctx.settings.get()) ?? {};
    return {
      appId: String(settings.onesignalAppId ?? '').trim(),
      identity: settings.onesignalIdentity === 'external_id' ? 'external_id' : 'user_id',
      apiKey: (await ctx.secrets.get('onesignal_api_key')) ?? '',
    };
  };
  return {
    key: 'onesignal',
    name: 'OneSignal',
    description: 'Mobile and web push through OneSignal. Customers are found by the id your app passes to OneSignal.login().',
    targets: 'users',
    async status() {
      const c = await config();
      if (!c.appId || !c.apiKey) return { configured: false, message: 'Add the OneSignal App ID in the plugin settings and the REST API key in its credentials.' };
      return { configured: true, message: `App ${c.appId}, customers identified by ${c.identity === 'external_id' ? 'your user id' : 'their Steward user id'}` };
    },
    async send(message) {
      const c = await config();
      if (!c.appId || !c.apiKey) throw new Error('OneSignal is not configured');
      const idOf = (r) => (c.identity === 'external_id' ? r.externalId : r.userId);
      const ids = [...new Set(message.recipients.map(idOf).filter(Boolean))];
      if (!ids.length) return { results: message.recipients.map((r) => ({ userId: r.userId, status: 'skipped', error: 'The customer has no external id' })) };
      const res = await ctx.http.fetch(ONESIGNAL_URL, {
        method: 'POST',
        // App API keys (os_v2_...) use the Key scheme; older REST API keys use Basic.
        headers: { 'content-type': 'application/json', authorization: `${c.apiKey.startsWith('os_v2_') ? 'Key' : 'Basic'} ${c.apiKey}` },
        body: JSON.stringify({
          app_id: c.appId,
          target_channel: 'push',
          include_aliases: { external_id: ids },
          headings: { en: message.title },
          contents: { en: message.body || message.title },
          ...(message.link ? { url: message.link } : {}),
          data: { notificationId: message.notificationId, type: message.type },
          priority: message.severity === 'critical' ? 10 : 5,
        }),
      });
      const json = parseJson(res.body) ?? {};
      if (transient(res.status)) throw new Error(`OneSignal responded ${res.status}`);
      if (res.status >= 400) {
        const error = Array.isArray(json.errors) ? json.errors.join('; ') : `OneSignal responded ${res.status}`;
        return { results: message.recipients.map((r) => ({ userId: r.userId, status: 'failed', error })) };
      }
      // 200 without an id: nobody in the request has a subscribed device.
      const invalid = new Set(json.errors?.invalid_aliases?.external_id ?? []);
      return {
        results: message.recipients.map((r) => {
          const id = idOf(r);
          if (!id) return { userId: r.userId, status: 'skipped', error: 'The customer has no external id' };
          if (!json.id || invalid.has(id)) return { userId: r.userId, status: 'skipped', error: 'No subscribed device in OneSignal' };
          return { userId: r.userId, status: 'sent', providerMessageId: json.id };
        }),
      };
    },
  };
}

/** Firebase Cloud Messaging (HTTP v1) to the device tokens your app registered with Steward. */
export function firebaseProvider(ctx) {
  let cached = null;
  const account = async () => {
    const raw = await ctx.secrets.get('firebase_service_account');
    if (!raw) return null;
    const parsed = parseJson(raw);
    if (!parsed?.client_email || !parsed?.private_key || !parsed?.project_id) {
      throw new Error('The Firebase credential must be a service account key file (JSON with project_id, client_email and private_key)');
    }
    return parsed;
  };

  /** OAuth access token from a signed service-account assertion, reused until shortly before it expires. */
  async function accessToken(sa) {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.clientEmail === sa.client_email && cached.expiresAt - 60 > now) return cached.token;
    const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iss: sa.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await ctx.http.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    const json = parseJson(res.body);
    if (res.status !== 200 || !json?.access_token) {
      if (transient(res.status)) throw new Error(`Google sign-in responded ${res.status}`);
      throw new Error(`Google rejected the Firebase service account: ${json?.error_description ?? json?.error ?? res.status}`);
    }
    cached = { token: json.access_token, expiresAt: now + Number(json.expires_in ?? 3600), clientEmail: sa.client_email };
    return cached.token;
  }

  return {
    key: 'firebase',
    name: 'Firebase Cloud Messaging',
    description: "Push to Android, iOS and web apps through Firebase. Your app registers each install's FCM token with Steward.",
    targets: 'devices',
    async status() {
      try {
        const sa = await account();
        if (!sa) return { configured: false, message: 'Add the Firebase service account key in the plugin credentials.' };
        return { configured: true, message: `Project ${sa.project_id}` };
      } catch (err) {
        return { configured: false, message: err.message };
      }
    },
    async send(message) {
      const sa = await account();
      if (!sa) throw new Error('Firebase is not configured');
      const token = await accessToken(sa);
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
      const results = [];
      let anySent = false;
      for (const r of message.recipients) {
        let sent = 0;
        let lastError = null;
        let messageId = null;
        const invalid = [];
        for (const device of r.devices) {
          const res = await ctx.http.fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: device.token,
                notification: { title: message.title, ...(message.body ? { body: message.body } : {}) },
                data: { notificationId: message.notificationId, type: message.type, ...(message.link ? { link: message.link } : {}) },
                ...(message.severity === 'critical' ? { android: { priority: 'high' } } : {}),
                ...(message.link ? { webpush: { fcm_options: { link: message.link } } } : {}),
              },
            }),
          });
          const json = parseJson(res.body);
          if (res.status === 200) {
            sent++;
            anySent = true;
            messageId = json?.name ?? messageId;
            continue;
          }
          const code = json?.error?.details?.find?.((d) => d?.errorCode)?.errorCode ?? json?.error?.status;
          if (res.status === 404 || code === 'UNREGISTERED') {
            invalid.push(device.id);
            continue;
          }
          // Nothing delivered yet: safe to retry the whole send later.
          if (transient(res.status) && !anySent) throw new Error(`Firebase responded ${res.status}`);
          lastError = json?.error?.message ?? `Firebase responded ${res.status}`;
        }
        const allInvalid = invalid.length > 0 && invalid.length === r.devices.length;
        results.push({
          userId: r.userId,
          status: sent ? 'sent' : allInvalid ? 'skipped' : 'failed',
          error: sent ? null : allInvalid ? 'Every registered device is no longer valid' : lastError,
          providerMessageId: messageId,
          invalidDeviceIds: invalid,
        });
      }
      return { results };
    },
  };
}

export async function activate(ctx) {
  await ctx.push.register(oneSignalProvider(ctx));
  await ctx.push.register(firebaseProvider(ctx));
}
