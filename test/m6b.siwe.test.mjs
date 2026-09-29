import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDatapointChallenge, buildSigningPage, EXPECTED_WALLET } from '../src/bridges/siwe.js';

function msg(over='') {
  return [
    'datapoint.market wants you to sign in with your Ethereum account:',
    EXPECTED_WALLET,
    '',
    'Sign in to datapoint.market',
    '',
    'URI: https://api.datapoint.market',
    'Version: 1',
    'Chain ID: 8453',
    'Nonce: abcdef123456',
    'Issued At: ' + new Date().toISOString(),
    over
  ].filter(Boolean).join('\n');
}
test('datapoint SIWE validator accepts fresh expected-wallet Base challenge', () => {
  const r=validateDatapointChallenge(msg());
  assert.equal(r.ok,true);
  assert.equal(r.nonce,'abcdef123456');
});
test('datapoint SIWE validator rejects wrong chain', () => {
  assert.equal(validateDatapointChallenge(msg('Chain ID: 1')).reason,'WRONG_CHAIN');
});
test('datapoint SIWE validator rejects wrong URI', () => {
  assert.equal(validateDatapointChallenge(msg('URI: https://evil.example')).reason,'WRONG_URI');
});
test('datapoint SIWE validator rejects wrong wallet', () => {
  const m=msg().replace(EXPECTED_WALLET,'0x0000000000000000000000000000000000000001');
  assert.equal(validateDatapointChallenge(m).reason,'WRONG_WALLET');
});
test('datapoint SIWE validator rejects stale challenge and buildSigningPage refuses it', () => {
  const stale=msg().replace(/Issued At: .+/, 'Issued At: 2020-01-01T00:00:00.000Z');
  assert.equal(validateDatapointChallenge(stale).reason,'STALE_CHALLENGE');
  assert.throws(()=>buildSigningPage({message:stale}),/STALE_CHALLENGE/);
});
test('datapoint signing page never fabricates a missing challenge', () => {
  assert.throws(()=>buildSigningPage({}),/invalid datapoint SIWE challenge/);
});
