import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCard, x402Requirements } from '../src/autonomy/p1.js';
test('A2A agent card exposes bounded ATLAS capability',()=>{const c=agentCard('https://atlas.example');assert.equal(c.name,'ATLAS');assert.ok(c.skills.some(s=>s.id==='data_qa'));assert.deepEqual(c.authentication.schemes,['OAuth2']);});
test('x402 requirements are exact Base USDC payment requirements',()=>{const r=x402Requirements('https://atlas.example',{price_usdc:15,wallet:'0x1111111111111111111111111111111111111111',asset:'0x2222222222222222222222222222222222222222'});assert.equal(r.x402Version,2);assert.equal(r.accepts[0].scheme,'exact');assert.equal(r.accepts[0].network,'eip155:8453');assert.equal(r.accepts[0].amount,'15000000');});
