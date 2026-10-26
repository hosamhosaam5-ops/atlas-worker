// M4 Payment Provider Adapter — ported from backup "Evaluate Payment" (atlas-order-intake).
// The gate logic below is the SAME evaluation the n8n workflow runs against a real
// eth_getTransactionReceipt JSON-RPC response. Only the SOURCE of the receipt is
// swappable: PAYMENT_PROVIDER=MOCK (fixtures, default) | BASE_RPC (production, M5+).
//
// IMPORTANT: fixtures here are SYNTHETIC receipts. They prove the gate logic only.
// They are NOT evidence of any real Base transaction.

// M5: production USDC payment config PINNED here (Base Mainnet). These values are the
// same ones audited on the n8n side; changing them requires a founder decision.
export const WALLET = '0xAC2Af2Dd2343F4EAab2de64C89129b7B9283666F'; // legacy test fallback only; production must use env.ATLAS_WALLET_ADDRESS
export const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // approved contract
export const USDC_DECIMALS = 6;
export const BASE_NETWORK = 'eip155:8453'; // Base Mainnet (CAIP-2)
export const BASE_RPC_URL_DEFAULT = 'https://mainnet.base.org';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function walletTopic(wallet) {
  return '0x' + wallet.toLowerCase().replace('0x', '').padStart(64, '0');
}

// Build a synthetic USDC-transfer receipt for MOCK mode.
function mockReceipt({ to = WALLET, amountUsdc = 1, contract = USDC_CONTRACT, status = '0x1' } = {}) {
  return {
    status,
    logs: [{
      address: contract,
      topics: [TRANSFER_TOPIC0, '0x' + '0'.repeat(64), walletTopic(to)],
      data: '0x' + BigInt(Math.round(amountUsdc * 1e6)).toString(16),
    }],
  };
}

