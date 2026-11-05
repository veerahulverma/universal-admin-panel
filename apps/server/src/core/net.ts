import { BlockList, isIP } from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { AppError } from './errors.js';

/** Strip IPv4-mapped IPv6 prefixes so ::ffff:10.0.0.1 is treated as 10.0.0.1. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

function addCidr(list: BlockList, cidr: string): void {
  const [addr, prefixStr] = cidr.trim().split('/');
  const family = isIP(addr);
  if (!family) throw new Error(`Invalid IP/CIDR: ${cidr}`);
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (prefixStr === undefined) list.addAddress(addr, type);
  else list.addSubnet(addr, Number(prefixStr), type);
}

export function isValidCidr(cidr: string): boolean {
  try {
    addCidr(new BlockList(), cidr);
    return true;
  } catch {
    return false;
  }
}

/** Check whether an IP falls inside any of the given CIDRs / addresses. */
export function ipMatches(ip: string, cidrs: readonly string[]): boolean {
  if (!cidrs.length) return false;
  const addr = normalizeIp(ip);
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    try {
      addCidr(list, c);
    } catch {
      /* ignore invalid entries */
    }
  }
  return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

const PRIVATE_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

export function isPrivateAddress(ip: string): boolean {
  return ipMatches(ip, PRIVATE_RANGES);
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowPrivate?: boolean;
  maxResponseBytes?: number;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  durationMs: number;
}

/**
 * Outbound HTTP for user-supplied URLs (webhooks, plugin HTTP). Guards against
 * SSRF: only http(s), DNS is resolved up front, private/loopback/link-local
 * targets are refused, and the socket connects to the address we validated, so
 * DNS rebinding between check and connect cannot redirect the request.
 * Redirects are not followed.
 */
export async function safeRequest(rawUrl: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'invalid_url', 'Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError(400, 'invalid_url', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new AppError(400, 'invalid_url', 'Credentials in URLs are not allowed');

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length) throw new AppError(400, 'dns_failed', `Could not resolve ${hostname}`);
  if (!opts.allowPrivate) {
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked) throw new AppError(400, 'ssrf_blocked', `Refusing to connect to private address ${blocked.address}`);
  }
  const target = addresses[0];
  const lib = url.protocol === 'https:' ? https : http;
  const started = Date.now();
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;

  return new Promise<SafeResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        timeout: opts.timeoutMs ?? 10_000,
        lookup: ((_host: string, options: any, cb: any) => {
          if (options && options.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        }) as any,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: Date.now() - started,
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new AppError(504, 'timeout', 'Request timed out')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
