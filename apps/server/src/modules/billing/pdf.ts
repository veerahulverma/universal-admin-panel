import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { toDecimalString } from './money.js';

/** Standard PDF fonts only cover WinAnsi; replace anything else rather than failing the render. */
function safe(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function money(minor: number, currency: string): string {
  const [whole, frac] = toDecimalString(Math.abs(minor), currency).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0 ? '-' : ''}${currency} ${grouped}${frac ? `.${frac}` : ''}`;
}

function date(d: Date | string | null): string {
  if (!d) return '-';
  return new Date(d).toISOString().slice(0, 10);
}

interface Ctx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
}

function text(c: Ctx, value: string, x: number, opts: { size?: number; bold?: boolean; color?: [number, number, number]; right?: boolean } = {}): void {
  const size = opts.size ?? 9;
  const font = opts.bold ? c.bold : c.font;
  const s = safe(value);
  const width = font.widthOfTextAtSize(s, size);
  c.page.drawText(s, { x: opts.right ? x - width : x, y: c.y, size, font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])) });
}

function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(value).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

/** Render an invoice (or credit note-style document) as a simple, printable A4 PDF. */
export async function renderInvoicePdf(invoice: any, lines: any[], opts: { appName: string; title?: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${opts.title ?? 'Invoice'} ${invoice.number ?? invoice.id}`);
  pdf.setCreator(opts.appName);
  const page = pdf.addPage([595.28, 841.89]);
  const c: Ctx = { page, font: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), y: 790 };
  const left = 50;
  const right = 545;
  const muted: [number, number, number] = [0.42, 0.44, 0.5];
  const seller = invoice.seller_details ?? {};
  const customer = invoice.customer_details ?? {};

  text(c, seller.name || opts.appName, left, { size: 16, bold: true });
  text(c, (opts.title ?? 'INVOICE').toUpperCase(), right, { size: 16, bold: true, right: true });
  c.y -= 18;
  for (const l of String(seller.address ?? '').split('\n').filter(Boolean)) {
    text(c, l, left, { color: muted });
    c.y -= 12;
  }
  if (seller.email) {
    text(c, seller.email, left, { color: muted });
    c.y -= 12;
  }
  if (seller.taxId) {
    text(c, `Tax ID: ${seller.taxId}`, left, { color: muted });
    c.y -= 12;
  }

  let metaY = 772;
  const meta: [string, string][] = [
    ['Number', invoice.number ?? 'DRAFT'],
    ['Issued', date(invoice.issued_at ?? invoice.created_at)],
    ['Due', date(invoice.due_at)],
    ['Status', String(invoice.status).toUpperCase()],
  ];
  if (invoice.period_start) meta.push(['Period', `${date(invoice.period_start)} - ${date(invoice.period_end)}`]);
  for (const [k, v] of meta) {
    const saved = c.y;
    c.y = metaY;
    text(c, k, 400, { color: muted });
    text(c, v, right, { right: true, bold: k === 'Number' });
    c.y = saved;
    metaY -= 13;
  }

  c.y = Math.min(c.y, metaY) - 20;
  text(c, 'BILL TO', left, { size: 8, bold: true, color: muted });
  c.y -= 13;
  for (const l of [customer.name, customer.company && customer.company !== customer.name ? customer.company : null, customer.email, customer.taxId ? `Tax ID: ${customer.taxId}` : null].filter(Boolean)) {
    text(c, String(l), left);
    c.y -= 12;
  }
  const addr = customer.address ?? {};
  const addrLine = [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode, addr.country].filter(Boolean).join(', ');
  if (addrLine) {
    for (const l of wrap(addrLine, c.font, 9, 260)) {
      text(c, l, left, { color: muted });
      c.y -= 12;
    }
  }

  c.y -= 18;
  page.drawRectangle({ x: left, y: c.y - 4, width: right - left, height: 18, color: rgb(0.95, 0.95, 0.97) });
  c.y += 2;
  text(c, 'Description', left + 6, { bold: true });
  text(c, 'Qty', 360, { bold: true, right: true });
  text(c, 'Tax', 430, { bold: true, right: true });
  text(c, 'Amount', right - 6, { bold: true, right: true });
  c.y -= 22;

  for (const line of lines) {
    const desc = wrap(line.description, c.font, 9, 290);
    text(c, desc[0] ?? '', left + 6);
    text(c, String(line.quantity), 360, { right: true });
    text(c, line.tax_rate_bps ? `${(line.tax_rate_bps / 100).toFixed(2)}%` : '-', 430, { right: true });
    text(c, money(line.amount, invoice.currency), right - 6, { right: true });
    for (const extra of desc.slice(1)) {
      c.y -= 11;
      text(c, extra, left + 6, { color: muted });
    }
    if (line.discount_amount > 0) {
      c.y -= 11;
      text(c, 'Discount', left + 6, { color: muted });
      text(c, money(-line.discount_amount, invoice.currency), right - 6, { right: true, color: muted });
    }
    c.y -= 16;
    if (c.y < 140) break;
  }

  page.drawLine({ start: { x: 330, y: c.y + 8 }, end: { x: right, y: c.y + 8 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.84) });
  c.y -= 6;
  const totals: [string, number, boolean?][] = [
    ['Subtotal', invoice.subtotal],
    ...(invoice.discount_total ? ([['Discount', -invoice.discount_total]] as [string, number][]) : []),
    ['Tax', invoice.tax_total],
    ['Total', invoice.total, true],
    ...(invoice.balance_applied ? ([['Account credit applied', -invoice.balance_applied]] as [string, number][]) : []),
    ['Amount paid', invoice.amount_paid],
    ...(invoice.amount_refunded ? ([['Refunded', -invoice.amount_refunded]] as [string, number][]) : []),
    ['Amount due', Math.max(0, invoice.amount_due - invoice.amount_paid), true],
  ];
  for (const [label, value, strong] of totals) {
    text(c, label, 340, { bold: strong });
    text(c, money(value, invoice.currency), right - 6, { right: true, bold: strong });
    c.y -= 14;
  }

  if (invoice.tax_note || invoice.notes) {
    c.y -= 16;
    for (const l of wrap([invoice.tax_note, invoice.notes].filter(Boolean).join(' — '), c.font, 8, right - left)) {
      text(c, l, left, { size: 8, color: muted });
      c.y -= 11;
    }
  }

  c.y = 40;
  text(c, `${opts.appName} · ${invoice.number ?? invoice.id}`, left, { size: 7, color: muted });
  return Buffer.from(await pdf.save());
}
