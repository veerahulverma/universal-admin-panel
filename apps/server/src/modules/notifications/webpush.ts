import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** 32-byte private scalar, base64url. */
  privateKey: string;
}

function pad32(buf: Buffer): Buffer {
  return buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
}

/**
 * VAPID (RFC 8292): an ES256 JWT scoped to the push service origin, valid for
 * at most 24 hours, plus our public key.
 */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowSec: number, ttlSec = 12 * 3600): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: nowSec + Math.min(ttlSec, 24 * 3600), sub: subject })));
  const unsigned = `${header}.${payload}`;
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${keys.publicKey}`;
}

interface DerivedKeys {
  cek: Buffer;
  nonce: Buffer;
}

/** RFC 8291 section 3.3/3.4: combine the ECDH secret with the auth secret, then derive CEK and nonce (RFC 8188). */
export function deriveKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): DerivedKeys & { ikm: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  return { ikm, cek, nonce };
}

export interface EncryptInput {
  /** Subscription p256dh key (uncompressed point). */
  uaPublic: Buffer;
  /** Subscription auth secret (16 bytes). */
  authSecret: Buffer;
  plaintext: Buffer;
  /** Fixed ephemeral key and salt; only for deterministic tests. */
  asPrivate?: Buffer;
  salt?: Buffer;
  recordSize?: number;
}

/** Encrypt a push message body as a single aes128gcm record (RFC 8291 + RFC 8188). */
export function encryptPayload(input: EncryptInput): Buffer {
  if (input.uaPublic.length !== 65 || input.uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (input.authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  const ecdh = createECDH('prime256v1');
  if (input.asPrivate) ecdh.setPrivateKey(input.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = input.salt ?? randomBytes(16);
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(input.uaPublic), input.authSecret, input.uaPublic, asPublic, salt);
  const rs = input.recordSize ?? 4096;
  const padded = Buffer.concat([input.plaintext, Buffer.from([2])]); // 0x02 marks the last (only) record
  if (padded.length + 16 > rs) throw new Error('Push payload is too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The receiving side of `encryptPayload` (what a browser does); used to verify our encoder. */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const { cek, nonce } = deriveKeys(ecdh.computeSecret(asPublic), authSecret, uaPublic, asPublic, salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('Invalid record padding');
  return padded.subarray(0, end);
}

export function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  try {
    const pub = fromB64u(p256dh);
    return pub.length === 65 && pub[0] === 4 && fromB64u(auth).length === 16;
  } catch {
    return false;
  }
}

/** Push endpoints must belong to a known browser push service (prevents using us as an SSRF proxy). */
export function endpointAllowed(endpoint: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return hosts.some((h) => (h.startsWith('*.') ? url.hostname.endsWith(h.slice(1)) : url.hostname === h));
  } catch {
    return false;
  }
}

export const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.services.mozilla.com',
  '*.notify.windows.com',
  'web.push.apple.com',
  '*.push.apple.com',
];