const MOCK_SCENARIOS = {
  valid: (env) => ({ result: mockReceipt({ to: env.ATLAS_WALLET_ADDRESS || WALLET, amountUsdc: Number(env.PAYMENT_MOCK_AMOUNT_USDC || 1) }) }),
  valid_overpay: () => ({ result: mockReceipt({ amountUsdc: 1.5 }) }),
  not_found: () => ({ result: null }),
  tx_failed: () => ({ result: { status: '0x0', logs: [] } }),
  amount_mismatch: () => ({ result: mockReceipt({ amountUsdc: 0.5 }) }),
  wrong_contract: () => ({ result: mockReceipt({ contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' }) }),
  wrong_recipient: () => ({ result: mockReceipt({ to: '0x000000000000000000000000000000000000dEaD' }) }),
  invalid_receipt: () => ({ result: 'this is not a receipt object' }),
  wrong_tx_hash: () => ({ result: { ...mockReceipt(), transactionHash: '0x' + 'cd'.repeat(32) } }),
  wrong_chain: () => ({ result: mockReceipt() }),
  rpc_error: () => ({ error: { message: 'rate limit exceeded' } }),
  uppercase: () => ({
    result: {
      status: '0x1',
      logs: [{
        address: USDC_CONTRACT.toUpperCase().replace('0X', '0x'),
        topics: [TRANSFER_TOPIC0, '0x' + '0'.repeat(64), walletTopic(WALLET).toUpperCase().replace('0X', '0x')],
        data: '0x' + BigInt(1e6).toString(16),
      }],
    },
  }),
};

// Fetch the raw JSON-RPC receipt response. MOCK never touches the network.
export async function fetchReceipt(env, txHash) {
  const provider = String(env.PAYMENT_PROVIDER || '').trim().toUpperCase();
  if (!provider) throw new Error('PAYMENT_PROVIDER_REQUIRED');
  if (provider === 'MOCK') {
    const scenario = env.PAYMENT_MOCK_SCENARIO || 'valid';
    const fn = MOCK_SCENARIOS[scenario];
    if (!fn) throw new Error('unknown PAYMENT_MOCK_SCENARIO: ' + scenario);
    const fixture = fn(env);
    if (fixture.result && typeof fixture.result === 'object' && !Array.isArray(fixture.result)) {
      fixture.result = { ...fixture.result, transactionHash: fixture.result.transactionHash || txHash };
    }
    return { ...fixture, chainId: scenario === 'wrong_chain' ? '0x14a34' : '0x2105' };
  }
  if (provider === 'BASE_RPC') {
    // Production path (not used in M4; no real RPC calls locally).
    const rpcUrl = env.BASE_RPC_URL || BASE_RPC_URL_DEFAULT;
    const chainRes = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const chainJson = await chainRes.json();
    if (!chainRes.ok || chainJson.error || typeof chainJson.result !== 'string') {
      return { error: { message: 'CHAIN_ID_UNVERIFIED' } };
    }
    if (chainJson.result.toLowerCase() !== '0x2105') {
      return { error: { message: 'WRONG_CHAIN_ID' }, chainId: chainJson.result };
    }
    const res = await fetch(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [txHash] }),
    });
    const receiptJson = await res.json();
    return { ...receiptJson, chainId: chainJson.result };
  }
  throw new Error('unknown PAYMENT_PROVIDER: ' + provider);
}

// Verbatim port of the backup "Evaluate Payment" Code node logic.
// Same statuses, same topics, same case-insensitive comparisons, same >= rule.
export function evaluatePayment(receiptResponse, meta) {
  const resp = receiptResponse;
  let status = 'NOT_FOUND';
  let amountPaid = 0;
  let detail = '';
  const receipt = resp && resp.result ? resp.result : null;
  if (!receipt) {
    status = 'NOT_FOUND';
    detail = resp && resp.error ? String(resp.error.message || resp.error) : 'no receipt';
  } else if (receipt.status !== '0x1') {
    status = 'TX_FAILED';
    detail = 'transaction status ' + receipt.status;
  } else {
    const topic0 = TRANSFER_TOPIC0;
    const wt = meta.wallet.toLowerCase().replace('0x', '').padStart(64, '0');
    for (const log of (receipt.logs || [])) {
      if (log.address && log.address.toLowerCase() === meta.usdc_contract.toLowerCase()
          && log.topics && log.topics[0] === topic0
          && log.topics[2] && log.topics[2].toLowerCase() === '0x' + wt) {
        amountPaid += parseInt(log.data, 16) / 1e6;
      }
    }
    if (amountPaid >= meta.expected_amount && amountPaid > 0) {
      status = 'PAID';
    } else if (amountPaid > 0) {
      status = 'AMOUNT_MISMATCH';
    } else {
      // M5 taxonomy refinement: distinguish the two root causes the n8n verdict merged.
      // A Transfer log from the approved contract to a DIFFERENT recipient = WRONG_RECIPIENT.
      // Any transfer to the wallet from a NON-approved contract (or no relevant log at
      // all) = WRONG_CONTRACT. No approved transfer at all keeps the legacy NOT_USDC_TO_WALLET
      // only when no ERC-20 transfer evidence exists to classify.
      let sawContractTransfer = false;
      let sawWalletTransfer = false;
      for (const log of (receipt.logs || [])) {
        if (!log.topics || log.topics[0] !== TRANSFER_TOPIC0) continue;
        const fromApproved = log.address && log.address.toLowerCase() === meta.usdc_contract.toLowerCase();
        const toWallet = log.topics[2] && log.topics[2].toLowerCase() === '0x' + wt;
        if (fromApproved && !toWallet) sawContractTransfer = true;
        if (!fromApproved && toWallet) sawWalletTransfer = true;
      }
      if (sawContractTransfer && !sawWalletTransfer) status = 'WRONG_RECIPIENT';
      else if (sawWalletTransfer && !sawContractTransfer) status = 'WRONG_CONTRACT';
      else status = 'NOT_USDC_TO_WALLET';
    }
    detail = 'paid_usdc=' + amountPaid;
  }
  return { ...meta, payment_status: status, amount_paid: amountPaid, payment_detail: detail };
}

// INVALID_RECEIPT taxonomy: receipt exists but is not an object with a hex status.
// The n8n code would throw inside the Code node; here we classify honestly.
export function evaluatePaymentSafe(receiptResponse, meta, expectedTxHash = null, expectedChainId = '0x2105') {
  const response = receiptResponse || {};
  const r = response.result;
  if (response.error && String(response.error.message || response.error).includes('WRONG_CHAIN_ID')) {
    return { ...meta, payment_status: 'WRONG_CHAIN', amount_paid: 0, payment_detail: 'RPC chain id is not Base Mainnet' };
  }
  if (expectedTxHash) {
    if (typeof response.chainId !== 'string' || response.chainId.toLowerCase() !== String(expectedChainId).toLowerCase()) {
      return { ...meta, payment_status: 'WRONG_CHAIN', amount_paid: 0, payment_detail: 'RPC chain id missing or does not match Base Mainnet' };
    }
    if (!r || typeof r !== 'object' || typeof r.transactionHash !== 'string'
        || r.transactionHash.toLowerCase() !== String(expectedTxHash).toLowerCase()) {
      return { ...meta, payment_status: 'INVALID_RECEIPT', amount_paid: 0, payment_detail: 'receipt transactionHash missing or does not match requested transaction' };
    }
  }
  if (r && (typeof r !== 'object' || typeof r.status !== 'string' || !r.status.startsWith('0x'))) {
    return { ...meta, payment_status: 'INVALID_RECEIPT', amount_paid: 0, payment_detail: 'receipt shape invalid' };
  }
  return evaluatePayment(response, meta);
}
