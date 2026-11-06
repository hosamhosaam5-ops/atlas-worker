import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { discoverCapabilities } from '../src/autonomy/engine.js';
import { ensureAutonomySchema } from '../src/autonomy/registry.js';

function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes || 0) } };
        },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
    },
    close() { sqlite.close(); },
    sqlite,
  };
  sqlite.exec(`
    CREATE TABLE demand_source_health (
      source TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'CLOSED',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT,
      next_probe_at TEXT,
      cooldown_ms INTEGER NOT NULL DEFAULT 900000,
      last_status INTEGER,
      last_error_code TEXT,
      last_success_at TEXT,
      last_attempt_at TEXT,
      last_http_status INTEGER,
      last_response_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const source = id => ({
  id, kind: 'marketplace', provider: id, protocol: 'API',
  endpoint: 'https://fixture.invalid/' + id, cost_class: 'free', risk: 'medium'
});

async function seedHealth(db, id, state, failures, nextProbeAt, cooldownMs = 900000) {
  db.sqlite.prepare(`
    INSERT INTO demand_source_health(source,state,consecutive_failures,next_probe_at,cooldown_ms)
    VALUES(?,?,?,?,?)
  `).run(id, state, failures, nextProbeAt, cooldownMs);
}

test('capability discovery skips OPEN and already-claimed HALF_OPEN sources and claims one due probe', async () => {
  const db = makeDb();
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  await ensureAutonomySchema(db);
  await seedHealth(db, 'open_not_due', 'OPEN', 3, new Date(now + 60_000).toISOString());
  await seedHealth(db, 'already_half_open', 'HALF_OPEN', 3, null);
  await seedHealth(db, 'due_open', 'OPEN', 3, new Date(now - 1_000).toISOString());

  const requested = [];
  const result = await discoverCapabilities(db, {
    sources: [source('open_not_due'), source('already_half_open'), source('due_open')],
    now,
    fetcher: async url => {
      requested.push(url);
      return { ok: true, status: 200, headers: {}, text: '{}', responseMs: 4 };
    },
  });

  assert.deepEqual(requested, ['https://fixture.invalid/due_open']);
  assert.equal(result.results.find(x => x.id === 'open_not_due').status, 'CIRCUIT_OPEN');
  assert.equal(result.results.find(x => x.id === 'already_half_open').status, 'CIRCUIT_OPEN');
  assert.equal(result.results.find(x => x.id === 'due_open').status, 'DISCOVERY');

  const openRow = await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('open_not_due').first();
  const halfRow = await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('already_half_open').first();
  const recoveredRow = await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('due_open').first();
  assert.equal(openRow.state, 'OPEN');
  assert.equal(halfRow.state, 'HALF_OPEN');
  assert.equal(recoveredRow.state, 'CLOSED');
  assert.equal(recoveredRow.consecutive_failures, 0);
  db.close();
});

test('capability discovery fails closed when source-health state cannot be read', async () => {
  let requests = 0;
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error('D1 health read unavailable'); },
      };
    },
  };
  const result = await discoverCapabilities(db, {
    sources: [source('health_unavailable')],
    fetcher: async () => { requests += 1; return { ok: true, status: 200, headers: {}, text: '{}' }; },
  });
  assert.equal(requests, 0);
  assert.equal(result.results[0].status, 'HEALTH_STORE_UNAVAILABLE');
});

test('a failed HALF_OPEN discovery probe reopens the circuit with backoff', async () => {
  const db = makeDb();
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  await ensureAutonomySchema(db);
  await seedHealth(db, 'network_failure', 'OPEN', 3, new Date(now - 1_000).toISOString());

  const result = await discoverCapabilities(db, {
    sources: [source('network_failure')],
    now,
    fetcher: async () => { throw new TypeError('fetch failed'); },
  });

  assert.equal(result.results[0].status, 'UNREACHABLE');
  const row = await db.prepare('SELECT * FROM demand_source_health WHERE source=?').bind('network_failure').first();
  assert.equal(row.state, 'OPEN');
  assert.equal(row.consecutive_failures, 4);
  assert.equal(row.cooldown_ms, 30 * 60 * 1000);
  assert.equal(row.last_error_code, 'NETWORK_ERROR');
  assert.equal(row.last_http_status, null);
  db.close();
});
