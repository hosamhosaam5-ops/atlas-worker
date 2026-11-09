import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInput, cleanInputPreview, MAX_FILE_BYTES, MAX_ROWS } from '../src/clean-v1/engine.js';

const csvRows = count => ['Full Name,Phone Number,Created Date,Note', ...Array.from({ length: count }, (_, i) => ` User ${i + 1} , +966 (50) 123-${String(i + 1).padStart(4,'0')} ,25/10/2025, hello   world `)].join('\n');

test('accepts exactly 10 and 200 CSV rows and rejects 201', () => {
  assert.equal(cleanInput(csvRows(10), 'csv').source_rows, 10);
  assert.equal(cleanInput(csvRows(200), 'csv').source_rows, 200);
  assert.throws(() => cleanInput(csvRows(201), 'csv'), e => e.code === 'ROW_LIMIT_EXCEEDED' && e.status === 413);
});

test('enforces the 100 KiB byte boundary', () => {
  assert.equal(MAX_FILE_BYTES, 102400);
  assert.equal(MAX_ROWS, 200);
  assert.throws(() => cleanInput(new Uint8Array(102401), 'csv'), e => e.code === 'FILE_SIZE_LIMIT_EXCEEDED' && e.status === 413);
});

test('normalizes headers, whitespace, phone numbers and unambiguous dates', () => {
  const result = cleanInput('Full Name,Phone Number,Created Date\n  Ada Lovelace  , +966 (50) 123-4567 ,25/10/2025', 'csv');
  assert.deepEqual(result.data, [{ full_name: 'Ada Lovelace', phone_number: '+966501234567', created_date: '2025-10-25' }]);
  assert.ok(result.changes.some(x => x.type === 'column_name_normalized'));
  assert.ok(result.changes.some(x => x.type === 'phone_normalized'));
  assert.ok(result.changes.some(x => x.type === 'date_normalized'));
});

test('does not guess ambiguous dates', () => {
  const result = cleanInput('created_date\n10/11/2025', 'csv');
  assert.equal(result.data[0].created_date, '10/11/2025');
  assert.ok(result.changes.some(x => x.type === 'date_not_normalized'));
});

test('removes duplicates only with an explicit change record', () => {
  const result = cleanInput('id,name\n1,Ada\n1,Ada\n2,Lin', 'csv');
  assert.equal(result.data.length, 2);
  assert.deepEqual(result.changes.find(x => x.type === 'duplicate_row_removed'), { type: 'duplicate_row_removed', row: 3, duplicate_of: 2 });
});

test('preserves malformed CSV rows with a stable diagnostic', () => {
  const result = cleanInput('a,b\n1,2\n3\n4,5,6', 'csv');
  assert.equal(result.data.length, 1);
  assert.deepEqual(result.malformed_rows.map(x => x.code), ['CSV_ROW_WIDTH_MISMATCH','CSV_ROW_WIDTH_MISMATCH']);
  assert.equal(result.malformed_rows[0].values[0], '3');
});

test('preserves malformed JSON rows rather than silently dropping them', () => {
  const result = cleanInput('[{"Name":"Ada"},null,7]', 'json');
  assert.equal(result.data.length, 1);
  assert.equal(result.malformed_rows.length, 2);
  assert.deepEqual(result.malformed_rows.map(x => x.row), [2,3]);
});

test('normalizes JSON object keys and string content', () => {
  const result = cleanInput('[{" First Name ":"  Ada   Lovelace  ","phone":"050-123-4567"}]', 'json');
  assert.deepEqual(result.data, [{ first_name: 'Ada Lovelace', phone: '0501234567' }]);
});


test('keeps colliding normalized JSON keys as unique columns', () => {
  const result = cleanInput('[{"First Name":"Ada","first_name":"Lovelace"}]', 'json');
  assert.deepEqual(result.data, [{ first_name: 'Ada', first_name_2: 'Lovelace' }]);
});

test('preview returns at most 10 cleaned rows while retaining source row total', () => {
  const preview = cleanInputPreview(csvRows(200), 'csv');
  assert.equal(preview.data.length, 10);
  assert.equal(preview.source_rows, 200);
  assert.equal(preview.truncated, true);
  assert.equal(preview.preview, true);
});

test('CSV supports quoted commas, escaped quotes, and embedded newlines', () => {
  const result = cleanInput('name,note\nAda,"one, two and ""three"""\nLin,"line one\nline two"', 'csv');
  assert.equal(result.data[0].note, 'one, two and "three"');
  assert.equal(result.data[1].note, 'line one line two');
});

test('rejects invalid UTF-8, invalid format, oversized input and malformed JSON with codes', () => {
  assert.throws(() => cleanInput(Uint8Array.of(0xc3,0x28), 'csv'), e => e.code === 'INVALID_ENCODING');
  assert.throws(() => cleanInput('{}', 'xml'), e => e.code === 'INPUT_FORMAT_UNSUPPORTED');
  assert.throws(() => cleanInput('{bad', 'json'), e => e.code === 'JSON_PARSE_FAILED');
});

test('uses stable codes and never propagates exception messages to public output', async () => {
  const { publicError } = await import('../src/clean-v1/engine.js');
  const result = publicError(new Error('private row content: alice@example.com'));
  assert.deepEqual(result, { code: 'INTERNAL_ERROR', status: 500 });
  assert.equal(JSON.stringify(result).includes('alice@example.com'), false);
});
