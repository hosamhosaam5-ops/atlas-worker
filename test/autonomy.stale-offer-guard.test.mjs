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
