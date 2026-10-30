import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration=readFileSync(new URL('../migrations/0008_demand_scan_breaker_observability.sql',import.meta.url),'utf8');

function oldSnapshot(){
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE demand_scan_source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL,
      source TEXT NOT NULL,
      raw_count INTEGER NOT NULL DEFAULT 0,
      raw_recent_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      rejection_counts_json TEXT NOT NULL DEFAULT '{}',
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      response_ms INTEGER,
      http_status INTEGER,
      source_status TEXT NOT NULL,
      error_code TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scan_id,source)
    );
    INSERT INTO demand_scan_source_runs(
      scan_id,source,raw_count,raw_recent_count,accepted_count,rejected_count,
      rejection_counts_json,duplicate_count,response_ms,http_status,source_status,error_code,
      started_at,finished_at
    ) VALUES(
      'scan-before-0008','agent_job_public_mcp',50,2,0,50,'{"stale":48}',0,18,200,'OK',NULL,
      '2026-10-30T09:00:00.000Z','2026-10-30T09:00:00.018Z'
    );
  `);
  return db;
}

test('0008 is strictly three additive ALTER TABLE ADD COLUMN statements',()=>{
  const sqlWithoutComments=migration.replace(/^\s*--.*$/gm,'').trim();
  const statements=sqlWithoutComments.split(';').map(x=>x.trim()).filter(Boolean);
  assert.equal(statements.length,3);
  assert.match(statements[0],/^ALTER TABLE demand_scan_source_runs ADD COLUMN breaker_state TEXT$/i);
  assert.match(statements[1],/^ALTER TABLE demand_scan_source_runs ADD COLUMN consecutive_failures INTEGER$/i);
  assert.match(statements[2],/^ALTER TABLE demand_scan_source_runs ADD COLUMN cooldown_ms INTEGER$/i);
  assert.doesNotMatch(migration,/\b(?:DROP|DELETE|UPDATE|INSERT|REPLACE|TRUNCATE)\b/i);
  assert.doesNotMatch(migration,/d1_migrations/i);
});

test('0008 applies cleanly to a pre-migration SQLite snapshot and preserves historical rows',()=>{
  const db=oldSnapshot();
  try{
    const before=db.prepare('SELECT COUNT(*) AS n FROM demand_scan_source_runs').get().n;
    db.exec(migration);
    const columns=db.prepare('PRAGMA table_info(demand_scan_source_runs)').all();
    const byName=new Map(columns.map(row=>[row.name,row]));
    for(const [name,type] of [
      ['breaker_state','TEXT'],
      ['consecutive_failures','INTEGER'],
      ['cooldown_ms','INTEGER']
    ]){
      const column=byName.get(name);
      assert.ok(column, name+' must exist after applying 0008');
      assert.equal(column.type,type);
      assert.equal(column.notnull,0,'new fields must remain nullable');
      assert.equal(column.dflt_value,null,'new fields must not backfill defaults');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demand_scan_source_runs').get().n,before);
    const old=db.prepare('SELECT scan_id,breaker_state,consecutive_failures,cooldown_ms FROM demand_scan_source_runs').get();
    assert.deepEqual({...old},{
      scan_id:'scan-before-0008',
      breaker_state:null,
      consecutive_failures:null,
      cooldown_ms:null
    });
  }finally{db.close();}
});
