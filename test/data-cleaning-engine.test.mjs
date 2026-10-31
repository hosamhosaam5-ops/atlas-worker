import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES,
  MAX_DATA_ROWS,
  OPERATION_ALLOWLIST,
  parseCsv,
  parseJson,
  applyOperation,
  validateRows,
  convertFormat,
  executeCleaningJob,
} from '../src/data-cleaning/engine.js';

const encoder = new TextEncoder();
const bytes = value => encoder.encode(value);
const expectCode = (fn, code) => assert.throws(fn, error => error && error.code === code);
const basicRows = () => [
  { name: '  Ada  ', email: ' ADA@EXAMPLE.COM ', amount: '1.234,50', date: '31/01/2026', empty: '  ' },
  { name: 'Lin', email: 'LIN@EXAMPLE.COM', amount: '2,50', date: '01/02/2026', empty: 'x' },
];

test('01 - allowlist is exactly ten operations and parses ordinary UTF-8 CSV', () => {
  assert.equal(OPERATION_ALLOWLIST.length, 10);
  assert.deepEqual(parseCsv('name,age\nAda,37\n').rows, [{ name: 'Ada', age: '37' }]);
});

test('02 - UTF-8 BOM is removed from the first header only', () => {
  const result = parseCsv(bytes('\uFEFFname,email\nAda,ada@example.com\n'));
  assert.deepEqual(result.headers, ['name', 'email']);
  assert.equal(result.rows[0].name, 'Ada');
});

test('03 - malformed UTF-8 is rejected without replacement characters', () => {
  expectCode(() => parseCsv(Uint8Array.of(0xC3, 0x28)), 'INVALID_UTF8');
});

test('04 - semicolon delimiter is detected', () => {
  const result = parseCsv('name;age\nAda;37\n');
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.rows, [{ name: 'Ada', age: '37' }]);
});

test('05 - tab delimiter is detected', () => {
  const result = parseCsv('name\tage\nAda\t37\n');
  assert.equal(result.delimiter, '\t');
  assert.equal(result.rows[0].age, '37');
});

test('06 - pipe delimiter is detected', () => {
  const result = parseCsv('name|age\nAda|37\n');
  assert.equal(result.delimiter, '|');
  assert.equal(result.rows[0].name, 'Ada');
});

test('07 - quoted delimiters and escaped quotes are parsed exactly', () => {
  const result = parseCsv('name,note\nAda,"a,b and ""quoted"" text"\n');
  assert.equal(result.rows[0].note, 'a,b and "quoted" text');
});

test('08 - newlines inside quoted fields are preserved', () => {
  const result = parseCsv('name,note\r\nAda,"line one\r\nline two"\r\n');
  assert.equal(result.rows[0].note, 'line one\nline two');
});

test('09 - physically empty lines are skipped without dropping empty cells', () => {
  const result = parseCsv('name,age\n\nAda,37\n,\n\nLin,29\n');
  assert.deepEqual(result.rows, [{ name: 'Ada', age: '37' }, { name: '', age: '' }, { name: 'Lin', age: '29' }]);
});

test('10 - unterminated quoted field fails closed', () => {
  expectCode(() => parseCsv('name,note\nAda,"not closed\n'), 'CSV_UNTERMINATED_QUOTE');
});

test('11 - quote inside an unquoted field is rejected', () => {
  expectCode(() => parseCsv('name,note\nAd"a,ok\n'), 'CSV_QUOTE_IN_UNQUOTED_FIELD');
});

test('12 - non-delimiter text after a closing quote is rejected', () => {
  expectCode(() => parseCsv('name,note\n"Ada"x,ok\n'), 'CSV_CHARACTERS_AFTER_CLOSING_QUOTE');
});

test('13 - incomplete rows are rejected, never padded or truncated', () => {
  expectCode(() => parseCsv('a,b,c\n1,2\n'), 'CSV_ROW_WIDTH_MISMATCH');
});

test('14 - ambiguous delimiter candidates are rejected rather than guessed', () => {
  expectCode(() => parseCsv('a,b|c\n1,2|3\n'), 'CSV_DELIMITER_AMBIGUOUS');
});

