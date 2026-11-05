import { sql } from './sql.js';
import type { Db } from './db.js';
import type { App } from './types.js';
import { newId } from './ids.js';

export interface SecretInfo {
  name: string;
  last4: string | null;
  keyId: string;
  updatedAt: Date;
}

/**
 * Encrypted credential storage (gateway keys, SMTP passwords, webhook signing
 * secrets). Values are AES-256-GCM encrypted with the owner bound as additional
 * authenticated data, so a ciphertext copied to another owner fails to decrypt.
 * Plaintext is never returned to the admin UI, only the last four characters.
 */
export class SecretStore {
  constructor(private readonly app: App) {}

  private aad(ownerType: string, ownerId: string, name: string): string {
    return `${ownerType}:${ownerId}:${name}`;
  }

  async set(db: Db, ownerType: string, ownerId: string, name: string, value: string): Promise<void> {
    const now = this.app.clock.now();
    const ciphertext = this.app.encryptor.encrypt(value, this.aad(ownerType, ownerId, name));
    const last4 = value.length >= 8 ? value.slice(-4) : null;
    await db.exec(sql`
      INSERT INTO secrets (id, owner_type, owner_id, name, ciphertext, key_id, last4, created_at, updated_at)
      VALUES (${newId('sec')}, ${ownerType}, ${ownerId}, ${name}, ${ciphertext}, ${this.app.encryptor.activeKeyId}, ${last4}, ${now}, ${now})
      ON CONFLICT (owner_type, owner_id, name) DO UPDATE
        SET ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id, last4 = EXCLUDED.last4, updated_at = EXCLUDED.updated_at
    `);
  }

  async get(db: Db, ownerType: string, ownerId: string, name: string): Promise<string | null> {
    const row = await db.maybe<{ ciphertext: string }>(
      sql`SELECT ciphertext FROM secrets WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} AND name = ${name}`,
    );
    return row ? this.app.encryptor.decrypt(row.ciphertext, this.aad(ownerType, ownerId, name)) : null;
  }

  async getAll(db: Db, ownerType: string, ownerId: string): Promise<Record<string, string>> {
    const rows = await db.many<{ name: string; ciphertext: string }>(
      sql`SELECT name, ciphertext FROM secrets WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}`,
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.name] = this.app.encryptor.decrypt(r.ciphertext, this.aad(ownerType, ownerId, r.name));
    return out;
  }

  async describe(db: Db, ownerType: string, ownerId: string): Promise<SecretInfo[]> {
    const rows = await db.many<{ name: string; last4: string | null; key_id: string; updated_at: Date }>(
      sql`SELECT name, last4, key_id, updated_at FROM secrets WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} ORDER BY name`,
    );
    return rows.map((r) => ({ name: r.name, last4: r.last4, keyId: r.key_id, updatedAt: r.updated_at }));
  }

  async delete(db: Db, ownerType: string, ownerId: string, name?: string): Promise<void> {
    await db.exec(sql`
      DELETE FROM secrets WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}
      ${name ? sql`AND name = ${name}` : sql.empty}
    `);
  }

  /** Re-encrypt every secret that is not under the active key. Returns the number rotated. */
  async rotateAll(db: Db): Promise<number> {
    const rows = await db.many<{ id: string; owner_type: string; owner_id: string; name: string; ciphertext: string }>(
      sql`SELECT id, owner_type, owner_id, name, ciphertext FROM secrets WHERE key_id <> ${this.app.encryptor.activeKeyId}`,
    );
    for (const r of rows) {
      const aad = this.aad(r.owner_type, r.owner_id, r.name);
      const plain = this.app.encryptor.decrypt(r.ciphertext, aad);
      await db.exec(sql`
        UPDATE secrets SET ciphertext = ${this.app.encryptor.encrypt(plain, aad)}, key_id = ${this.app.encryptor.activeKeyId},
          updated_at = ${this.app.clock.now()} WHERE id = ${r.id}
      `);
    }
    return rows.length;
  }
}
