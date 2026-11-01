// ATLAS deterministic data-cleaning core. Pure module: no I/O, logging, storage, network, or dependencies.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 10_000;
export const OPERATION_ALLOWLIST = Object.freeze([
  'trim_fields',
  'normalize_email',
  'dedupe_exact',
  'format_date',
  'normalize_number',
  'rename_fields',
  'empty_to_null',
  'extract_json_paths',
  'validate',
  'convert_format',
]);

const encoder = new TextEncoder();
const DELIMITERS = Object.freeze([',', ';', '\t', '|']);
const DATE_FORMATS = Object.freeze(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);
const NUMBER_LOCALES = Object.freeze({
  'en-US': { group: ',', decimal: '.' },
  'de-DE': { group: '.', decimal: ',' },
  'fr-FR': { group: '\u202F', decimal: ',' },
});

function fault(code, details) {
  const err = new Error(code);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function inputBytes(input, maxBytes = MAX_FILE_BYTES) {
  let bytes;
  if (typeof input === 'string') bytes = encoder.encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else throw fault('INPUT_TYPE_UNSUPPORTED');
  if (bytes.byteLength > Math.min(MAX_FILE_BYTES, maxBytes)) {
    throw fault('FILE_SIZE_LIMIT_EXCEEDED', { maxBytes: Math.min(MAX_FILE_BYTES, maxBytes), actualBytes: bytes.byteLength });
  }
  return bytes;
}

function decodeUtf8(input, maxBytes = MAX_FILE_BYTES) {
  const bytes = inputBytes(input, maxBytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fault('INVALID_UTF8');
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return { text, byteLength: bytes.byteLength };
}

function validDelimiter(delimiter) {
  return DELIMITERS.includes(delimiter);
}

function parseCsvRecords(text, delimiter) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let recordHadSyntax = false;
  let line = 1;
  let recordLine = 1;

  const pushRecord = () => {
    row.push(field);
    const physicallyBlank = row.length === 1 && row[0] === '' && !recordHadSyntax;
    if (!physicallyBlank) records.push({ values: row, line: recordLine });
    row = [];
    field = '';
    inQuotes = false;
    afterQuote = false;
    fieldStarted = false;
    recordHadSyntax = false;
    recordLine = line + 1;
  };

  const newline = () => {
    if (inQuotes) {
      field += '\n';
      line++;
    } else {
      pushRecord();
      line++;
      recordLine = line;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '\r') {
      if (text[i + 1] !== '\n') throw fault('CSV_BARE_CARRIAGE_RETURN', { line });
      newline();
      i++;
      continue;
    }
    if (c === '\n') {
      newline();
      continue;
    }

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (afterQuote) {
      if (c === delimiter) {
        row.push(field);
        field = '';
        afterQuote = false;
        fieldStarted = false;
        recordHadSyntax = true;
        continue;
      }
      throw fault('CSV_CHARACTERS_AFTER_CLOSING_QUOTE', { line });
    }

    if (c === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
      recordHadSyntax = true;
    } else if (c === '"') {
      if (fieldStarted || field.length > 0) throw fault('CSV_QUOTE_IN_UNQUOTED_FIELD', { line });
      inQuotes = true;
      fieldStarted = true;
      recordHadSyntax = true;
    } else {
      field += c;
      fieldStarted = true;
      recordHadSyntax = true;
    }
  }

  if (inQuotes) throw fault('CSV_UNTERMINATED_QUOTE', { line });
  if (fieldStarted || field.length > 0 || row.length > 0 || recordHadSyntax) pushRecord();
  return records;
}

function materializeCsv(records, delimiter, maxRows) {
  if (records.length === 0) throw fault('CSV_EMPTY');
  const headers = records[0].values;
  if (headers.length === 0 || headers.some(h => h.trim() === '')) {
    throw fault('CSV_EMPTY_HEADER', { line: records[0].line });
  }
  if (new Set(headers).size !== headers.length) {
    throw fault('CSV_DUPLICATE_HEADER', { line: records[0].line });
  }

  const width = headers.length;
  for (let i = 1; i < records.length; i++) {
    if (records[i].values.length !== width) {
      throw fault('CSV_ROW_WIDTH_MISMATCH', {
        line: records[i].line,
        expectedColumns: width,
        actualColumns: records[i].values.length,
      });
    }
  }

  const rows = records.slice(1).map(record =>
    Object.fromEntries(headers.map((header, index) => [header, record.values[index]]))
  );
  if (rows.length > maxRows) throw fault('ROW_LIMIT_EXCEEDED', { maxRows, actualRows: rows.length });
  return { headers: headers.slice(), rows, delimiter, rowCount: rows.length };
}

function detectCsvDelimiter(text) {
  const counts = new Map(DELIMITERS.map(delimiter => [delimiter, 0]));
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw fault('CSV_BARE_CARRIAGE_RETURN', { line });
      if (inQuotes) {
        line++;
        i++;
        continue;
      }
      break;
    }
    if (c === '\n') {
      if (inQuotes) {
        line++;
        continue;
      }
      break;
    }
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else {
          inQuotes = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (afterQuote) {
      if (counts.has(c)) {
        counts.set(c, counts.get(c) + 1);
        afterQuote = false;
        fieldStarted = false;
        continue;
      }
      throw fault('CSV_CHARACTERS_AFTER_CLOSING_QUOTE', { line });
    }
    if (counts.has(c)) {
      counts.set(c, counts.get(c) + 1);
      fieldStarted = false;
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw fault('CSV_QUOTE_IN_UNQUOTED_FIELD', { line });
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    fieldStarted = true;
  }

  if (inQuotes) throw fault('CSV_UNTERMINATED_QUOTE', { line });
  const candidates = DELIMITERS.filter(delimiter => counts.get(delimiter) > 0);
  if (candidates.length > 1) throw fault('CSV_DELIMITER_AMBIGUOUS', { candidates });
  if (candidates.length === 0) throw fault('CSV_DELIMITER_UNDETECTED');
  return candidates[0];
}

export function parseCsv(input, options = {}) {
  const maxRows = Math.min(MAX_DATA_ROWS, options.maxRows ?? MAX_DATA_ROWS);
  const decoded = decodeUtf8(input, options.maxBytes ?? MAX_FILE_BYTES);
  const delimiter = options.delimiter === undefined
    ? detectCsvDelimiter(decoded.text)
    : options.delimiter;
  if (!validDelimiter(delimiter)) throw fault('CSV_DELIMITER_UNSUPPORTED');
  const records = parseCsvRecords(decoded.text, delimiter);
  return { ...materializeCsv(records, delimiter, maxRows), byteLength: decoded.byteLength };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonHeaders(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

export function parseJson(input, options = {}) {
  const decoded = decodeUtf8(input, options.maxBytes ?? MAX_FILE_BYTES);
  let value;
  try {
    value = JSON.parse(decoded.text);
  } catch {
    throw fault('JSON_PARSE_FAILED');
  }
  if (!Array.isArray(value)) throw fault('JSON_ROOT_MUST_BE_ARRAY');
  const maxRows = Math.min(MAX_DATA_ROWS, options.maxRows ?? MAX_DATA_ROWS);
  if (value.length > maxRows) throw fault('ROW_LIMIT_EXCEEDED', { maxRows, actualRows: value.length });
  if (value.some(row => !isPlainObject(row))) throw fault('JSON_ROWS_MUST_BE_OBJECTS');
  return { rows: value, headers: jsonHeaders(value), rowCount: value.length, byteLength: decoded.byteLength };
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, cloneJson(val)]));
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw fault('DATA_VALUE_UNSUPPORTED');
}

