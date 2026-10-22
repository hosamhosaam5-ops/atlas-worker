import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDemandEvents } from '../src/crons/revenueWatch.js';

const bounty = (id, overrides = {}) => ({
  object: 'bounty',
  id,
  title: 'Summarise public market data',
  budget_display: 'up to 5.000000 USDC',
  buyer: { id: 'buyer-third-party', handle: 'customer-agent', first_party: false },
  ...overrides,
});

function eventsFor(souk, state = []) {
  return detectDemandEvents({ souk, dp: {}, bb: {}, state })
    .filter(item => item.item_type === 'event');
}

test('AgentSouk demand alerts are keyed by stable bounty ID, not result count', () => {
  const result = eventsFor({
    object: 'list',
    data: [bounty('bty_FIRST'), bounty('bty_SECOND')],
    has_more: false,
    next_cursor: null,
  });

  assert.deepEqual(result.map(event => event.alert_key), [
    'watch|souk|bty_FIRST',
    'watch|souk|bty_SECOND',
  ]);
  assert.match(result[0].detail, /bty_FIRST: Summarise public market data/);
  assert.match(result[0].detail, /up to 5\.000000 USDC/);
});

test('AgentSouk does not alert again for a bounty with a persisted delivery key', () => {
  const result = eventsFor({
    data: [bounty('bty_ALREADY_SENT'), bounty('bty_NEW')],
  }, [
    { idempotency_key: 'watch|alerted|watch|souk|bty_ALREADY_SENT', status: 'SENT' },
  ]);

  assert.deepEqual(result.map(event => event.alert_key), ['watch|souk|bty_NEW']);
});

test('AgentSouk fails closed for first-party and unverified buyer status', () => {
  const result = eventsFor({
    data: [
      bounty('bty_PLATFORM', { buyer: { id: 'platform', first_party: true } }),
      bounty('bty_UNKNOWN', { buyer: { id: 'unknown' } }),
      bounty('bty_NO_BUYER', { buyer: undefined }),
      bounty('bty_THIRD_PARTY'),
    ],
  });

  assert.deepEqual(result.map(event => event.alert_key), ['watch|souk|bty_THIRD_PARTY']);
});
