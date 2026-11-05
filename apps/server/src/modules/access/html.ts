/**
 * Allowlist sanitizer for members-only pages. Administrators write the HTML,
 * but it is rendered inside customers' own apps, so the output may contain only
 * known-safe elements and attributes: script, styles, frames, forms, event
 * handlers and unsafe URL schemes never survive. The output is rebuilt from
 * scratch rather than edited in place: text is escaped, attribute values are
 * re-quoted, and every element that is opened is closed, so nothing the author
 * writes can change how the surrounding page is parsed.
 */

const GLOBAL_ATTRS = ['title', 'lang', 'dir', 'class'];

/**
 * Elements kept, with the attributes each may carry (in addition to GLOBAL_ATTRS).
 * Maps, not object lookups: a tag named "constructor" must not find Object.prototype.
 */
const ELEMENTS = new Map<string, readonly string[]>(Object.entries({
  a: ['href', 'target'],
  abbr: [],
  article: [],
  aside: [],
  audio: ['src', 'controls', 'loop', 'muted', 'preload'],
  b: [],
  blockquote: ['cite'],
  br: [],
  caption: [],
  cite: [],
  code: [],
  col: ['span'],
  colgroup: ['span'],
  dd: [],
  del: [],
  details: ['open'],
  div: [],
  dl: [],
  dt: [],
  em: [],
  figcaption: [],
  figure: [],
  footer: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  header: [],
  hr: [],
  i: [],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  ins: [],
  kbd: [],
  li: ['value'],
  mark: [],
  ol: ['start', 'reversed', 'type'],
  p: [],
  pre: [],
  q: ['cite'],
  s: [],
  samp: [],
  section: [],
  small: [],
  source: ['src', 'type'],
  span: [],
  strong: [],
  sub: [],
  summary: [],
  sup: [],
  table: [],
  tbody: [],
  td: ['colspan', 'rowspan'],
  tfoot: [],
  th: ['colspan', 'rowspan', 'scope'],
  thead: [],
  time: ['datetime'],
  tr: [],
  u: [],
  ul: [],
  video: ['src', 'poster', 'controls', 'width', 'height', 'loop', 'muted', 'playsinline', 'preload'],
  wbr: [],
}));

const VOID = new Set(['br', 'col', 'hr', 'img', 'source', 'wbr']);

/** Elements whose content is raw text to the browser: skipped up to their end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

/** Elements removed together with everything inside them (void ones such as embed are simply not allowed). */
const DROP_WITH_CONTENT = new Set(['applet', 'canvas', 'datalist', 'dialog', 'frameset', 'head', 'math', 'object', 'optgroup', 'option', 'select', 'svg', 'template']);

/** Opening one of these closes an open paragraph, as browsers do. */
const CLOSES_P = new Set(['article', 'aside', 'blockquote', 'details', 'div', 'dl', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'ol', 'p', 'pre', 'section', 'table', 'ul']);

const MAX_DEPTH = 64;

const NAMED_ENTITIES = new Map<string, string>(Object.entries({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  bsol: '\\',
  lpar: '(',
  rpar: ')',
  period: '.',
  comma: ',',
  semi: ';',
  equals: '=',
  num: '#',
  quest: '?',
  excl: '!',
}));

/**
 * Decode character references in an attribute value. Whatever is not decoded
 * here stays literal, because the output escapes every "&": the browser then
 * sees exactly the string that was checked.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(ref.toLowerCase()) ?? match;
  });
}

function escapeText(text: string): string {
  // Keep well-formed character references; escape every other "&".
  return text
    .replace(/&(?!(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp);base64,[a-z0-9+/=]+$/i;

/**
 * A URL the browser will resolve to http(s), mailto, tel or a relative
 * reference. Browsers strip surrounding control characters and remove tabs and
 * newlines anywhere, so the scheme is judged after doing the same.
 */