function cloneRows(rows) {
  if (!Array.isArray(rows) || rows.some(row => !isPlainObject(row))) throw fault('ROWS_MUST_BE_OBJECTS');
  return rows.map(cloneJson);
}

function selectedFields(operation) {
  if (!Array.isArray(operation.fields) || operation.fields.length === 0 ||
      operation.fields.some(field => typeof field !== 'string' || field.length === 0) ||
      new Set(operation.fields).size !== operation.fields.length) {
    throw fault('OPERATION_FIELDS_INVALID');
  }
  return operation.fields;
}

function isValidDateParts(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDate(value, format) {
  if (!DATE_FORMATS.includes(format) || typeof value !== 'string') return null;
  let match;
  if (format === 'YYYY-MM-DD') match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  else if (format === 'DD/MM/YYYY') match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  else match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  let year, month, day;
  if (format === 'YYYY-MM-DD') [, year, month, day] = match;
  else if (format === 'DD/MM/YYYY') [, day, month, year] = match;
  else [, month, day, year] = match;
  year = Number(year); month = Number(month); day = Number(day);
  return isValidDateParts(year, month, day) ? { year, month, day } : null;
}

function formatDate(parts, format) {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  if (format === 'YYYY-MM-DD') return year + '-' + month + '-' + day;
  if (format === 'DD/MM/YYYY') return day + '/' + month + '/' + year;
  if (format === 'MM/DD/YYYY') return month + '/' + day + '/' + year;
  throw fault('DATE_FORMAT_UNSUPPORTED');
}

function parseLocalizedNumber(value, locale) {
  const spec = NUMBER_LOCALES[locale];
  if (!spec) throw fault('NUMBER_LOCALE_UNSUPPORTED');
  let text = value.trim();
  if (locale === 'fr-FR') text = text.replace(/[\u00A0\u202F ]/g, '\u202F');
  if (!text) return null;
  const sign = /^[+-]/.test(text) ? text[0] : '';
  if (sign) text = text.slice(1);
  const pieces = text.split(spec.decimal);
  if (pieces.length > 2) return null;
  const integerPart = pieces[0];
  const fractionPart = pieces.length === 2 ? pieces[1] : null;
  if (fractionPart !== null && !/^\d+$/.test(fractionPart)) return null;
  let integerDigits = integerPart;
  if (integerPart.includes(spec.group)) {
    const groups = integerPart.split(spec.group);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/.test(group))) return null;
    integerDigits = groups.join('');
  } else if (!/^\d+$/.test(integerPart)) {
    return null;
  }
  if (!/^\d+$/.test(integerDigits)) return null;
  const number = Number(sign + integerDigits + (fractionPart === null ? '' : '.' + fractionPart));
  return Number.isFinite(number) ? number : null;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0) throw fault('JSON_PATH_INVALID');
  const segments = path.split('.');
  if (segments.some(part => part.length === 0 || part === '__proto__' || part === 'prototype' || part === 'constructor')) {
    throw fault('JSON_PATH_UNSAFE');
  }
  return segments;
}

