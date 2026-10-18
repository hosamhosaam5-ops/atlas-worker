import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFounderCanActivateProduct, assertFounderIdentity, hasFounderIdentity } from '../src/mcp/authorization.js';
import { isLocalX402TestMode } from '../src/core/runtimeFlags.js';
import { fetchReceipt } from '../src/orders/payment.js';

const founderEnv = { FOUNDER_OAUTH_SUB: 'founder-sub-123' };
const founderCtx = { props: { login: 'founder-sub-123' } };
const otherCtx = { props: { login: 'other-sub-456' } };

test('founder identity matches only the configured OAuth subject', () => {
  assert.equal(hasFounderIdentity(founderCtx, founderEnv), true);
  assert.equal(hasFounderIdentity(otherCtx, founderEnv), false);
  assert.equal(hasFounderIdentity(founderCtx, {}), false);
  assert.throws(() => assertFounderIdentity(otherCtx, founderEnv), /FOUNDER_IDENTITY_REQUIRED/);
});

test('activating an MCP product requires the founder identity; draft and paused edits remain available to writers', () => {
  assert.throws(() => assertFounderCanActivateProduct({ status: 'ACTIVE' }, otherCtx, founderEnv), /FOUNDER_IDENTITY_REQUIRED/);
  assert.throws(() => assertFounderCanActivateProduct({ status: 'active' }, otherCtx, founderEnv), /FOUNDER_IDENTITY_REQUIRED/);
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ status: 'ACTIVE' }, founderCtx, founderEnv));
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ status: 'DRAFT' }, otherCtx, founderEnv));
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ status: 'PAUSED' }, otherCtx, founderEnv));
  assert.throws(() => assertFounderCanActivateProduct({ status: 'ACTIVE' }, founderCtx, {}), /FOUNDER_IDENTITY_REQUIRED/);
});

test('X402 test mode is disabled unless both explicit local-test flags are set', () => {
  assert.equal(isLocalX402TestMode({ X402_TEST_MODE: '1' }), false);
  assert.equal(isLocalX402TestMode({ DEV_MODE: '1' }), false);
  assert.equal(isLocalX402TestMode({ X402_TEST_MODE: '1', DEV_MODE: '1' }), true);
  assert.equal(isLocalX402TestMode({ X402_TEST_MODE: '0', DEV_MODE: '1' }), false);
  assert.equal(isLocalX402TestMode({}), false);
});

test('payment receipt provider fails closed when PAYMENT_PROVIDER is missing', async () => {
  await assert.rejects(fetchReceipt({}, '0x' + '1'.repeat(64)), /PAYMENT_PROVIDER_REQUIRED/);
  await assert.rejects(fetchReceipt({ PAYMENT_PROVIDER: ' ' }, '0x' + '1'.repeat(64)), /PAYMENT_PROVIDER_REQUIRED/);
});
