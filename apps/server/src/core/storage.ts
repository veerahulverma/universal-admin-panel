import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
}

/**
 * Object storage abstraction. Keys are always namespaced by the caller
 * (e.g. `org/<id>/tickets/...`) and files are only ever served through
 * authorized routes, never from a public directory.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Storage key escapes root');
    return full;
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return { key, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

/** In-memory storage for tests. */
export class MemoryStorage implements Storage {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<StoredObject> {
    this.objects.set(key, data);
    return { key, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