function valueAtPath(source, path) {
  let value = source;
  for (const segment of path) {
    if (value === null || value === undefined || (typeof value !== 'object' && !Array.isArray(value))) return null;
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(segment)) return null;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return null;
    value = value[segment];
  }
  return value === undefined ? null : cloneJson(value);
}

export function validateRows(rows, operation) {
  const requiredFields = operation.requiredFields ?? [];
  const fieldTypes = operation.fieldTypes ?? {};
  if (!Array.isArray(requiredFields) || requiredFields.some(field => typeof field !== 'string')) {
    throw fault('VALIDATION_REQUIRED_FIELDS_INVALID');
  }
  if (!isPlainObject(fieldTypes)) throw fault('VALIDATION_FIELD_TYPES_INVALID');
  const allowedTypes = ['string', 'number', 'boolean', 'date'];
  for (const type of Object.values(fieldTypes)) {
    if (!allowedTypes.includes(type)) throw fault('VALIDATION_TYPE_UNSUPPORTED');
  }
  const errors = [];
  rows.forEach((row, index) => {
    for (const field of requiredFields) {
      const value = row[field];
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        errors.push({ row: index + 1, field, code: 'REQUIRED' });
      }
    }
    for (const [field, type] of Object.entries(fieldTypes)) {
      const value = row[field];
      if (value === null || value === undefined || value === '') continue;
      let valid = true;
      if (type === 'string') valid = typeof value === 'string';
      if (type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
      if (type === 'boolean') valid = typeof value === 'boolean';
      if (type === 'date') valid = typeof value === 'string' && parseDate(value, 'YYYY-MM-DD') !== null;
      if (!valid) errors.push({ row: index + 1, field, code: 'TYPE_MISMATCH' });
    }
  });
  return {
    valid: errors.length === 0,
    totalRows: rows.length,
    failedRows: new Set(errors.map(item => item.row)).size,
    errors,
  };
}

