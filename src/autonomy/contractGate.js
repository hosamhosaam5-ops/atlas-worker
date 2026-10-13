// ATLAS Agent Contract Gate — isolated prototype, not wired into production routes.
// This validates JSON text against an intentionally small, explicit JSON Schema subset.
// It does NOT claim full JSON Schema conformance and has no network, database, or LLM calls.

const CONTRACT_VERSION = 'atlas.agent-contract.v1';
const JSON_SCHEMA_2020 = 'https://json-schema.org/draft/2020-12/schema';
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ALLOWED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
]);
const META_KEYWORDS = new Set(['$schema', '$id', 'title', 'description']);
const DEFAULTS = Object.freeze({ maxInputBytes: 262144, maxIssues: 100, maxDepth: 32, maxSchemaNodes: 1000, maxPayloadNodes: 10000 });

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function pointerEscape(part) {
  return String(part).replace(/~/g, '~0').replace(/\//g, '~1').slice(0, 128);
}

function pathChild(path, part) {
  const next = path + '/' + pointerEscape(part);
  return next.length <= 512 ? next : next.slice(0, 509) + '...';
}

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? 'integer' : 'number') : 'unsupported';
  if (isRecord(value)) return 'object';
  return 'unsupported';
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return stableJson(a) === stableJson(b);
}

function inspectPayloadShape(payload, limits) {
  const stack = [{ value: payload, path: '', depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > limits.maxPayloadNodes) {
      return { rule_id: 'PAYLOAD_TOO_COMPLEX', path: current.path, message: 'Input exceeds the configured JSON node limit.' };
    }
    if (current.depth > limits.maxDepth) {
      return { rule_id: 'PAYLOAD_MAX_DEPTH', path: current.path, message: 'Input exceeds the configured nesting depth.' };
    }
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      return { rule_id: 'NON_FINITE_NUMBER', path: current.path, message: 'JSON number is outside the supported finite-number range.' };
    }
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i--) {
        stack.push({ value: current.value[i], path: pathChild(current.path, i), depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      const keys = Object.keys(current.value).sort();
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        stack.push({ value: current.value[key], path: pathChild(current.path, key), depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function addIssue(issues, maxIssues, ruleId, path, message, extras = {}) {
  if (issues.length >= maxIssues) return false;
  issues.push({ rule_id: ruleId, path: path || '', message, ...extras });
  return true;
}

function inspectSchema(schema, path, depth, state) {
  const { issues, maxIssues, maxDepth, maxSchemaNodes } = state;
  state.nodes += 1;
  if (state.nodes > maxSchemaNodes) {
    addIssue(issues, maxIssues, 'SCHEMA_TOO_COMPLEX', path, 'Contract exceeds the supported schema complexity limit.');
    return;
  }
  if (depth > maxDepth) {
    addIssue(issues, maxIssues, 'SCHEMA_MAX_DEPTH', path, 'Contract exceeds the supported nesting depth.');
    return;
  }
  if (!isRecord(schema)) {
    addIssue(issues, maxIssues, 'SCHEMA_NOT_OBJECT', path, 'Each schema node must be a JSON object.');
    return;
  }

  for (const key of Object.keys(schema).sort()) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      addIssue(issues, maxIssues, 'SCHEMA_UNSUPPORTED_KEYWORD', pathChild(path, key), 'Contract uses a keyword that this prototype does not support.');
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, '$schema') && schema.$schema !== JSON_SCHEMA_2020) {
    addIssue(issues, maxIssues, 'SCHEMA_UNSUPPORTED_DRAFT', pathChild(path, '$schema'), 'Only the JSON Schema 2020-12 dialect marker is accepted.');
  }
  if (Object.prototype.hasOwnProperty.call(schema, '$id') && typeof schema.$id !== 'string') {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_ID', pathChild(path, '$id'), 'The schema identifier must be a string.');
  }

  const type = schema.type;
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_TYPE', pathChild(path, 'type'), 'A supported single type is required.');
  }

  const objectKeywords = ['properties', 'required', 'additionalProperties'];
  for (const keyword of objectKeywords) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && type !== 'object') {
      addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, keyword), 'This keyword is supported only for object schemas.');
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'items') && type !== 'array') {
    addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, 'items'), 'The items keyword is supported only for array schemas.');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'uniqueItems') && type !== 'array') {
    addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, 'uniqueItems'), 'uniqueItems requires an array schema.');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_UNIQUE_ITEMS', pathChild(path, 'uniqueItems'), 'uniqueItems must be a boolean.');
  }
  if (type === 'array' && !Object.prototype.hasOwnProperty.call(schema, 'items')) {
    addIssue(issues, maxIssues, 'SCHEMA_ITEMS_REQUIRED', pathChild(path, 'items'), 'Array contracts must declare an items schema.');
  }
  for (const keyword of ['minimum', 'maximum']) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && !['number', 'integer'].includes(type)) {
      addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, keyword), 'Numeric limits require a number or integer schema.');
    }
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && (!Number.isFinite(schema[keyword]) || typeof schema[keyword] !== 'number')) {
      addIssue(issues, maxIssues, 'SCHEMA_INVALID_LIMIT', pathChild(path, keyword), 'Numeric limits must be finite numbers.');
    }
  }
  for (const keyword of ['minLength', 'maxLength']) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && type !== 'string') {
      addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, keyword), 'Length limits require a string schema.');
    }
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)) {
      addIssue(issues, maxIssues, 'SCHEMA_INVALID_LIMIT', pathChild(path, keyword), 'Length limits must be non-negative integers.');
    }
  }
  for (const keyword of ['minItems', 'maxItems']) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && type !== 'array') {
      addIssue(issues, maxIssues, 'SCHEMA_KEYWORD_TYPE_MISMATCH', pathChild(path, keyword), 'Item-count limits require an array schema.');
    }
    if (Object.prototype.hasOwnProperty.call(schema, keyword) && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)) {
      addIssue(issues, maxIssues, 'SCHEMA_INVALID_LIMIT', pathChild(path, keyword), 'Item-count limits must be non-negative integers.');
    }
  }
  if (Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum) && schema.minimum > schema.maximum) {
    addIssue(issues, maxIssues, 'SCHEMA_INVERTED_LIMITS', path, 'The minimum cannot exceed the maximum.');
  }
  if (Number.isInteger(schema.minLength) && Number.isInteger(schema.maxLength) && schema.minLength > schema.maxLength) {
    addIssue(issues, maxIssues, 'SCHEMA_INVERTED_LIMITS', path, 'The minimum cannot exceed the maximum.');
  }
  if (Number.isInteger(schema.minItems) && Number.isInteger(schema.maxItems) && schema.minItems > schema.maxItems) {
    addIssue(issues, maxIssues, 'SCHEMA_INVERTED_LIMITS', path, 'The minimum cannot exceed the maximum.');
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'enum') &&
      (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_ENUM', pathChild(path, 'enum'), 'Enum must be a non-empty array.');
  }
  if (type === 'object' && Object.prototype.hasOwnProperty.call(schema, 'properties') && !isRecord(schema.properties)) {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_PROPERTIES', pathChild(path, 'properties'), 'Properties must be a JSON object.');
  }
  if (type === 'object' && Object.prototype.hasOwnProperty.call(schema, 'required') &&
      (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string') ||
       new Set(schema.required).size !== schema.required.length)) {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_REQUIRED', pathChild(path, 'required'), 'Required must be an array of unique property names.');
  }
  if (type === 'object' && Object.prototype.hasOwnProperty.call(schema, 'additionalProperties') &&
      typeof schema.additionalProperties !== 'boolean') {
    addIssue(issues, maxIssues, 'SCHEMA_INVALID_ADDITIONAL_PROPERTIES', pathChild(path, 'additionalProperties'), 'additionalProperties must be true or false in this prototype.');
  }

  if (type === 'object' && isRecord(schema.properties)) {
    for (const key of Object.keys(schema.properties).sort()) {
      inspectSchema(schema.properties[key], pathChild(pathChild(path, 'properties'), key), depth + 1, state);
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          addIssue(issues, maxIssues, 'SCHEMA_REQUIRED_PROPERTY_UNDECLARED', pathChild(path, 'required'), 'Every required property must be declared in properties.');
        }
      }
    }
  }
  if (type === 'array' && Object.prototype.hasOwnProperty.call(schema, 'items')) {
    inspectSchema(schema.items, pathChild(path, 'items'), depth + 1, state);
  }
}