test('15 - duplicate and blank headers are rejected', () => {
  expectCode(() => parseCsv('a,a\n1,2\n'), 'CSV_DUPLICATE_HEADER');
  expectCode(() => parseCsv('a, \n1,2\n'), 'CSV_EMPTY_HEADER');
});

test('16 - input byte limit is enforced at 5 MiB', () => {
  assert.equal(MAX_FILE_BYTES, 5 * 1024 * 1024);
  expectCode(() => parseCsv(new Uint8Array(MAX_FILE_BYTES + 1)), 'FILE_SIZE_LIMIT_EXCEEDED');
});

test('17 - exactly 10,000 data rows are accepted', () => {
  const source = 'id,value\n' + Array.from({ length: MAX_DATA_ROWS }, (_, index) => (index + 1) + ',x').join('\n');
  const result = parseCsv(source);
  assert.equal(result.rowCount, 10_000);
});

test('18 - 10,001 data rows are rejected', () => {
  const source = 'id,value\n' + Array.from({ length: MAX_DATA_ROWS + 1 }, (_, index) => (index + 1) + ',x').join('\n');
  expectCode(() => parseCsv(source), 'ROW_LIMIT_EXCEEDED');
});

test('19 - trim_fields changes only selected fields and never mutates input', () => {
  const input = basicRows();
  const original = structuredClone(input);
  const result = applyOperation(input, { type: 'trim_fields', fields: ['name'] });
  assert.equal(result.rows[0].name, 'Ada');
  assert.equal(result.rows[0].email, input[0].email);
  assert.deepEqual(input, original);
});

test('20 - normalize_email lowercases and trims only selected email fields', () => {
  const result = applyOperation(basicRows(), { type: 'normalize_email', fields: ['email'] });
  assert.equal(result.rows[0].email, 'ada@example.com');
  assert.equal(result.rows[0].name, '  Ada  ');
});

test('21 - dedupe_exact preserves the first row and distinguishes types', () => {
  const input = [{ a: 1, b: 'x' }, { b: 'x', a: 1 }, { a: '1', b: 'x' }];
  const result = applyOperation(input, { type: 'dedupe_exact' });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], input[0]);
  assert.equal(result.rows[1].a, '1');
});

test('22 - format_date requires explicit input and output formats', () => {
  const result = applyOperation([{ date: '31/01/2026' }], {
    type: 'format_date', fields: ['date'], inputFormat: 'DD/MM/YYYY', outputFormat: 'YYYY-MM-DD',
  });
  assert.equal(result.rows[0].date, '2026-01-31');
});

test('23 - invalid calendar dates and unspecified date formats fail closed', () => {
  expectCode(() => applyOperation([{ date: '31/02/2026' }], {
    type: 'format_date', fields: ['date'], inputFormat: 'DD/MM/YYYY', outputFormat: 'YYYY-MM-DD',
  }), 'DATE_VALUE_INVALID');
  expectCode(() => applyOperation([{ date: '01/02/2026' }], {
    type: 'format_date', fields: ['date'], inputFormat: 'AUTO', outputFormat: 'YYYY-MM-DD',
  }), 'DATE_FORMAT_UNSUPPORTED');
});

test('24 - locale-aware number parsing handles German and French separators', () => {
  const german = applyOperation([{ amount: '1.234,50' }], { type: 'normalize_number', fields: ['amount'], locale: 'de-DE' });
  const french = applyOperation([{ amount: '1\u202F234,50' }], { type: 'normalize_number', fields: ['amount'], locale: 'fr-FR' });
  assert.equal(german.rows[0].amount, 1234.5);
  assert.equal(french.rows[0].amount, 1234.5);
  expectCode(() => applyOperation([{ amount: '12,34,5' }], { type: 'normalize_number', fields: ['amount'], locale: 'de-DE' }), 'NUMBER_VALUE_INVALID');
});

