import test from 'node:test';
import assert from 'node:assert/strict';
import validateAgentContract from '../src/autonomy/contractGate.js';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

const workflowSchema = {
  $schema: DRAFT,
  type: 'object',
  properties: {
    agent_id: { type: 'string', minLength: 1, maxLength: 80 },
    status: { type: 'string', enum: ['ok', 'failed'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          count: { type: 'integer', minimum: 0 },
        },
        required: ['id', 'count'],
        additionalProperties: false,
      },
    },
  },
  required: ['agent_id', 'status', 'score'],
  additionalProperties: false,
};

test('agent contract gate passes valid JSON using only local deterministic validation', () => {
  const result = validateAgentContract(JSON.stringify({
    agent_id: 'agent-qa',
    status: 'ok',
    score: 0.75,
    rows: [{ id: 'a', count: 2 }, { id: 'b', count: 3 }],
  }), workflowSchema);

  assert.equal(result.contract_version, 'atlas.agent-contract.v1');
  assert.equal(result.validation_status, 'PASS');
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.issue_limit_reached, false);
});

test('returns stable path-specific issues for missing, extra, enum, numeric, and nested type violations', () => {
  const result = validateAgentContract(JSON.stringify({
    agent_id: '',
    status: 'surprise',
    score: 1.5,
    extra: 'must not be echoed',
    rows: [{ id: 'r1', count: 'PRIVATE_RAW_VALUE' }],
  }), workflowSchema);

  assert.equal(result.validation_status, 'FAIL');
  const codes = result.issues.map(x => x.rule_id);
  assert.ok(codes.includes('MIN_LENGTH'));
  assert.ok(codes.includes('ENUM_MISMATCH'));
  assert.ok(codes.includes('MAXIMUM'));
  assert.ok(codes.includes('ADDITIONAL_PROPERTY'));
  assert.ok(codes.includes('TYPE_MISMATCH'));
  assert.ok(result.issues.some(x => x.path === '/rows/0/count'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RAW_VALUE'));
  assert.ok(!JSON.stringify(result).includes('must not be echoed'));
});

test('does not treat absent required properties as null or accept an invalid primitive type', () => {
  const result = validateAgentContract('{"status":"ok","score":"0.5"}', workflowSchema);

  assert.equal(result.validation_status, 'FAIL');
  assert.ok(result.issues.some(x => x.rule_id === 'REQUIRED_PROPERTY_MISSING' && x.path === '/agent_id'));
  assert.ok(result.issues.some(x => x.rule_id === 'TYPE_MISMATCH' && x.path === '/score'));
});

test('escapes JSON Pointer property names for machine-readable error locations', () => {
  const schema = {
    type: 'object',
    properties: { 'a/b~c': { type: 'integer' } },
    required: ['a/b~c'],
    additionalProperties: false,
  };
  const result = validateAgentContract('{"a/b~c":"wrong"}', schema);
  assert.equal(result.validation_status, 'FAIL');
  assert.ok(result.issues.some(x => x.path === '/a~1b~0c'));
});

test('duplicate array values fail only when uniqueItems is explicitly requested', () => {
  const schema = { type: 'array', items: { type: 'integer' }, uniqueItems: true };
  const result = validateAgentContract('[1,1,2]', schema);
  assert.equal(result.validation_status, 'FAIL');
  assert.ok(result.issues.some(x => x.rule_id === 'DUPLICATE_ITEM' && x.path === '/1'));
});

test('rejects malformed JSON and does not echo parser input', () => {
  const input = '{"token":"very-secret-value",';
  const result = validateAgentContract(input, { type: 'object' });
  assert.equal(result.validation_status, 'INVALID_JSON');
  assert.ok(!JSON.stringify(result).includes('very-secret-value'));
});

test('rejects non-text values and enforces the input byte limit', () => {
  assert.equal(validateAgentContract({ ok: true }, { type: 'object' }).validation_status, 'REJECTED_INPUT');
  const large = validateAgentContract(JSON.stringify({ value: 'x'.repeat(200) }), { type: 'object' }, { maxInputBytes: 50 });
  assert.equal(large.validation_status, 'REJECTED_INPUT');
  assert.equal(large.issues[0].rule_id, 'INPUT_TOO_LARGE');
});

test('rejects unsupported JSON Schema features instead of silently ignoring them or dereferencing them', () => {
  const unsupported = validateAgentContract(
    '{"id":"x"}',
    { $ref: 'https://example.invalid/schema.json', type: 'object' },
  );
  assert.equal(unsupported.validation_status, 'INVALID_CONTRACT');
  assert.ok(unsupported.issues.some(x => x.rule_id === 'SCHEMA_UNSUPPORTED_KEYWORD'));
  assert.ok(!JSON.stringify(unsupported).includes('example.invalid'));

  const pattern = validateAgentContract('"not-a-number"', { type: 'string', pattern: '^[0-9]+$' });
  assert.equal(pattern.validation_status, 'INVALID_CONTRACT');
});

test('rejects contracts with invalid keyword combinations and undeclared required properties', () => {
  const invalid = validateAgentContract('{}', {
    type: 'object',
    properties: { count: { type: 'string', minimum: 0 } },
    required: ['missing'],
  });
  assert.equal(invalid.validation_status, 'INVALID_CONTRACT');
  assert.ok(invalid.issues.some(x => x.rule_id === 'SCHEMA_KEYWORD_TYPE_MISMATCH'));
  assert.ok(invalid.issues.some(x => x.rule_id === 'SCHEMA_REQUIRED_PROPERTY_UNDECLARED'));
});

test('reports issue truncation deterministically under a caller-selected cap', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'integer' },
      b: { type: 'integer' },
      c: { type: 'integer' },
    },
    additionalProperties: false,
  };
  const result = validateAgentContract('{"a":"x","b":"y","c":"z"}', schema, { maxIssues: 2 });
  assert.equal(result.validation_status, 'FAIL');
  assert.equal(result.issues.length, 2);
  assert.equal(result.issue_limit_reached, true);
});

