import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommercialIntegration } from '../src/commercial/testHarness.js';

test('commercial integration harness refuses a DB without explicit isolated-CI markers', async () => {
  const db = {};
  await assert.rejects(
    runCommercialIntegration(db, { DB: db }, {}),
    { message: 'HARNESS_REQUIRES_ISOLATED_TEST_D1' }
  );
});

test('commercial integration harness refuses mismatched DB binding even with markers', async () => {
  const db = {};
  await assert.rejects(
    runCommercialIntegration(db, {
      DB: {},
      ATLAS_TEST_DB: '1',
      ATLAS_TEST_DB_ID: 'atlas-ci-isolated'
    }, {}),
    { message: 'HARNESS_REQUIRES_ISOLATED_TEST_D1' }
  );
});
