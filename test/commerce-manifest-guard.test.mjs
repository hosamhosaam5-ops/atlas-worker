import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActiveCommerceManifestRequest } from '../src/core/commerceManifestGuard.js';

test('active commerce manifest accepts only the currently approved offer values', () => {
  assert.deepEqual(normalizeActiveCommerceManifestRequest({}), {
    product_id: 'atlas_ai_data_qa_v1',
    price_usdc: 15,
  });
  assert.deepEqual(normalizeActiveCommerceManifestRequest({
    product_id: 'atlas_ai_data_qa_v1',
    price_usdc: 15,
  }), {
    product_id: 'atlas_ai_data_qa_v1',
    price_usdc: 15,
  });
  assert.throws(() => normalizeActiveCommerceManifestRequest({ product_id: 'other_product', price_usdc: 15 }), /COMMERCE_MANIFEST_OFFER_MISMATCH/);
  assert.throws(() => normalizeActiveCommerceManifestRequest({ product_id: 'atlas_ai_data_qa_v1', price_usdc: 99 }), /COMMERCE_MANIFEST_OFFER_MISMATCH/);
  assert.throws(() => normalizeActiveCommerceManifestRequest({ product_id: 'atlas_ai_data_qa_v1', price_usdc: 'NaN' }), /COMMERCE_MANIFEST_OFFER_MISMATCH/);
  assert.throws(() => normalizeActiveCommerceManifestRequest({ product_id: '', price_usdc: 15 }), /COMMERCE_MANIFEST_OFFER_MISMATCH/);
});
