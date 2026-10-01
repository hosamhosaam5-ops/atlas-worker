// M6A — DATA MIGRATION TOOLING (item 6).
// Receives n8n Data Table exports (arrays of row objects) and loads them into D1.
// Fixtures only for now — no real n8n data required. Guarantees:
//   * schema validation per target table (required fields + type checks)
//   * malformed rows rejected with reasons (never silently inserted)
//   * duplicate rows collapse before insert (dedupe)
//   * idempotent re-import (INSERT OR IGNORE / upsert by natural key)
//   * count + checksum verification helpers

import crypto from 'node:crypto';

// n8n Data Table name -> D1 target table + row mapper + natural dedupe key.
export const TABLE_MAP = {
  atlas_execution_state: {
    table: 'execution_state',
    key: r => r.idempotency_key,
    required: ['idempotency_key'],
    insert: `INSERT INTO execution_state (idempotency_key, record_kind, correlation_id, request_id, entity_type, entity_id, action_id, tool, status, progress, payload_json, error_code, attempt_count, delivery_state, message_key, expires_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now')),?)
      ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status, progress=excluded.progress, payload_json=excluded.payload_json, error_code=excluded.error_code, updated_at=datetime('now')`,
    values: r => [r.idempotency_key ?? null, r.record_kind ?? null, r.correlation_id ?? null, r.request_id ?? null, r.entity_type ?? null, r.entity_id ?? null, r.action_id ?? null, r.tool ?? null, r.status ?? null, numOrNull(r.progress), r.payload_json ?? null, r.error_code ?? null, r.attempt_count ?? 0, r.delivery_state ?? null, r.message_key ?? null, r.expires_at ?? null, r.created_at ?? null, r.updated_at ?? null],
  },
  ceo_memory: {
    table: 'ceo_memory',
    key: r => (r.category || 'fact') + '|' + String(r.content || '').trim().toLowerCase(),
    existsSql: "SELECT 1 FROM ceo_memory WHERE category = ? AND content = ? LIMIT 1",
    existsParams: r => [String(r.category || 'fact').toLowerCase(), String(r.content)],
    required: ['content'],
    insert: `INSERT INTO ceo_memory (category, content, created_at) VALUES (?,?,COALESCE(?, datetime('now')))`,
    values: r => [String(r.category || 'fact').toLowerCase(), String(r.content), r.created_at ?? null],
    dedupeSelect: 'SELECT category, content FROM ceo_memory',
  },
  atlas_memory: { table: 'ceo_memory', key: r => (r.category || 'fact') + '|' + String(r.content || '').trim().toLowerCase(), existsSql: "SELECT 1 FROM ceo_memory WHERE category = ? AND content = ? LIMIT 1", existsParams: r => [String(r.category || 'fact').toLowerCase(), String(r.content)], required: ['content'], insert: `INSERT INTO ceo_memory (category, content, created_at) VALUES (?,?,COALESCE(?, datetime('now')))`, values: r => [String(r.category || 'fact').toLowerCase(), String(r.content), r.created_at ?? null], dedupeSelect: 'SELECT category, content FROM ceo_memory' },
  atlas_order_quotes: {
    table: 'order_quotes',
    key: r => String(r.client_email || '').trim().toLowerCase() + '|' + String(r.agreed_amount),
    existsSql: "SELECT 1 FROM order_quotes WHERE client_email = ? AND agreed_amount = ? LIMIT 1",
    existsParams: r => [String(r.client_email).trim().toLowerCase(), Number(r.agreed_amount)],
    required: ['client_email', 'agreed_amount'],
    insert: `INSERT INTO order_quotes (client_email, agreed_amount, status, note, created_at) VALUES (?,?,?,?,COALESCE(?, datetime('now')))`,
    values: r => [String(r.client_email).trim().toLowerCase(), Number(r.agreed_amount), r.status ?? 'ACTIVE', r.note ?? null, r.created_at ?? null],
  },
  atlas_order_ledger: {
    table: 'order_ledger',
    key: r => r.order_id,
    required: ['order_id'],
    insert: `INSERT INTO order_ledger (order_id, client_email, tx_hash, quote_ref, status, error, created_at, updated_at)
      VALUES (?,?,?,?,?,?,COALESCE(?, datetime('now')),?)
      ON CONFLICT(order_id) DO NOTHING`,
    values: r => [r.order_id, r.client_email ?? null, r.tx_hash ?? null, r.quote_ref ?? null, r.status ?? 'IMPORTED', r.error ?? null, r.created_at ?? null, r.updated_at ?? null],
  },
  atlas_bridge_audit: {
    table: 'bridge_audit',
    key: r => (r.request_id || '') + '|' + (r.timestamp || ''),
    required: ['request_id'],
    insert: `INSERT INTO bridge_audit (request_id, operation, status, auth_result, timestamp, error_summary) VALUES (?,?,?,?,COALESCE(?, datetime('now')),?)`,
    values: r => [r.request_id, r.operation ?? null, r.status ?? null, r.auth_result ?? null, r.timestamp ?? null, r.error_summary ?? null],
  },
  zatca_experiment_requests: {
    table: 'zatca_experiment_requests',
    key: r => r.request_key,
    required: ['request_key'],
    insert: `INSERT INTO zatca_experiment_requests (request_key, business_type, revenue_band, qualified, submitted_at, attr_source, attr_campaign, attr_content) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(request_key) DO NOTHING`,
    values: r => [r.request_key, r.business_type ?? null, r.revenue_band ?? null, r.qualified ?? null, r.submitted_at ?? null, r.attr_source ?? null, r.attr_campaign ?? null, r.attr_content ?? null],
  },
  acquisition_assets: {
    table: 'acquisition_assets',
    key: r => (r.asset || '') + '|' + (r.created_at || ''),
    required: ['asset'],
    insert: `INSERT INTO acquisition_assets (asset, status, created_at) VALUES (?,?,COALESCE(?, datetime('now')))`,
    values: r => [r.asset, r.status ?? null, r.created_at ?? null],
  },
  channel_watch: {
    table: 'channel_watch',
    key: r => (r.channel || '') + '|' + (r.check_date || ''),
    required: ['channel'],
    insert: `INSERT INTO channel_watch (channel, verdict, status, check_date) VALUES (?,?,?,?)`,
    values: r => [r.channel, r.verdict ?? null, r.status ?? null, r.check_date ?? null],
  },
  publications: {
    table: 'publications',
    key: r => (r.channel || '') + '|' + (r.asset || '') + '|' + (r.publication_time || ''),
    required: ['channel'],
    insert: `INSERT INTO publications (channel, asset, status, publication_time) VALUES (?,?,?,?)`,
    values: r => [r.channel, r.asset ?? null, r.status ?? null, r.publication_time ?? null],
  },
};

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Validate rows against the table contract. Returns { valid, errors[] }.
export function validateRows(tableName, rows) {
  const map = TABLE_MAP[tableName];
  if (!map) return { valid: [], errors: [{ row: null, reason: 'no mapping for table ' + tableName }] };
  const valid = [], errors = [];
  (rows || []).forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push({ index: i, reason: 'row is not an object' }); return; }
    for (const req of map.required) {
      if (r[req] === undefined || r[req] === null || r[req] === '') { errors.push({ index: i, reason: 'missing required field ' + req }); return; }
    }
    if (tableName === 'atlas_order_quotes' && !Number.isFinite(Number(r.agreed_amount))) {
      errors.push({ index: i, reason: 'agreed_amount is not a number' }); return;
    }
    valid.push(r);
  });
  return { valid, errors };
}

