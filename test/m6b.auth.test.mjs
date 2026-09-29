import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Wallet } from 'ethers';
import { issueNonce, consumeNonce, handleBountyBookAuth, EXPECTED_WALLET } from '../src/bridges/bountybook.js';

function makeD1() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      return { bind(...args) {
        const s = db.prepare(sql);
        return {
          async run() { const r=s.run(...args); return {meta:{changes:r.changes,last_row_id:r.lastInsertRowid}}; },
          async first() { return s.get(...args) ?? null; },
          async all() { return {results:s.all(...args)}; },
        };
      }};
    },
  };
}

test('bountybook nonce: unique, expires, and single-use claim', async () => {
  const db=makeD1();
  const a=await issueNonce(db), b=await issueNonce(db);
  assert.notEqual(a,b);
  const c1=await consumeNonce(db,a);
  const c2=await consumeNonce(db,a);
  assert.equal(c1.ok,true);
  assert.equal(c2.ok,false);
  assert.equal(c2.reason,'NONCE_REPLAY');
});

test('bountybook auth: malformed signature is rejected before provider auth', async () => {
  const db=makeD1();
  const nonce=await issueNonce(db);
  const req=new Request('https://atlas.test/bridge/bountybook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce,signature:'0x1234'})});
  const r=await handleBountyBookAuth(req,{DB:db,BOUNTYBOOK_PROVIDER:'MOCK'});
  const j=await r.json();
  assert.equal(r.status,401);
  assert.equal(j.stop,'INVALID_SIGNATURE');
});

test('bountybook auth: valid EIP-191 signature from another wallet is rejected', async () => {
  const db=makeD1();
  const nonce=await issueNonce(db);
  const wallet=Wallet.createRandom();
  const sig=await wallet.signMessage(nonce);
  const req=new Request('https://atlas.test/bridge/bountybook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce,signature:sig})});
  const r=await handleBountyBookAuth(req,{DB:db,BOUNTYBOOK_PROVIDER:'MOCK'});
  const j=await r.json();
  assert.equal(r.status,401);
  assert.equal(j.stop,'WRONG_WALLET');
  assert.equal(j.wallet_match,'UNVERIFIED');
});

test('bountybook auth: malformed signatures never reach provider', async () => {
  const db=makeD1();
  const nonce=await issueNonce(db);
  const req=new Request('https://atlas.test/bridge/bountybook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce,signature:'0x1234'})});
  const r=await handleBountyBookAuth(req,{DB:db,BOUNTYBOOK_PROVIDER:'MOCK'});
  assert.equal((await r.json()).stop,'INVALID_SIGNATURE');
  assert.equal((await db.prepare('SELECT used_at FROM bountybook_auth_nonces WHERE nonce=?').bind(nonce).first()).used_at,null);
});

test('bountybook LIVE remains locked until real verification gate is explicitly set', async () => {
  const db=makeD1();
  const req=new Request('https://atlas.test/bridge/bountybook',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:'x',signature:'0x1234'})});
  const r=await handleBountyBookAuth(req,{DB:db,BOUNTYBOOK_PROVIDER:'LIVE'});
  const j=await r.json();
  assert.equal(r.status,503);
  assert.equal(j.stop,'LIVE_AUTH_NOT_VERIFIED');
});
