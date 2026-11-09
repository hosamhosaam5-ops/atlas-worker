export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_ROWS = 200;
export const PREVIEW_ROWS = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DATE_KEYS = /(^|_)(date|datetime|timestamp|created_at|updated_at|time)($|_)/i;
const PHONE_KEYS = /(^|_)(phone|mobile|telephone|tel|fax)($|_)/i;

function fail(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function inputBytes(input) {
  if (typeof input === 'string') return encoder.encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw fail('INPUT_TYPE_UNSUPPORTED');
}

export function decodeInput(input) {
  const bytes = inputBytes(input);
  if (bytes.byteLength > MAX_FILE_BYTES) throw fail('FILE_SIZE_LIMIT_EXCEEDED', 413);
  try {
    let text;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    } else {
      text = decoder.decode(bytes);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    throw fail('INVALID_ENCODING');
  }
}

function parseCsvRecords(text, delimiter) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;
  const push = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) records.push({ values: row, line: rowLine });
    row = [];
    field = '';
    quoted = false;
    afterQuote = false;
    rowLine = line + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (afterQuote) {
      if (ch === delimiter) { row.push(field); field = ''; afterQuote = false; continue; }
      if (ch === '\r' && text[i + 1] === '\n') { push(); i++; line++; rowLine = line; continue; }
      if (ch === '\n') { push(); line++; rowLine = line; continue; }
      if (ch === ' ' || ch === '\t') continue;
      throw fail('CSV_CHAR_AFTER_QUOTE');
    }
    if (ch === '"') {
      if (field.length) throw fail('CSV_QUOTE_IN_FIELD');
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      push(); i++; line++; rowLine = line;
    } else if (ch === '\n') {
      push(); line++; rowLine = line;
    } else if (ch === '\r') {
      throw fail('CSV_BARE_CARRIAGE_RETURN');
    } else {
      field += ch;
    }
  }
  if (quoted) throw fail('CSV_UNTERMINATED_QUOTE');
  if (field.length || row.length || afterQuote) push();
  return records;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t', '|'].map(delimiter => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  if (!candidates.length) return ',';
  if (candidates.length > 1 && candidates[0].count === candidates[1].count) throw fail('CSV_DELIMITER_AMBIGUOUS');
  return candidates[0].delimiter;
}

function normalizeHeader(header, index) {
  const normalized = String(header ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || `column_${index + 1}`;
}

function uniqueHeaders(rawHeaders, changes) {
  const used = new Map();
  return rawHeaders.map((raw, index) => {
    const base = normalizeHeader(raw, index);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    const name = count === 1 ? base : `${base}_${count}`;
    if (String(raw) !== name) changes.push({ type: 'column_name_normalized', column: index + 1, from: String(raw), to: name });
    return name;
  });
}

function parseCsv(text, changes) {
  const delimiter = detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter);
  if (!records.length) throw fail('CSV_EMPTY');
  const headers = uniqueHeaders(records[0].values, changes);
  const rows = [];
  const rowNumbers = [];
  const malformedRows = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec.values.length !== headers.length) {
      malformedRows.push({ row: i + 1, code: 'CSV_ROW_WIDTH_MISMATCH', expected_columns: headers.length, actual_columns: rec.values.length, values: rec.values });
      changes.push({ type: 'malformed_row_preserved', row: i + 1, code: 'CSV_ROW_WIDTH_MISMATCH' });
      continue;
    }
    rows.push(Object.fromEntries(headers.map((header, index) => [header, rec.values[index]])));
    rowNumbers.push(i + 1);
  }
  return { rows, rowNumbers, malformedRows };
}

function parseJson(text, changes) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw fail('JSON_PARSE_FAILED'); }
  if (!Array.isArray(parsed)) throw fail('JSON_ROOT_MUST_BE_ARRAY');
  const rows = [];
  const rowNumbers = [];
  const malformedRows = [];
  parsed.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      malformedRows.push({ row: index + 1, code: 'JSON_ROW_NOT_OBJECT', value: row });
      changes.push({ type: 'malformed_row_preserved', row: index + 1, code: 'JSON_ROW_NOT_OBJECT' });
    } else { rows.push(row); rowNumbers.push(index + 1); }
  });
  return { rows, rowNumbers, malformedRows };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeDate(value) {
  const text = String(value).trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const [, y, m, d] = match;
    return validDate(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
  }
  match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(text);
  if (!match) return null;
  const a = Number(match[1]), b = Number(match[2]), year = Number(match[3]);
  if (a <= 12 && b <= 12) return null;
  const day = a > 12 ? a : b;
  const month = a > 12 ? b : a;
  return validDate(year, month, day) ? `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` : null;
}