// Deterministic content checksum over a set of export rows (order-independent).
export function checksumRows(rows) {
  const canon = (rows || []).map(r => JSON.stringify(Object.keys(r).sort().reduce((o, k) => (o[k] = r[k], o), {}))).sort();
  return crypto.createHash('sha256').update(canon.join('\n')).digest('hex').slice(0, 16);
}

export const importRows = {
  // Collapse exact duplicates by the table's natural key (first wins).
  // NOTE: atlas_execution_state is fail-closed and is intentionally excluded from
  // this generic dedupe behavior by toTable() below. Historical execution state
  // must never lose or overwrite a source row during migration.
  dedupe(tableName, rows) {
    const map = TABLE_MAP[tableName];
    if (!map) return rows || [];
    const seen = new Set(); const out = [];
    for (const r of rows || []) {
      const k = map.key(r);
      if (seen.has(k)) continue;
      seen.add(k); out.push(r);
    }
    return out;
  },

  // Load rows into a node:sqlite DB synchronously. Idempotent: natural-key
  // duplicates (incl. previously imported rows) are skipped, never duplicated.
  toTable(db, tableName, rows) {
    const map = TABLE_MAP[tableName];
    if (!map) throw new Error('no mapping for table ' + tableName);
    const { valid, errors } = validateRows(tableName, rows);

    // M6A migration safety: execution_state is the only table whose historical
    // export is known to contain missing/duplicate natural keys. Never let the
    // generic dedupe/upsert path silently discard the duplicate or overwrite a
    // prior row. A production import must stop before any DB mutation.
    if (tableName === 'atlas_execution_state') {
      const missing = (rows || []).reduce((n, r) => n + (!r || r.idempotency_key === undefined || r.idempotency_key === null || r.idempotency_key === '' ? 1 : 0), 0);
      const counts = new Map();
      for (const r of rows || []) {
        if (r && r.idempotency_key !== undefined && r.idempotency_key !== null && r.idempotency_key !== '') {
          const k = String(r.idempotency_key);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
      if (missing || duplicates.length) {
        throw new Error(`FAIL_CLOSED_EXECUTION_STATE_IMPORT: missing_keys=${missing}; duplicate_keys=${duplicates.map(([k, c]) => `${k}(${c})`).join(',') || 'none'}; no rows imported`);
      }
      if (errors.length) {
        throw new Error(`FAIL_CLOSED_EXECUTION_STATE_IMPORT: rejected_rows=${errors.length}; no rows imported`);
      }
    }

    const deduped = this.dedupe(tableName, valid);
    let inserted = 0, skipped = 0;
    const stmt = db.prepare(map.insert);
    const existsStmt = map.existsSql ? db.prepare(map.existsSql) : null;
    for (const r of deduped) {
      try {
        // Natural-key idempotency for tables without a DB-level UNIQUE: skip rows
        // already imported so a re-import of the same export is a strict no-op.
        if (existsStmt && existsStmt.get(...map.existsParams(r))) { skipped++; continue; }
        const res = stmt.run(...map.values(r));
        const changed = (res && (res.changes ?? 0));
        if (changed > 0) inserted++; else skipped++;
      } catch (e) {
        if (String(e && e.message || e).toLowerCase().includes('unique')) skipped++;
        else throw e;
      }
    }
    return { table: map.table, inserted, skipped, rejected: errors.length, errors };
  },
};
