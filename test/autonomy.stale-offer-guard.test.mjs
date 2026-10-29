import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOffer } from '../src/autonomy/p1.js';

class OfferDb {
  constructor(status) {
    this.status = status;
    this.offerWrites = 0;
  }
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() {
        if (sql.includes('INSERT OR REPLACE INTO growth_actions')) db.offerWrites++;
        return { meta: { changes: 1 } };
      },
      async first() {
        if (sql.includes('FROM demand_signals WHERE id=?')) {
          return {
            id: 23,
            source: 'opentask_public_tasks',
            request_summary: 'Need CSV data validation and duplicate-row removal.',
            score: 0.9,
            status: db.status
          };
        }
        return null;
      }
    };
  }
}

test('prepareOffer refuses stale/unverified demand signals without creating an offer action', async () => {
  const db = new OfferDb('STALE_UNVERIFIED');
  await assert.rejects(
    prepareOffer(db, { signal_id: 23 }),
    /DEMAND_SIGNAL_NOT_QUALIFIED/
  );
  assert.equal(db.offerWrites, 0);
});

test('prepareOffer refuses new and missing qualification states', async () => {
  for (const status of ['NEW', 'STALE_UNVERIFIED', 'REJECTED']) {
    const db = new OfferDb(status);
    await assert.rejects(
      prepareOffer(db, { signal_id: 23 }),
      /DEMAND_SIGNAL_NOT_QUALIFIED/
    );
    assert.equal(db.offerWrites, 0);
  }
});


import { negotiateOffer } from '../src/autonomy/p1.js';

class StaleNegotiationDb {
  constructor() { this.offerWrites = 0; }
  prepare(sql) {
    const db = this;
    return {
      bind() { return this; },
      async run() { db.offerWrites++; return { meta: { changes: 1 } }; },
      async first() {
        if (sql.includes('FROM growth_actions WHERE action_key=?')) {
          return { action_type: 'QUALIFIED_LEAD', target_id: '23', payload_json: JSON.stringify({ price_usdc: 50 }) };
        }
        if (sql.includes('SELECT status FROM demand_signals WHERE id=?')) return { status: 'STALE_UNVERIFIED' };
        return null;
      }
    };
  }
}

test('negotiateOffer rechecks live demand status and refuses stale qualified-lead actions', async () => {
  const db = new StaleNegotiationDb();
  await assert.rejects(
    negotiateOffer(db, { action_key: 'qualify|stale-fixture', counter_price_usdc: 40 }),
    /DEMAND_SIGNAL_NOT_QUALIFIED/
  );
  assert.equal(db.offerWrites, 0);
});
