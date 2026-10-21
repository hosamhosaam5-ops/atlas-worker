// M3 cron idempotency test — runs against a REAL local D1 (miniflare via wrangler's local state).
// Uses better-sqlite3? No — uses wrangler d1 execute? No — uses miniflare's D1 via wrangler dev.
// Simplest reliable path: drive the cron runners against miniflare D1 through a wrangler dev
// instance exposing a dev-only /dev/cron endpoint? That would add production surface.
// Instead: miniflare's D1 is a SQLite file under .wrangler/state — we talk to it via
// wrangler d1 execute for assertions, and run the cron logic here with a thin D1-like
// adapter that proxies to the same SQLite through node's child process? Too fragile.
//
// Decision (documented): cron runners are pure logic over adapters + a D1 binding.
// We test them here against an in-memory D1-compatible stub implementing
// prepare/bind/first/all/run with SQLite semantics via node:sqlite (built-in).
import { DatabaseSync } from 'node:sqlite';
import { runDailyReport } from '../src/crons/dailyReport.js';
import { runTelegraphMonitor } from '../src/crons/telegraphMonitor.js';
import { runRevenueWatch } from '../src/crons/revenueWatch.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const failures = [];
function T(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

// --- Minimal D1 binding shim over node:sqlite (same prepare/bind/run/first/all surface) ---
function makeD1(dbfile) {
  const db = new DatabaseSync(dbfile);
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: r.lastInsertRowid } }; },
            async first() { return db.prepare(sql).get(...args) ?? null; },
            async all() { return { results: db.prepare(sql).all(...args) }; },
          };
        },
      };
    },
  };
}

const env = { DB: makeD1('/tmp/atlas-m3-cron.sqlite'), FOUNDER_CHAT_ID: 'test-founder-chat' };
for (const f of ['schema.sql', 'schema-m2.sql', 'schema-m3.sql']) {
  // strip -- comments before splitting on ';' (comments may contain semicolons)
  const sql = readFileSync(new URL('../' + f, import.meta.url)).toString()
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  for (const stmt of sql.split(';')) { const s = stmt.trim(); if (s) env.DB.prepare(s).bind().run(); }
}

const mockDelivery = (() => { let mid = 1000; const calls = []; return { calls, async send(chatId, text, opts) { calls.push({ chatId, text: text.slice(0, 60), opts }); return { message_id: ++mid }; } }; })();

// fixtures
const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const adapters = {
  async loadExecutionState() { const { results } = await env.DB.prepare('SELECT * FROM execution_state').bind().all(); return results; },
  async loadZatcaRequests() { return [{ request_key: 'rk-fixture-1', qualified: 'yes', submitted_at: today + 'T08:00:00', attr_source: 'telegraph' }]; },
  async loadPublications() { return []; },
  async loadAcquisitionAssets() { return []; },
  async loadChannelWatch() { return []; },
};

// ---- Daily report: run twice, second run must be SKIPPED_ALREADY_SENT, no dup rows ----
const r1 = await runDailyReport(env, adapters, mockDelivery);
T('daily first run SENT', r1.status === 'SENT' && r1.chunks_sent >= 1, JSON.stringify(r1));
const r2 = await runDailyReport(env, adapters, mockDelivery);
T('daily second run SKIPPED_ALREADY_SENT (idempotent)', r2.status === 'SKIPPED_ALREADY_SENT');
const reportRows = await env.DB.prepare("SELECT COUNT(*) c FROM execution_state WHERE idempotency_key = ?").bind('report|' + today).all();
T('daily exactly one report row in D1', reportRows.results[0].c === 1);

// Concurrent duplicate delivery regression: remove today's test row, race two cron calls,
// and prove only the atomic claimant invokes Telegram.
await env.DB.prepare("DELETE FROM execution_state WHERE idempotency_key = ?").bind('report|' + today).run();
const callsBeforeRace = mockDelivery.calls.length;
const raced = await Promise.all([
  runDailyReport(env, adapters, mockDelivery),
  runDailyReport(env, adapters, mockDelivery),
]);
T('concurrent daily report: exactly one sender wins',
  raced.filter(r => r.status === 'SENT').length === 1 &&
  raced.filter(r => r.status === 'SKIPPED_DUPLICATE_OR_REVIEW').length === 1,
  JSON.stringify(raced));
T('concurrent daily report: only one Telegram send',
  mockDelivery.calls.length === callsBeforeRace + 1,
  'calls=' + mockDelivery.calls.length + ', before=' + callsBeforeRace);

// ---- Telegraph monitor: insert 2 requests, run twice ----
await env.DB.prepare("INSERT INTO zatca_experiment_requests (request_key, business_type, revenue_band, qualified, submitted_at, attr_source, attr_campaign, attr_content) VALUES ('rk-t1','متجر','1M','yes',?, 'telegraph','EXP-ZATCA-W25-2026-09','c1')").bind(today + 'T09:00:00').run();
await env.DB.prepare("INSERT INTO zatca_experiment_requests (request_key, business_type, revenue_band, qualified, submitted_at, attr_source, attr_campaign, attr_content) VALUES ('rk-t2','شركة','2M','review',?, 'telegraph','EXP-ZATCA-W25-2026-09','c2')").bind(today + 'T09:30:00').run();
const tgAdapters = {
  async loadTelegraphRequests() { const { results } = await env.DB.prepare("SELECT * FROM zatca_experiment_requests WHERE attr_source='telegraph' AND attr_campaign='EXP-ZATCA-W25-2026-09'").bind().all(); return results; },
  async loadAlertState() { const { results } = await env.DB.prepare("SELECT * FROM execution_state WHERE record_kind='telegraph_alert'").bind().all(); return results; },
};
const t1 = await runTelegraphMonitor(env, tgAdapters, mockDelivery);
T('telegraph first run alerted 2', t1.new_requests === 2 && t1.alerted === 2, JSON.stringify(t1));
const t2 = await runTelegraphMonitor(env, tgAdapters, mockDelivery);
T('telegraph second run zero new (idempotent)', t2.new_requests === 0 && t2.alerted === 0);
const tgRows = await env.DB.prepare("SELECT COUNT(*) c FROM execution_state WHERE record_kind='telegraph_alert'").bind().all();
T('telegraph exactly 2 alert rows in D1', tgRows.results[0].c === 2);

// ---- Revenue watch: marker upsert idempotent ----
const rwAdapters = {
  async checkAgentSouk() { return { data: [] }; },
  async checkDatapoint() { return {}; },
  async checkBountyBook() { return { completed: 42 }; },
  async loadWatchState() { const { results } = await env.DB.prepare("SELECT * FROM execution_state WHERE record_kind='revenue_watch_state'").bind().all(); return results; },
};
const w1 = await runRevenueWatch(env, rwAdapters, null);
T('watch first run marker saved, no events (baseline)', w1.markers_saved === 1 && w1.events_detected === 0);
const w2 = await runRevenueWatch(env, rwAdapters, null);
const markerRows = await env.DB.prepare("SELECT COUNT(*) c, progress FROM execution_state WHERE idempotency_key='watch|bb|completed'").bind().all();
T('watch marker upserted once with latest progress', markerRows.results[0].c === 1 && markerRows.results[0].progress === 42);

console.log('\n===== M3 CRON SUMMARY: ' + pass + ' PASS, ' + fail + ' FAIL =====');
if (failures.length) { failures.forEach(f => console.log(' - ' + f)); process.exit(1); }
