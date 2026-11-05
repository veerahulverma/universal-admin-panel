/** Minimal semver: x.y.z versions and the range syntax plugins use (^, ~, >=, <, x, *, ||). */
export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

function comparator(token: string, v: Version): boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(token.trim());
  if (!m) throw new Error(`Invalid range token: ${token}`);
  const op = m[1] ?? '=';
  const wild = (s: string | undefined) => s === undefined || s === 'x' || s === '*';
  const maj = wild(m[2]) ? null : Number(m[2]);
  const min = wild(m[3]) ? null : Number(m[3]);
  const pat = wild(m[4]) ? null : Number(m[4]);
  const cmp = (a: Version) => v.major - a.major || v.minor - a.minor || v.patch - a.patch;
  const base: Version = { major: maj ?? 0, minor: min ?? 0, patch: pat ?? 0 };
  if (maj === null) return true;
  switch (op) {
    case '^': {
      if (cmp(base) < 0) return false;
      if (base.major > 0) return v.major === base.major;
      if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
      return v.major === 0 && v.minor === 0 && v.patch === base.patch;
    }
    case '~':
      return cmp(base) >= 0 && v.major === base.major && (min === null || v.minor === base.minor);
    case '>=':
      return cmp(base) >= 0;
    case '>':
      return cmp(base) > 0;
    case '<=':
      return cmp(base) <= 0;
    case '<':
      return cmp(base) < 0;
    default:
      return v.major === maj && (min === null || v.minor === min) && (pat === null || v.patch === pat);
  }
}

/** Does `version` satisfy `range`? Space-separated tokens are AND, `||` is OR. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((alt) =>
    alt
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean)
      .every((t) => comparator(t, v)),
  );
}

export function isValidRange(range: string): boolean {
  try {
    satisfies('1.0.0', range);
    return true;
  } catch {
    return false;
  }
}
