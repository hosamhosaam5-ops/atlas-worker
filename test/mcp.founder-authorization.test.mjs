import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFounderCanActivateProduct, assertFounderIdentity, hasFounderIdentity } from '../src/mcp/authorization.js';
import { isLocalX402TestMode } from '../src/core/runtimeFlags.js';
import { fetchReceipt } from '../src/orders/payment.js';
import { assertKnownPaymentProvider } from '../src/orders/intake.js';

const founderEnv = { FOUNDER_OAUTH_SUB: 'founder-sub-123' };
const founderCtx = { props: { login: 'founder-sub-123' } };
const otherCtx = { props: { login: 'other-sub-456' } };

test('founder identity matches only the configured OAuth subject', () => {
  assert.equal(hasFounderIdentity(founderCtx, founderEnv), true);
  assert.equal(hasFounderIdentity(otherCtx, founderEnv), false);
  assert.equal(hasFounderIdentity(founderCtx, {}), false);
  assert.throws(() => assertFounderIdentity(otherCtx, founderEnv), /FOUNDER_IDENTITY_REQUIRED/);
});

test('activating an MCP product requires founder identity; the paid Data-QA product also requires live adapters', () => {
  assert.throws(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'ACTIVE' }, otherCtx, founderEnv), /FOUNDER_IDENTITY_REQUIRED/);
  assert.throws(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'ACTIVE' }, founderCtx, founderEnv), /PAID_PAYMENT_PROVIDER_NOT_READY|PAID_WALLET_NOT_CONFIGURED|PAID_DELIVERY_PROVIDER_NOT_LIVE/);
  assert.throws(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'active' }, founderCtx, founderEnv), /PAID_PAYMENT_PROVIDER_NOT_READY|PAID_WALLET_NOT_CONFIGURED|PAID_DELIVERY_PROVIDER_NOT_LIVE/);
  const readyEnv = {
    ...founderEnv,
    PAYMENT_PROVIDER: 'BASE_RPC',
    ATLAS_WALLET_ADDRESS: '0x' + '1'.repeat(40),
    FILE_STORAGE: 'LOCAL',
    DB: {},
    EMAIL_PROVIDER: 'RESEND',
    RESEND_API_KEY: 'test-key-not-a-real-secret',
    EMAIL_FROM: 'atlas@example.invalid',
    EMAIL_DOMAIN_VERIFIED: '1',
  };
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'ACTIVE' }, founderCtx, readyEnv));
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ product_id: 'other_product', status: 'ACTIVE' }, founderCtx, founderEnv));
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'DRAFT' }, otherCtx, founderEnv));
  assert.doesNotThrow(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'PAUSED' }, otherCtx, founderEnv));
  assert.throws(() => assertFounderCanActivateProduct({ product_id: 'atlas_ai_data_qa_v1', status: 'ACTIVE' }, founderCtx, {}), /FOUNDER_IDENTITY_REQUIRED/);
});

test('X402 test mode requires both test flags and a loopback request URL', () => {
  const flags = { X402_TEST_MODE: '1', DEV_MODE: '1' };
  assert.equal(isLocalX402TestMode({ X402_TEST_MODE: '1' }), false);
  assert.equal(isLocalX402TestMode({ DEV_MODE: '1' }), false);
  assert.equal(isLocalX402TestMode(flags), false, 'flags without a request URL cannot enable test mode');
  assert.equal(isLocalX402TestMode(flags, 'http://127.0.0.1:8799/x402/atlas_ai_data_qa_v1'), true);
  assert.equal(isLocalX402TestMode(flags, 'http://localhost:8799/x402/atlas_ai_data_qa_v1'), true);
  assert.equal(isLocalX402TestMode(flags, 'http://worker.localhost:8799/x402/atlas_ai_data_qa_v1'), true);
  assert.equal(isLocalX402TestMode(flags, 'http://[::1]:8799/x402/atlas_ai_data_qa_v1'), true);
  assert.equal(isLocalX402TestMode(flags, 'https://atlas-worker.hosamhosaam5.workers.dev/x402/atlas_ai_data_qa_v1'), false);
  assert.equal(isLocalX402TestMode({ ...flags, X402_TEST_MODE: '0' }, 'http://127.0.0.1:8799/x402/atlas_ai_data_qa_v1'), false);
  assert.equal(isLocalX402TestMode({}, 'http://127.0.0.1:8799/x402/atlas_ai_data_qa_v1'), false);
});

test('payment receipt provider fails closed when PAYMENT_PROVIDER is missing', async () => {
  await assert.rejects(fetchReceipt({}, '0x' + '1'.repeat(64)), /PAYMENT_PROVIDER_REQUIRED/);
  await assert.rejects(fetchReceipt({ PAYMENT_PROVIDER: ' ' }, '0x' + '1'.repeat(64)), /PAYMENT_PROVIDER_REQUIRED/);
});