function validateValue(value, schema, path, depth, state) {
  if (state.issues.length >= state.maxIssues) {
    state.truncated = true;
    return;
  }
  if (depth > state.maxDepth) {
    addIssue(state.issues, state.maxIssues, 'PAYLOAD_MAX_DEPTH', path, 'Value exceeds the supported nesting depth.');
    return;
  }
  const type = schema.type;
  const actual = actualType(value);
  const typeMatches = type === actual ||
    (type === 'number' && actual === 'integer');
  if (!typeMatches) {
    addIssue(state.issues, state.maxIssues, 'TYPE_MISMATCH', path, 'Value does not match the declared type.', {
      expected_type: type,
      actual_type: actual,
    });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'enum') &&
      Array.isArray(schema.enum) && !schema.enum.some(item => deepEqual(value, item))) {
    addIssue(state.issues, state.maxIssues, 'ENUM_MISMATCH', path, 'Value is not one of the permitted choices.');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    addIssue(state.issues, state.maxIssues, 'CONST_MISMATCH', path, 'Value does not match the required constant.');
  }

  if (type === 'object') {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of [...required].sort()) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        addIssue(state.issues, state.maxIssues, 'REQUIRED_PROPERTY_MISSING', pathChild(path, key), 'A required property is missing.');
      }
    }
    for (const key of Object.keys(value).sort()) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateValue(value[key], properties[key], pathChild(path, key), depth + 1, state);
      } else if (schema.additionalProperties === false) {
        addIssue(state.issues, state.maxIssues, 'ADDITIONAL_PROPERTY', pathChild(path, key), 'Property is not declared by the contract.');
      }
    }
  } else if (type === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      addIssue(state.issues, state.maxIssues, 'MIN_ITEMS', path, 'Array contains fewer items than required.', { minimum: schema.minItems });
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      addIssue(state.issues, state.maxIssues, 'MAX_ITEMS', path, 'Array contains more items than allowed.', { maximum: schema.maxItems });
    }
    const seen = new Set();
    for (let i = 0; i < value.length; i++) {
      if (schema.uniqueItems === true) {
        const fingerprint = stableJson(value[i]);
        if (seen.has(fingerprint)) addIssue(state.issues, state.maxIssues, 'DUPLICATE_ITEM', pathChild(path, i), 'Array item duplicates an earlier item.');
        seen.add(fingerprint);
      }
      validateValue(value[i], schema.items, pathChild(path, i), depth + 1, state);
    }
  } else if (type === 'string') {
    const length = Array.from(value).length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) {
      addIssue(state.issues, state.maxIssues, 'MIN_LENGTH', path, 'String is shorter than required.', { minimum: schema.minLength });
    }
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
      addIssue(state.issues, state.maxIssues, 'MAX_LENGTH', path, 'String is longer than allowed.', { maximum: schema.maxLength });
    }
  } else if (type === 'number' || type === 'integer') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      addIssue(state.issues, state.maxIssues, 'MINIMUM', path, 'Number is below the permitted minimum.', { minimum: schema.minimum });
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      addIssue(state.issues, state.maxIssues, 'MAXIMUM', path, 'Number exceeds the permitted maximum.', { maximum: schema.maximum });
    }
  }
}

