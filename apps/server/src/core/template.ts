/**
 * Small logic-light template engine for emails and notifications.
 *
 *   {{ user.name }}            HTML-escaped value
 *   {{{ trusted.html }}}       raw value (only for values the system generates)
 *   {{#if cond}}...{{else}}...{{/if}}
 *   {{#each items}}{{ this.name }}{{/each}}
 *
 * Escaping is on by default so user-controlled data (names, ticket subjects)
 * cannot inject markup into emails.
 */
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function lookup(scope: Record<string, unknown>[], path: string): unknown {
  const parts = path.trim().split('.');
  for (let i = scope.length - 1; i >= 0; i--) {
    let cur: any = scope[i];
    if (parts[0] === 'this') {
      cur = scope[i]['this'];
      parts.shift();
    } else if (!(cur && typeof cur === 'object' && parts[0] in cur)) continue;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }
  return undefined;
}

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string; raw: boolean }
  | { t: 'if'; path: string; then: Node[]; else: Node[] }
  | { t: 'each'; path: string; body: Node[] };

const TOKEN = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*(#if|#each|\/if|\/each|else)?\s*([\w.]*)\s*\}\}/g;

function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: { nodes: Node[]; node?: Node; inElse?: boolean }[] = [{ nodes: root }];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.nodes.push({ t: 'text', v: src.slice(last, m.index) });
    last = TOKEN.lastIndex;
    if (m[1]) {
      top.nodes.push({ t: 'var', path: m[1], raw: true });
      continue;
    }
    const kw = m[2];
    const arg = m[3];
    if (!kw) top.nodes.push({ t: 'var', path: arg, raw: false });
    else if (kw === '#if') {
      const node: Node = { t: 'if', path: arg, then: [], else: [] };
      top.nodes.push(node);
      stack.push({ nodes: node.then, node });
    } else if (kw === '#each') {
      const node: Node = { t: 'each', path: arg, body: [] };
      top.nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else if (kw === 'else') {
      const frame = stack[stack.length - 1];
      if (frame.node?.t !== 'if') throw new Error('{{else}} outside {{#if}}');
      frame.nodes = frame.node.else;
    } else {
      const frame = stack.pop();
      const expected = kw === '/if' ? 'if' : 'each';
      if (!frame?.node || frame.node.t !== expected) throw new Error(`Unexpected {{${kw}}}`);
    }
  }
  if (stack.length !== 1) throw new Error('Unclosed block in template');
  if (last < src.length) root.push({ t: 'text', v: src.slice(last) });
  return root;
}

function renderNodes(nodes: Node[], scope: Record<string, unknown>[], escape: boolean): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'var') {
      const v = lookup(scope, n.path);
      out += n.raw || !escape ? String(v ?? '') : escapeHtml(v);
    } else if (n.t === 'if') {
      const v = lookup(scope, n.path);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      out += renderNodes(truthy ? n.then : n.else, scope, escape);
    } else {
      const list = lookup(scope, n.path);
      if (Array.isArray(list)) {
        for (const item of list) out += renderNodes(n.body, [...scope, { this: item }], escape);
      }
    }
  }
  return out;
}

const cache = new Map<string, Node[]>();

export function renderTemplate(src: string, data: Record<string, unknown>, opts: { escape?: boolean } = {}): string {
  let nodes = cache.get(src);
  if (!nodes) {
    nodes = parse(src);
    if (cache.size > 500) cache.clear();
    cache.set(src, nodes);
  }
  return renderNodes(nodes, [data], opts.escape ?? true);
}

/** Validate template syntax; returns an error message or null. */
export function validateTemplate(src: string): string | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Variables referenced by a template (for editor hints and validation). */
export function templateVariables(src: string): string[] {
  const vars = new Set<string>();
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const name = m[1] ?? (m[2] === undefined || m[2] === '#if' || m[2] === '#each' ? m[3] : '');
    if (name && !name.startsWith('this')) vars.add(name);
  }
  return [...vars];
}