export function applyOperation(rows, operation, headerNames = []) {
  if (!isPlainObject(operation) || !OPERATION_ALLOWLIST.includes(operation.type)) {
    throw fault('OPERATION_NOT_ALLOWLISTED');
  }
  const copy = cloneRows(rows);
  const type = operation.type;

  if (type === 'validate') return { rows: copy, validation: validateRows(copy, operation) };
  if (type === 'convert_format') {
    if (!['csv', 'json'].includes(operation.to)) throw fault('OUTPUT_FORMAT_UNSUPPORTED');
    return { rows: copy, outputFormat: operation.to };
  }

  if (type === 'trim_fields' || type === 'normalize_email' || type === 'empty_to_null') {
    const fields = selectedFields(operation);
    for (const row of copy) for (const field of fields) {
      if (typeof row[field] !== 'string') continue;
      if (type === 'trim_fields') row[field] = row[field].trim();
      if (type === 'normalize_email') row[field] = row[field].trim().toLowerCase();
      if (type === 'empty_to_null' && row[field].trim() === '') row[field] = null;
    }
    return { rows: copy };
  }

  if (type === 'dedupe_exact') {
    const seen = new Set();
    return { rows: copy.filter(row => {
      const key = canonical(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) };
  }

  if (type === 'format_date') {
    const fields = selectedFields(operation);
    if (!DATE_FORMATS.includes(operation.inputFormat) || !DATE_FORMATS.includes(operation.outputFormat)) {
      throw fault('DATE_FORMAT_UNSUPPORTED');
    }
    for (const row of copy) for (const field of fields) {
      if (row[field] === null || row[field] === undefined || row[field] === '') continue;
      const parsed = parseDate(row[field], operation.inputFormat);
      if (!parsed) throw fault('DATE_VALUE_INVALID', { field });
      row[field] = formatDate(parsed, operation.outputFormat);
    }
    return { rows: copy };
  }

  if (type === 'normalize_number') {
    const fields = selectedFields(operation);
    if (!NUMBER_LOCALES[operation.locale]) throw fault('NUMBER_LOCALE_UNSUPPORTED');
    for (const row of copy) for (const field of fields) {
      if (row[field] === null || row[field] === undefined || row[field] === '') continue;
      if (typeof row[field] === 'number' && Number.isFinite(row[field])) continue;
      if (typeof row[field] !== 'string') throw fault('NUMBER_VALUE_INVALID', { field });
      const parsed = parseLocalizedNumber(row[field], operation.locale);
      if (parsed === null) throw fault('NUMBER_VALUE_INVALID', { field });
      row[field] = parsed;
    }
    return { rows: copy };
  }

  if (type === 'rename_fields') {
    const mapping = operation.mapping;
    if (!isPlainObject(mapping)) throw fault('RENAME_MAPPING_INVALID');
    const entries = Object.entries(mapping);
    if (entries.some(([from, to]) => !from || typeof to !== 'string' || !to.trim())) {
      throw fault('RENAME_MAPPING_INVALID');
    }
    const destinations = entries.map(([, to]) => to);
    if (new Set(destinations).size !== destinations.length) throw fault('RENAME_DESTINATION_COLLISION');
    const sources = new Set(entries.map(([from]) => from));
    const originalKeys = new Set([...headerNames, ...copy.flatMap(row => Object.keys(row))]);
    for (const [, to] of entries) {
      if (originalKeys.has(to) && !sources.has(to)) throw fault('RENAME_DESTINATION_COLLISION');
    }
    return { rows: copy.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [mapping[key] ?? key, value]))) };
  }

  if (type === 'extract_json_paths') {
    const paths = operation.paths;
    if (!isPlainObject(paths)) throw fault('JSON_PATHS_INVALID');
    const entries = Object.entries(paths).map(([target, path]) => {
      if (!target || typeof path !== 'string') throw fault('JSON_PATHS_INVALID');
      return [target, safePath(path)];
    });
    const existing = new Set([...headerNames, ...copy.flatMap(row => Object.keys(row))]);
    if (entries.some(([target]) => existing.has(target))) throw fault('OUTPUT_FIELD_COLLISION');
    return {
      rows: copy.map(row => {
        const out = { ...row };
        for (const [target, path] of entries) out[target] = valueAtPath(row, path);
        return out;
      }),
    };
  }

  throw fault('OPERATION_NOT_IMPLEMENTED');
}