test('payment configuration is validated before transaction claims', () => {
  assert.throws(() => assertKnownPaymentProvider({}), /PAYMENT_PROVIDER_REQUIRED/);
  assert.throws(() => assertKnownPaymentProvider({ PAYMENT_PROVIDER: ' ' }), /PAYMENT_PROVIDER_REQUIRED/);
  assert.throws(() => assertKnownPaymentProvider({ PAYMENT_PROVIDER: 'UNKNOWN' }), /unknown PAYMENT_PROVIDER/);
  assert.doesNotThrow(() => assertKnownPaymentProvider({ PAYMENT_PROVIDER: 'MOCK' }));
  assert.doesNotThrow(() => assertKnownPaymentProvider({ PAYMENT_PROVIDER: 'BASE_RPC' }));
});

test('paid offer readiness fails closed when configuration is absent', async () => {
  const { getPaidOfferReadinessError } = await import('../src/core/paidOfferReadiness.js');
  assert.equal(getPaidOfferReadinessError({}), 'PAID_PAYMENT_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ PAYMENT_PROVIDER: 'BASE_RPC' }), 'PAID_WALLET_NOT_CONFIGURED');
  assert.equal(getPaidOfferReadinessError({ PAYMENT_PROVIDER: 'BASE_RPC', ATLAS_WALLET_ADDRESS: '0x' + '1'.repeat(40) }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  const validPayment = {
    PAYMENT_PROVIDER: 'BASE_RPC',
    ATLAS_WALLET_ADDRESS: '0x' + '1'.repeat(40),
    FILE_STORAGE: 'LOCAL',
    DB: {},
    EMAIL_PROVIDER: 'RESEND',
    RESEND_API_KEY: 'test-key',
    EMAIL_FROM: 'atlas@example.invalid',
    EMAIL_DOMAIN_VERIFIED: '1',
  };
  assert.equal(getPaidOfferReadinessError({ ...validPayment, EMAIL_PROVIDER: 'resend' }), 'PAID_DELIVERY_PROVIDER_NOT_LIVE');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, EMAIL_PROVIDER: ' RESEND ' }), 'PAID_DELIVERY_PROVIDER_NOT_LIVE');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, EMAIL_DOMAIN_VERIFIED: '0' }), 'PAID_EMAIL_DOMAIN_NOT_VERIFIED');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, EMAIL_DOMAIN_VERIFIED: undefined }), 'PAID_EMAIL_DOMAIN_NOT_VERIFIED');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, FILE_STORAGE: 'R2' }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, FILE_STORAGE: 'invalid' }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...validPayment, FILE_STORAGE: 'LOCAL', DB: null }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError(validPayment), null);
});

test('paid offer readiness rejects mock email, missing secrets, invalid wallet, unverified domain, and unavailable storage', async () => {
  const { getPaidOfferReadinessError } = await import('../src/core/paidOfferReadiness.js');
  const storage = { FILE_STORAGE: 'LOCAL', DB: {} };
  const wallet = '0x' + '1'.repeat(40);
  const sendConfig = {
    PAYMENT_PROVIDER: 'BASE_RPC',
    ATLAS_WALLET_ADDRESS: wallet,
    EMAIL_PROVIDER: 'RESEND',
    RESEND_API_KEY: 'test-key-not-a-real-secret',
    EMAIL_FROM: 'atlas@example.invalid',
    EMAIL_DOMAIN_VERIFIED: '1',
  };

  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, PAYMENT_PROVIDER: 'MOCK' }), 'PAID_PAYMENT_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, EMAIL_PROVIDER: 'MOCK' }), 'PAID_DELIVERY_PROVIDER_NOT_LIVE');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, ATLAS_WALLET_ADDRESS: 'bad' }), 'PAID_WALLET_NOT_CONFIGURED');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, EMAIL_DOMAIN_VERIFIED: '0' }), 'PAID_EMAIL_DOMAIN_NOT_VERIFIED');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, EMAIL_DOMAIN_VERIFIED: undefined }), 'PAID_EMAIL_DOMAIN_NOT_VERIFIED');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, RESEND_API_KEY: '' }), 'PAID_EMAIL_CONFIGURATION_REQUIRED');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, FILE_STORAGE: 'R2' }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig, FILE_STORAGE: 'invalid' }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...sendConfig, FILE_STORAGE: 'LOCAL', DB: null }), 'PAID_STORAGE_PROVIDER_NOT_READY');
  assert.equal(getPaidOfferReadinessError({ ...storage, ...sendConfig }), null);
});