export function safeUrl(raw: string, opts: { image?: boolean; mailto?: boolean } = {}): string | null {
  const value = decodeEntities(raw)
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
    .replace(/[\t\n\r]/g, '');
  if (!value || value.length > 4000 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return value;
  if (scheme === 'http' || scheme === 'https') return value;
  if (opts.mailto && SAFE_SCHEMES.has(scheme)) return value;
  if (opts.image && DATA_IMAGE.test(value)) return value;
  return null;
}

type AttrCheck = (value: string) => string | null;

const pattern = (re: RegExp): AttrCheck => (v) => (re.test(v) ? v : null);
const presence: AttrCheck = () => '';

const ATTR_CHECKS = new Map<string, AttrCheck>(Object.entries({
  title: (v) => v.slice(0, 500),
  alt: (v) => v.slice(0, 500),
  lang: pattern(/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/),
  dir: pattern(/^(ltr|rtl|auto)$/i),
  class: (v) => {
    const cleaned = v.split(/\s+/).filter((c) => /^[A-Za-z_-][\w-]{0,63}$/.test(c)).slice(0, 20).join(' ');
    return cleaned || null;
  },
  href: (v) => safeUrl(v, { mailto: true }),
  src: (v) => safeUrl(v),
  poster: (v) => safeUrl(v),
  cite: (v) => safeUrl(v),
  target: pattern(/^_blank$/),
  width: pattern(/^\d{1,5}%?$/),
  height: pattern(/^\d{1,5}%?$/),
  loading: pattern(/^(lazy|eager)$/),
  span: pattern(/^\d{1,3}$/),
  colspan: pattern(/^\d{1,3}$/),
  rowspan: pattern(/^\d{1,3}$/),
  start: pattern(/^-?\d{1,6}$/),
  value: pattern(/^-?\d{1,6}$/),
  type: pattern(/^([1aAiI]|[\w.+-]+\/[\w.+-]+)$/),
  scope: pattern(/^(row|col|rowgroup|colgroup)$/),
  datetime: pattern(/^[\dTZ:+.\- ]{4,40}$/),
  preload: pattern(/^(none|metadata|auto)$/),
  open: presence,
  controls: presence,
  loop: presence,
  muted: presence,
  playsinline: presence,
  reversed: presence,
}));

interface Tag {
  name: string;
  closing: boolean;
  /** Written as <name/>: foreign elements such as svg then have no content to skip. */
  selfClosing: boolean;
  attrs: { name: string; value: string }[];
  end: number;
}

/** Parse a tag starting at `start` (which points at "<"). Returns null when the input ends inside it. */
function readTag(html: string, start: number): Tag | null {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(i, i + 64));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += nameMatch[0].length;
  const attrs: Tag['attrs'] = [];
  for (;;) {
    while (i < html.length && /[\s/]/.test(html[i])) i++;
    if (i >= html.length) return null;
    if (html[i] === '>') return { name, closing, selfClosing: html[i - 1] === '/', attrs, end: i + 1 };
    const attrName = /^[^\s/>=]+|^=[^\s/>=]*/.exec(html.slice(i, i + 256));
    if (!attrName) return null;
    i += attrName[0].length;
    while (i < html.length && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const unquoted = /^[^\s>]*/.exec(html.slice(i))![0];
        value = unquoted;
        i += unquoted.length;
      }
    }
    attrs.push({ name: attrName[0].toLowerCase(), value });
  }
}

function renderAttrs(name: string, attrs: Tag['attrs']): string {
  const allowed = ELEMENTS.get(name) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of attrs) {
    if (seen.has(a.name) || (!allowed.includes(a.name) && !GLOBAL_ATTRS.includes(a.name))) continue;
    const check = name === 'img' && a.name === 'src' ? (v: string) => safeUrl(v, { image: true }) : ATTR_CHECKS.get(a.name);
    const value = check?.(a.name === 'href' || a.name === 'src' || a.name === 'poster' || a.name === 'cite' ? a.value : decodeEntities(a.value));
    if (value === null || value === undefined) continue;
    seen.add(a.name);
    out.push(value === '' && ATTR_CHECKS.get(a.name) === presence ? ` ${a.name}` : ` ${a.name}="${escapeAttr(value)}"`);
  }
  // Links that open a new tab must not hand the opener to the destination.
  if (name === 'a' && seen.has('target')) out.push(' rel="noopener noreferrer"');
  return out.join('');
}

/** Index just past the end tag of a raw-text element, or the end of input when it is never closed. */
function skipRawText(html: string, from: number, name: string): number {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return html.length;
  const close = html.indexOf('>', m.index);
  return close === -1 ? html.length : close + 1;
}

/** Index just past the element (and its nested copies) that starts before `from`. */
function skipElement(html: string, from: number, name: string): number {
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return html.length;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.name !== name) {
      if (!tag.closing && RAW_TEXT.has(tag.name)) i = skipRawText(html, i, tag.name);
      continue;
    }
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return i;
  }
  return html.length;
}

export function sanitizeHtml(input: string): string {
  const html = input.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const out: string[] = [];
  const stack: string[] = [];
  const close = (until: number) => {
    while (stack.length > until) out.push(`</${stack.pop()}>`);
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(escapeText(html.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(html.slice(i, lt)));
    i = lt;

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?' || (html[i + 1] === '/' && !/[a-zA-Z]/.test(html[i + 2] ?? ''))) {
      // Doctype, CDATA, processing instruction or a bogus end tag: dropped.
      const end = html.indexOf('>', i + 1);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (!/[a-zA-Z/]/.test(html[i + 1] ?? '')) {
      out.push('&lt;');
      i++;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) break; // the input ends inside a tag: browsers drop it too
    i = tag.end;
    const { name } = tag;

    if (!tag.closing && RAW_TEXT.has(name)) {
      i = skipRawText(html, i, name);
      continue;
    }
    if (!tag.closing && DROP_WITH_CONTENT.has(name)) {
      if (!tag.selfClosing) i = skipElement(html, i, name);
      continue;
    }
    if (!ELEMENTS.has(name)) continue; // unknown or unsafe wrapper: keep its content, drop the tag

    if (tag.closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) close(at);
      continue;
    }

    if (stack[stack.length - 1] === 'p' && CLOSES_P.has(name)) close(stack.length - 1);
    const top = stack[stack.length - 1];
    if (name === 'li' && top === 'li') close(stack.length - 1);
    if ((name === 'dt' || name === 'dd') && (top === 'dt' || top === 'dd')) close(stack.length - 1);
    if ((name === 'td' || name === 'th' || name === 'tr') && (top === 'td' || top === 'th')) close(stack.length - 1);
    if (name === 'tr' && stack[stack.length - 1] === 'tr') close(stack.length - 1);

    if (stack.length >= MAX_DEPTH && !VOID.has(name)) continue;
    out.push(`<${name}${renderAttrs(name, tag.attrs)}>`);
    if (!VOID.has(name)) stack.push(name);
  }
  close(0);
  return out.join('');
}
