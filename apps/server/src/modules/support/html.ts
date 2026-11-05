import { escapeHtml } from '../../core/template.js';

/**
 * Allowlist sanitizer for knowledge base articles. Authors write HTML in the
 * console and customers' apps render it, so only formatting tags and a few
 * attributes survive: scripts, styles, event handlers, frames, forms and
 * javascript:/data: URLs are dropped. The output is re-serialized (tags
 * balanced, attributes quoted and escaped, text re-escaped), so what is stored
 * is always well formed and an entity the decoder does not know stays literal
 * text instead of turning into markup.
 */

const VOID = new Set(['br', 'hr', 'img']);

/** Allowed tags and, for each, the attributes it may keep. */
const ALLOWED: Record<string, readonly string[]> = {
  a: ['href', 'title', 'target'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  abbr: ['title'],
  ol: ['start'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  ...Object.fromEntries(
    [
      'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
      'code', 'kbd', 'pre', 'blockquote', 'ul', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'figure',
      'figcaption', 'div', 'span', 'details', 'summary',
    ].map((tag) => [tag, [] as readonly string[]]),
  ),
};

/** Elements removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes', 'template',
  'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math', 'select', 'head',
]);

/** Elements whose content the browser does not parse as markup. */
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'noscript', 'noembed', 'noframes', 'textarea', 'title', 'xmp', 'plaintext']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°',
  plusmn: '±', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  check: '✓', le: '≤', ge: '≥', ne: '≠', colon: ':', tab: '\t', newline: '\n',
};

/** Decode character references. Unknown named references are left as they are (and escaped on output). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});?/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** http(s), mailto and relative URLs only; anything with another scheme (javascript:, data:, vbscript:...) is refused. */
function safeUrl(value: string, attr: 'href' | 'src'): string | null {
  const url = value.trim();
  if (!url) return null;
  // Browsers ignore control characters and whitespace inside the scheme, so the check does too.
  const probe = url.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)?.[1];
  if (!scheme) return url;
  const allowed = attr === 'href' ? ['http', 'https', 'mailto'] : ['http', 'https'];
  return allowed.includes(scheme) ? url : null;
}

function cleanAttribute(name: string, raw: string): string | null {
  const value = decodeEntities(raw);
  switch (name) {
    case 'href':
    case 'src':
      return safeUrl(value, name);
    case 'target':
      return value === '_blank' ? '_blank' : null;
    case 'width':
    case 'height':
    case 'colspan':
    case 'rowspan':
    case 'start':
      return /^\d{1,4}$/.test(value.trim()) ? value.trim() : null;
    case 'scope':
      return ['row', 'col', 'rowgroup', 'colgroup'].includes(value) ? value : null;
    default:
      return value.length <= 500 ? value : null;
  }
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: [string, string][];
  end: number;
}

/** Parse the tag starting at `start` (input[start] === '<'); null when it is not a tag (a literal "<"). */
function readTag(input: string, start: number): Tag | null {
  const closing = input[start + 1] === '/';
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(input.slice(start + (closing ? 2 : 1), start + (closing ? 2 : 1) + 64));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  let i = start + (closing ? 2 : 1) + nameMatch[0].length;
  const attrs: [string, string][] = [];
  while (i < input.length) {
    const ch = input[i];
    if (ch === '>') return { name, closing, attrs, end: i + 1 };
    if (/[\s/]/.test(ch)) {
      i++;
      continue;
    }
    const attrName = /^[^\s"'>/=]+/.exec(input.slice(i, i + 256))?.[0];
    if (!attrName) {
      i++;
      continue;
    }
    i += attrName.length;
    while (/\s/.test(input[i] ?? '')) i++;
    let value = '';
    if (input[i] === '=') {
      i++;
      while (/\s/.test(input[i] ?? '')) i++;
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, i + 1);
        if (close === -1) return { name, closing, attrs: [], end: input.length };
        value = input.slice(i + 1, close);
        i = close + 1;
      } else {
        const unquoted = /^[^\s>]*/.exec(input.slice(i))![0];
        value = unquoted;
        i += unquoted.length;
      }
    }
    attrs.push([attrName.toLowerCase(), value]);
  }
  return { name, closing, attrs, end: input.length };
}

/** Index just past the end of a dropped element (its matching close tag), or the end of the input. */
function skipElement(input: string, tag: Tag): number {
  const lower = input.toLowerCase();
  if (RAW_TEXT.has(tag.name)) {
    const close = lower.indexOf(`</${tag.name}`, tag.end);
    if (close === -1) return input.length;
    const gt = input.indexOf('>', close);
    return gt === -1 ? input.length : gt + 1;
  }
  let depth = 1;
  let i = tag.end;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) return input.length;
    const inner = readTag(input, lt);
    if (!inner) {
      i = lt + 1;
      continue;
    }
    if (inner.name === tag.name) depth += inner.closing ? -1 : 1;
    if (depth === 0) return inner.end;
    i = inner.end;
  }
  return input.length;
}

export function sanitizeHtml(input: string): string {
  let out = '';
  const open: string[] = [];
  let i = 0;
  const text = (s: string) => {
    out += escapeHtml(decodeEntities(s));
  };
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      text(input.slice(i));
      break;
    }
    if (lt > i) text(input.slice(i, lt));
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const end = input.indexOf('>', lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    const tag = readTag(input, lt);
    if (!tag) {
      text('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (DROP_WITH_CONTENT.has(tag.name)) {
      if (!tag.closing) i = skipElement(input, tag);
      continue;
    }
    // Own properties only: a tag named "constructor" must not find Object.prototype.
    const allowed = Object.hasOwn(ALLOWED, tag.name) ? ALLOWED[tag.name] : undefined;
    if (!allowed) continue; // unknown tag: drop the tag, keep its text
    if (tag.closing) {
      const at = open.lastIndexOf(tag.name);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    let attrs = '';
    const seen = new Set<string>();
    for (const [name, raw] of tag.attrs) {
      if (!allowed.includes(name) || seen.has(name)) continue;
      const value = cleanAttribute(name, raw);
      if (value === null) continue;
      seen.add(name);
      attrs += ` ${name}="${escapeHtml(value)}"`;
    }
    if (tag.name === 'a' && seen.has('target')) attrs += ' rel="noopener noreferrer"';
    if (tag.name === 'img' && !seen.has('src')) continue;
    out += `<${tag.name}${attrs}>`;
    if (!VOID.has(tag.name)) open.push(tag.name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

const BLOCK_END = /<\/(p|div|h[1-6]|li|dt|dd|tr|blockquote|pre|figure|figcaption|table|ul|ol|dl|details|summary|caption)>|<(br|hr)>/gi;

/** Plain text of sanitized HTML (for search, excerpts and suggestions). */
export function htmlToPlainText(html: string): string {
  return decodeEntities(html.replace(BLOCK_END, '\n').replace(/<\/?(td|th)>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first sentences of a text, cut at a word boundary. */
export function excerptOf(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,.;:!?-]+$/, '')}…`;
}
