import test from 'node:test';
import assert from 'node:assert/strict';
import { redactWranglerOutput } from '../ops/scripts/redact-wrangler-output.mjs';

test('redacts known credentials, bearer values, account IDs and token-shaped strings', () => {
  const apiToken = 'cf_trial_test_secret_value_1234567890';
  const cleaningToken = 'cleaning_test_secret_value_abcdefghijklmnopqrstuvwxyz';
  const accountId = 'c46718094ced1f5f75492f4c67c7d390';
  const opaqueToken = 'A'.repeat(48);
  const raw = [
    'Error: Authentication failed',
    'Authorization: Bearer ' + apiToken,
    'CLEANING_API_TOKEN=' + cleaningToken,
    'account=' + accountId,
    'opaque=' + opaqueToken,
    'Error code: insufficient_permissions',
  ].join('\\n');

  const safe = redactWranglerOutput(raw, [apiToken, cleaningToken, accountId]);
  for (const secret of [apiToken, cleaningToken, accountId, opaqueToken]) {
    assert.equal(safe.includes(secret), false, 'sensitive value must not remain in output');
  }
  assert.match(safe, /Error: Authentication failed/);
  assert.match(safe, /Error code: insufficient_permissions/);
  assert.ok((safe.match(/\\*\\*\\*/g) || []).length >= 4);
});

test('preserves ordinary Wrangler diagnostics while masking 32-character hex identifiers', () => {
  const raw = '✘ [ERROR] Workers Scripts Write denied for account 0123456789abcdef0123456789abcdef';
  const safe = redactWranglerOutput(raw);
  assert.match(safe, /Workers Scripts Write denied/);
  assert.equal(safe.includes('0123456789abcdef0123456789abcdef'), false);
});