function csvCell(value, delimiter) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else text = JSON.stringify(value);
  if (text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

export function serializeCsv(rows, headers = jsonHeaders(rows), delimiter = ',') {
  if (!validDelimiter(delimiter)) throw fault('CSV_DELIMITER_UNSUPPORTED');
  const lines = [headers.map(header => csvCell(header, delimiter)).join(delimiter)];
  for (const row of rows) lines.push(headers.map(header => csvCell(row[header], delimiter)).join(delimiter));
  return encoder.encode(lines.join('\r\n'));
}

export function convertFormat(input, options = {}) {
  const from = options.from;
  const to = options.to;
  if (!['csv', 'json'].includes(from) || !['csv', 'json'].includes(to)) throw fault('FORMAT_UNSUPPORTED');
  if (from === to) throw fault('FORMAT_CONVERSION_NOOP');
  const parsed = from === 'csv' ? parseCsv(input, options) : parseJson(input, options);
  const bytes = to === 'json'
    ? encoder.encode(JSON.stringify(parsed.rows))
    : serializeCsv(parsed.rows, parsed.headers, options.delimiter ?? parsed.delimiter ?? ',');
  if (bytes.byteLength > MAX_FILE_BYTES) throw fault('OUTPUT_SIZE_LIMIT_EXCEEDED', { maxBytes: MAX_FILE_BYTES, actualBytes: bytes.byteLength });
  return { bytes, from, to, rowCount: parsed.rowCount, byteLength: bytes.byteLength };
}

export function createCleaningSession(parsed, options = {}) {
  const inputFormat = options.inputFormat;
  if (!['csv', 'json'].includes(inputFormat)) throw fault('INPUT_FORMAT_UNSUPPORTED');
  if (!parsed || !Array.isArray(parsed.rows) || !Array.isArray(parsed.headers)) throw fault('PARSED_INPUT_INVALID');

  const operations = options.operations ?? [];
  if (!Array.isArray(operations)) throw fault('OPERATIONS_MUST_BE_ARRAY');
  const conversions = operations.filter(operation => operation && operation.type === 'convert_format');
  if (conversions.length > 1 || (conversions.length === 1 && operations[operations.length - 1] !== conversions[0])) {
    throw fault('CONVERSION_OPERATION_ORDER_INVALID');
  }
  let outputFormat = options.outputFormat ?? inputFormat;
  if (conversions.length === 1) {
    const conversion = conversions[0];
    if (!['csv', 'json'].includes(conversion.to)) throw fault('OUTPUT_FORMAT_UNSUPPORTED');
    if (options.outputFormat !== undefined && options.outputFormat !== conversion.to) throw fault('OUTPUT_FORMAT_CONFLICT');
    outputFormat = conversion.to;
  } else if (outputFormat !== inputFormat) {
    throw fault('CONVERSION_OPERATION_REQUIRED');
  }
  if (!['csv', 'json'].includes(outputFormat)) throw fault('OUTPUT_FORMAT_UNSUPPORTED');

  let headerState = parsed.headers.slice();
  const headersByOperation = [];
  for (const operation of operations) {
    headersByOperation.push(headerState.slice());
    // Validate every operation before any chunk is committed, including empty inputs.
    applyOperation([], operation, headerState);
    if (operation.type === 'rename_fields') {
      headerState = headerState.map(header => operation.mapping[header] ?? header);
    }
    if (operation.type === 'extract_json_paths') {
      for (const target of Object.keys(operation.paths)) if (!headerState.includes(target)) headerState.push(target);
    }
  }

  return {
    inputFormat,
    outputFormat,
    operations,
    headersByOperation,
    headers: headerState,
    inputRowCount: parsed.rowCount,
    delimiter: options.delimiter ?? parsed.delimiter ?? ',',
    operationOffsets: operations.map(() => 0),
    dedupeSeen: operations.map(() => []),
    validation: operations.map(operation => operation.type === 'validate'
      ? { errors: [], totalRows: 0, failedRowNumbers: [] }
      : null),
  };
}

export function processCleaningChunk(rows, session) {
  let current = cloneRows(rows);
  for (let index = 0; index < session.operations.length; index++) {
    const operation = session.operations[index];
    const headerNames = session.headersByOperation[index];
    const rowsBeforeOperation = current.length;

    if (operation.type === 'dedupe_exact') {
      const local = applyOperation(current, operation, headerNames).rows;
      const seen = new Set(session.dedupeSeen[index]);
      current = local.filter(row => {
        const key = canonical(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      session.dedupeSeen[index] = [...seen];
    } else {
      const result = applyOperation(current, operation, headerNames);
      current = result.rows;
      if (result.validation) {
        const record = session.validation[index];
        const offset = session.operationOffsets[index];
        record.errors.push(...result.validation.errors.map(error => ({ ...error, row: error.row + offset })));
        record.failedRowNumbers.push(...result.validation.errors.map(error => error.row + offset));
        record.totalRows += result.validation.totalRows;
      }
    }

    session.operationOffsets[index] += rowsBeforeOperation;
  }
  return current;
}

export function finalizeCleaningSession(session, outputChunks) {
  const rows = outputChunks.flat();
  const headers = rows.length > 0 ? jsonHeaders(rows) : session.headers.slice();
  let validation = null;
  for (let index = session.operations.length - 1; index >= 0; index--) {
    if (session.operations[index].type !== 'validate') continue;
    const record = session.validation[index];
    validation = {
      valid: record.errors.length === 0,
      totalRows: record.totalRows,
      failedRows: new Set(record.failedRowNumbers).size,
      errors: record.errors,
    };
    break;
  }

  const bytes = session.outputFormat === 'json'
    ? encoder.encode(JSON.stringify(rows))
    : serializeCsv(rows, headers, session.delimiter);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw fault('OUTPUT_SIZE_LIMIT_EXCEEDED', { maxBytes: MAX_FILE_BYTES, actualBytes: bytes.byteLength });
  }

  return {
    inputFormat: session.inputFormat,
    outputFormat: session.outputFormat,
    rowCount: rows.length,
    inputRowCount: session.inputRowCount,
    byteLength: bytes.byteLength,
    headers,
    rows,
    bytes,
    validation,
  };
}

export function executeCleaningJob(input, options = {}) {
  const inputFormat = options.inputFormat;
  if (!['csv', 'json'].includes(inputFormat)) throw fault('INPUT_FORMAT_UNSUPPORTED');
  const parsed = inputFormat === 'csv' ? parseCsv(input, options) : parseJson(input, options);
  const session = createCleaningSession(parsed, options);
  const chunkRows = Number.isInteger(options.chunkRows) && options.chunkRows > 0
    ? Math.min(10_000, options.chunkRows)
    : Math.max(1, parsed.rows.length);
  const outputChunks = [];
  if (parsed.rows.length === 0) {
    outputChunks.push(processCleaningChunk([], session));
  } else {
    for (let offset = 0; offset < parsed.rows.length; offset += chunkRows) {
      outputChunks.push(processCleaningChunk(parsed.rows.slice(offset, offset + chunkRows), session));
    }
  }
  return finalizeCleaningSession(session, outputChunks);
}