function report(status, issues, extras = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    validation_status: status,
    valid: status === 'PASS',
    issues,
    ...extras,
  };
}

/**
 * Validate JSON text at an agent/tool boundary.
 *
 * Supported keywords: type, properties, required, additionalProperties (boolean),
 * items, enum, const, minimum/maximum, minLength/maxLength, minItems/maxItems, uniqueItems.
 * Unknown keywords, $ref, and combinators are rejected as unsupported; this is not
 * a general JSON Schema validator. Raw values are never included in the report.
 */
export function validateAgentContract(jsonText, schema, options = {}) {
  const limits = {
    maxInputBytes: clampInteger(options.maxInputBytes, 1, 1048576, DEFAULTS.maxInputBytes),
    maxIssues: clampInteger(options.maxIssues, 1, 500, DEFAULTS.maxIssues),
    maxDepth: clampInteger(options.maxDepth, 1, 64, DEFAULTS.maxDepth),
    maxSchemaNodes: clampInteger(options.maxSchemaNodes, 1, 5000, DEFAULTS.maxSchemaNodes),
    maxPayloadNodes: clampInteger(options.maxPayloadNodes, 1, 100000, DEFAULTS.maxPayloadNodes),
  };
  if (typeof jsonText !== 'string') {
    return report('REJECTED_INPUT', [{ rule_id: 'JSON_TEXT_REQUIRED', path: '', message: 'Input must be serialized JSON text.' }]);
  }
  const byteLength = new TextEncoder().encode(jsonText).byteLength;
  if (byteLength > limits.maxInputBytes) {
    return report('REJECTED_INPUT', [{ rule_id: 'INPUT_TOO_LARGE', path: '', message: 'Input exceeds the configured byte limit.' }], { input_bytes: byteLength });
  }

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return report('INVALID_JSON', [{ rule_id: 'JSON_PARSE_ERROR', path: '', message: 'Input is not valid JSON.' }], { input_bytes: byteLength });
  }

  const payloadIssue = inspectPayloadShape(payload, limits);
  if (payloadIssue) {
    return report('REJECTED_INPUT', [payloadIssue], { input_bytes: byteLength });
  }

  const schemaIssues = [];
  const schemaState = { issues: schemaIssues, maxIssues: limits.maxIssues, maxDepth: limits.maxDepth, maxSchemaNodes: limits.maxSchemaNodes, nodes: 0 };
  inspectSchema(schema, '', 0, schemaState);
  if (schemaIssues.length) {
    return report('INVALID_CONTRACT', schemaIssues, { input_bytes: byteLength, issue_limit_reached: schemaIssues.length >= limits.maxIssues });
  }

  const state = { issues: [], maxIssues: limits.maxIssues, maxDepth: limits.maxDepth, truncated: false };
  validateValue(payload, schema, '', 0, state);
  if (state.issues.length >= state.maxIssues) state.truncated = true;
  return report(state.issues.length === 0 ? 'PASS' : 'FAIL', state.issues, {
    input_bytes: byteLength,
    issue_limit_reached: state.truncated,
  });
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
