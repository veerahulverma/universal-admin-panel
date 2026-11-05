import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password with scrypt. Format: scrypt$N$r$p$salt$hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so missing accounts are not distinguishable by timing.
    await hashPassword(password);
    return false;
  }
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const N = Number(n);
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordNeedsRehash(stored: string): boolean {
  const [, n] = stored.split('$');
  return Number(n) < SCRYPT_PARAMS.N;
}

export interface PasswordPolicy {
  minLength: number;
  requireMixed: boolean;
}

export function checkPasswordPolicy(password: string, policy: PasswordPolicy): string | null {
  if (password.length < policy.minLength) return `Password must be at least ${policy.minLength} characters`;
  if (password.length > 256) return 'Password is too long';
  if (policy.requireMixed) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
    if (classes < 3) return 'Password must mix at least three of: lowercase, uppercase, digits, symbols';
  }
  return null;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const hmacSha256 = (key: string | Buffer, data: string | Buffer) =>
  createHmac('sha256', key).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * AES-256-GCM envelope with key identifiers so keys can be rotated:
 *   enc:v1:<keyId>:<iv>:<tag>:<ciphertext>   (base64url parts)
 */
export class Encryptor {
  constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKeyId: string,
  ) {
    const active = keys.get(activeKeyId);
    if (!active) throw new Error(`Active encryption key "${activeKeyId}" is not configured`);
    for (const [id, key] of keys) if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes`);
  }

  static fromSpec(spec: string, activeKeyId?: string): Encryptor {
    const keys = new Map<string, Buffer>();
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must look like "<id>:<base64 key>"');
      keys.set(part.slice(0, idx), Buffer.from(part.slice(idx + 1), 'base64'));
    }
    const ids = [...keys.keys()];
    return new Encryptor(keys, activeKeyId ?? ids[ids.length - 1]);
  }

  encrypt(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['enc', 'v1', this.activeKeyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
  }

  decrypt(payload: string, aad = ''): string {
    const [prefix, version, keyId, ivB64, tagB64, ctB64] = payload.split(':');
    if (prefix !== 'enc' || version !== 'v1') throw new Error('Unsupported ciphertext format');
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Encryption key "${keyId}" is not available`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  keyIdOf(payload: string): string {
    return payload.split(':')[2];
  }

  needsRotation(payload: string): boolean {
    return this.keyIdOf(payload) !== this.activeKeyId;
  }
}