test('25 - rename_fields is simultaneous and rejects destination collisions', () => {
  const result = applyOperation([{ first_name: 'Ada', last_name: 'Lovelace' }], {
    type: 'rename_fields', mapping: { first_name: 'given', last_name: 'family' },
  });
  assert.deepEqual(result.rows, [{ given: 'Ada', family: 'Lovelace' }]);
  expectCode(() => applyOperation([{ a: 1, b: 2 }], {
    type: 'rename_fields', mapping: { a: 'b' },
  }), 'RENAME_DESTINATION_COLLISION');
});

test('26 - empty_to_null affects selected blank fields only', () => {
  const result = applyOperation([{ note: '  ', name: '', untouched: ' ' }], {
    type: 'empty_to_null', fields: ['note', 'name'],
  });
  assert.deepEqual(result.rows, [{ note: null, name: null, untouched: ' ' }]);
});

test('27 - extract_json_paths adds requested values and rejects prototype paths', () => {
  const input = [{ customer: { email: 'ada@example.com' }, tags: ['a', 'b'] }];
  const result = applyOperation(input, {
    type: 'extract_json_paths', paths: { email: 'customer.email', secondTag: 'tags.1', missing: 'customer.phone' },
  });
  assert.deepEqual(result.rows, [{
    customer: { email: 'ada@example.com' }, tags: ['a', 'b'],
    email: 'ada@example.com', secondTag: 'b', missing: null,
  }]);
  expectCode(() => applyOperation(input, {
    type: 'extract_json_paths', paths: { unsafe: '__proto__.polluted' },
  }), 'JSON_PATH_UNSAFE');
});

test('28 - validate reports required/type errors without exposing cell values', () => {
  const rows = [{ email: '', age: 'private-value' }, { email: 'a@example.com', age: 7 }];
  const report = validateRows(rows, { requiredFields: ['email'], fieldTypes: { age: 'number' } });
  assert.equal(report.valid, false);
  assert.deepEqual(report.errors, [
    { row: 1, field: 'email', code: 'REQUIRED' },
    { row: 1, field: 'age', code: 'TYPE_MISMATCH' },
  ]);
  assert.equal(JSON.stringify(report).includes('private-value'), false);
});

test('29 - CSV/JSON conversion is explicit and round-trips synthetic records', () => {
  const source = 'name,email\nAda,ada@example.com\n';
  const toJson = executeCleaningJob(source, {
    inputFormat: 'csv',
    outputFormat: 'json',
    operations: [{ type: 'convert_format', to: 'json' }],
  });
  assert.equal(toJson.outputFormat, 'json');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(toJson.bytes)), [{ name: 'Ada', email: 'ada@example.com' }]);

  const toCsv = convertFormat(bytes('[{"name":"Ada","age":37}]'), { from: 'json', to: 'csv' });
  assert.equal(toCsv.rowCount, 1);
  assert.equal(new TextDecoder().decode(toCsv.bytes), 'name,age\r\nAda,37');
});

test('30 - 10,000-row CI benchmark records elapsed time and heap delta without file contents', () => {
  const lines = ['id,email,name'];
  for (let i = 1; i <= 10_000; i++) lines.push(i + ',USER' + i + '@EXAMPLE.COM, Name ' + i + ' ');
  const input = encoder.encode(lines.join('\n'));
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = executeCleaningJob(input, {
    inputFormat: 'csv',
    outputFormat: 'json',
    operations: [
      { type: 'trim_fields', fields: ['name'] },
      { type: 'normalize_email', fields: ['email'] },
      { type: 'convert_format', to: 'json' },
    ],
  });
  const elapsedMs = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(result.rowCount, 10_000);
  assert.equal(result.rows[0].email, 'user1@example.com');
  assert.equal(result.rows[9_999].name, 'Name 10000');
  assert.ok(result.byteLength > 0);
  console.log(
    'DATA_CLEANING_BENCHMARK rows=10000 input_bytes=' + input.byteLength +
    ' output_bytes=' + result.byteLength +
    ' elapsed_ms=' + elapsedMs.toFixed(3) +
    ' heap_before_bytes=' + heapBefore +
    ' heap_after_bytes=' + heapAfter +
    ' heap_delta_bytes=' + (heapAfter - heapBefore)
  );
});
