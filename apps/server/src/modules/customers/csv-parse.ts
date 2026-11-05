/**
 * RFC 4180 CSV reader for uploads: quoted fields, escaped quotes, embedded
 * line breaks, CRLF/LF/CR endings, a UTF-8 byte order mark, and comma,
 * semicolon or tab delimiters (spreadsheet exports in many locales use ";").
 */
export interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  headers: string[];
  rows: string[][];
}

export class CsvError extends Error {}

const DELIMITERS = [',', ';', '\t'] as const;

/** Count delimiter candidates in the first record, ignoring quoted text. */
function detectDelimiter(text: string): ParsedCsv['delimiter'] {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: ParsedCsv['delimiter'] = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Cells Steward exports start with an apostrophe when they would otherwise be
 * read as a spreadsheet formula (see core/csv.ts); undo that on the way back in.
 */
function unprotect(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

export function parseCsv(input: Buffer | string, limits: { maxRows: number; maxColumns: number }): ParsedCsv {
  let text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\u0000')) throw new CsvError('This does not look like a text CSV file');
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (record.some((v) => v.trim() !== '')) {
      if (record.length > limits.maxColumns) throw new CsvError(`Rows may have at most ${limits.maxColumns} columns`);
      records.push(record);
      if (records.length > limits.maxRows + 1) throw new CsvError(`Files may contain at most ${limits.maxRows.toLocaleString('en')} rows; split larger files`);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) endField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError('A quoted value is not closed');
  if (field !== '' || record.length) endRecord();

  if (!records.length) throw new CsvError('The file is empty');
  const seen = new Map<string, number>();
  const headers = records[0].map((raw, i) => {
    const base = raw.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows = records.slice(1).map((r) => headers.map((_, i) => unprotect((r[i] ?? '').trim())));
  if (!rows.length) throw new CsvError('The file has a header row but no data rows');
  return { delimiter, headers, rows };
}