test('rejects arrays without an explicit item schema and invalid limit ranges', () => {
  const noItems = validateAgentContract('[]', { type: 'array' });
  assert.equal(noItems.validation_status, 'INVALID_CONTRACT');
  assert.ok(noItems.issues.some(x => x.rule_id === 'SCHEMA_ITEMS_REQUIRED'));

  const inverted = validateAgentContract('"hello"', { type: 'string', minLength: 6, maxLength: 2 });
  assert.equal(inverted.validation_status, 'INVALID_CONTRACT');
  assert.ok(inverted.issues.some(x => x.rule_id === 'SCHEMA_INVERTED_LIMITS'));
});

test('produces deterministic reports for identical input and contract', () => {
  const input = '{"status":"bad","score":4}';
  const a = validateAgentContract(input, workflowSchema);
  const b = validateAgentContract(input, workflowSchema);
  assert.deepEqual(a, b);
});


test('rejects exponent overflow that JSON.parse maps to a non-finite number', () => {
  const result = validateAgentContract('1e999', { type: 'number' });
  assert.equal(result.validation_status, 'REJECTED_INPUT');
  assert.equal(result.issues[0].rule_id, 'NON_FINITE_NUMBER');
});

test('rejects excessive payload depth and node count before recursive validation', () => {
  const deep = JSON.stringify({ a: { b: { c: { d: 1 } } } });
  const depthResult = validateAgentContract(deep, { type: 'object' }, { maxDepth: 2 });
  assert.equal(depthResult.validation_status, 'REJECTED_INPUT');
  assert.equal(depthResult.issues[0].rule_id, 'PAYLOAD_MAX_DEPTH');

  const nodeResult = validateAgentContract('[1,2,3,4]', { type: 'array', items: { type: 'integer' } }, { maxPayloadNodes: 3 });
  assert.equal(nodeResult.validation_status, 'REJECTED_INPUT');
  assert.equal(nodeResult.issues[0].rule_id, 'PAYLOAD_TOO_COMPLEX');
});