function validDate(year, month, day) {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanCell(key, value, rowNumber, changes) {
  if (typeof value !== 'string') return value;
  const nfc = value.normalize('NFC');
  const trimmed = nfc.replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/[\t\r\n ]+/g, ' ').trim();
  if (trimmed !== value) changes.push({ type: 'text_normalized', row: rowNumber, field: key });
  if (PHONE_KEYS.test(key)) {
    const plus = trimmed.startsWith('+') ? '+' : '';
    const digits = trimmed.replace(/\D/g, '');
    const phone = digits ? plus + digits : trimmed;
    if (phone !== trimmed) changes.push({ type: 'phone_normalized', row: rowNumber, field: key });
    return phone;
  }
  if (DATE_KEYS.test(key)) {
    const date = normalizeDate(trimmed);
    if (date && date !== trimmed) {
      changes.push({ type: 'date_normalized', row: rowNumber, field: key });
      return date;
    }
    if (trimmed && !date && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      changes.push({ type: 'date_not_normalized', row: rowNumber, field: key });
    }
  }
  return trimmed;
}

export function cleanRows(rows, malformedRows = [], initialChanges = [], rowNumbers = []) {
  const changes = [...initialChanges];
  const output = [];
  const seen = new Map();
  rows.forEach((source, index) => {
    const rowNumber = rowNumbers[index] ?? index + 1;
    const clean = {};
    const usedKeys = new Map();
    for (const [rawKey, value] of Object.entries(source)) {
      const base = normalizeHeader(rawKey, 0);
      const count = (usedKeys.get(base) || 0) + 1;
      usedKeys.set(base, count);
      const key = count === 1 ? base : `${base}_${count}`;
      clean[key] = cleanCell(key, value, rowNumber, changes);
      if (key !== rawKey) changes.push({ type: 'column_name_normalized', row: rowNumber, from: rawKey, to: key });
    }
    const signature = canonical(clean);
    if (seen.has(signature)) {
      changes.push({ type: 'duplicate_row_removed', row: rowNumber, duplicate_of: seen.get(signature) });
      return;
    }
    seen.set(signature, rowNumber);
    output.push(clean);
  });
  return { data: output, malformed_rows: malformedRows, changes };
}

export function cleanInput(input, format) {
  const text = decodeInput(input);
  const changes = [];
  let parsed;
  if (format === 'csv') parsed = parseCsv(text, changes);
  else if (format === 'json') parsed = parseJson(text, changes);
  else throw fail('INPUT_FORMAT_UNSUPPORTED', 415);
  const sourceCount = parsed.rows.length + parsed.malformedRows.length;
  if (sourceCount > MAX_ROWS) throw fail('ROW_LIMIT_EXCEEDED', 413);
  return { ...cleanRows(parsed.rows, parsed.malformedRows, changes, parsed.rowNumbers), source_rows: sourceCount };
}

function cleanInputPreview(input, format) {
  const result = cleanInput(input, format);
  return {
    ...result,
    data: result.data.slice(0, PREVIEW_ROWS),
    malformed_rows: result.malformed_rows.filter(row => row.row <= PREVIEW_ROWS),
    changes: result.changes.filter(change => !change.row || change.row <= PREVIEW_ROWS),
    preview: true,
    preview_rows: PREVIEW_ROWS,
    truncated: result.source_rows > PREVIEW_ROWS,
  };
}

function publicError(error) {
  const candidate = error && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const code = /^[A-Z0-9_]{3,64}$/.test(candidate) ? candidate : 'INTERNAL_ERROR';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  return { code, status };
}

// Internal API exposed as a frozen object for the Worker entry point.
export default Object.freeze({ cleanInputPreview, publicError });
