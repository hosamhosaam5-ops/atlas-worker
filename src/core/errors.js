// M5 GLOBAL FAILURE TAXONOMY — one classification layer for the whole system.
// Every failure in ATLAS maps to an explicit code from this single list.
// Rule: an unknown/new failure must become an EXPLICIT code, never a disguised success.
// These are failure codes — distinct from the order-gate statuses in payment.js
// (NOT_FOUND/TX_FAILED/...), which this module maps into the taxonomy.

export const ERROR_CODES = Object.freeze([
  'VALIDATION',         // input failed local validation (missing/invalid fields)
  'NO_QUOTE',           // no founder quote for this client
  'MULTIPLE_QUOTES',    // ambiguous founder quotes for this client
  'PAYMENT_NOT_FOUND',  // receipt not found on-chain
  'PAYMENT_FAILED',     // on-chain tx status failed / generic gate failure
  'PAYMENT_MISMATCH',   // paid amount < expected amount
  'WRONG_CONTRACT',     // transfer not from the approved USDC contract
  'WRONG_RECIPIENT',    // transfer not to the founder wallet
  'DUPLICATE_TX',       // tx_hash already used/claimed
  'INVALID_RECEIPT',    // receipt exists but shape is invalid
  'QA_FAILED',          // data quality gate failed
  'DELIVERY_FAILED',    // a channel delivery ended FAILED after attempt(s)
  'PROVIDER_ERROR',     // external provider returned an error / malformed success
  'TIMEOUT',            // provider call exceeded its timeout budget
  'RATE_LIMIT',         // provider HTTP 429 — caller must stop/back off
  'AI_FAILED',          // AI provider failure (state must not be mutated wrongly)
  'AUTH_FAILED',        // auth/secret rejection (bridge header, wallet, session)
  'DUPLICATE',          // generic duplicate detection (event, request, delivery)
]);

// Map the payment gate's verdict (payment.js) to the global taxonomy.
export function mapPaymentStatus(status) {
  switch (status) {
    case 'NOT_FOUND': return 'PAYMENT_NOT_FOUND';
    case 'TX_FAILED': return 'PAYMENT_FAILED';
    case 'AMOUNT_MISMATCH': return 'PAYMENT_MISMATCH';
    // NOT_USDC_TO_WALLET is the n8n-legacy combined verdict (no approved USDC transfer
    // to the founder wallet). payment.js now distinguishes the two root causes into
    // WRONG_CONTRACT / WRONG_RECIPIENT before this map is consulted.
    case 'NOT_USDC_TO_WALLET': return 'WRONG_CONTRACT';
    case 'WRONG_CONTRACT': return 'WRONG_CONTRACT';
    case 'WRONG_RECIPIENT': return 'WRONG_RECIPIENT';
    case 'INVALID_RECEIPT': return 'INVALID_RECEIPT';
    case 'PAID': return null; // not a failure
    default: return 'PAYMENT_FAILED';
  }
}

// classify an arbitrary thrown error / provider result into the taxonomy.
// Explicit codes on the error object always win. Unknown failures become PROVIDER_ERROR
// (explicit) — never silently treated as success.
export function classifyError(err) {
  if (!err) return { code: 'PROVIDER_ERROR', message: 'unknown failure' };
  const raw = typeof err === 'string' ? err : String(err.message || err.error || err);
  const explicit = err.code || err.error_code;
  if (explicit && ERROR_CODES.includes(explicit)) return { code: explicit, message: raw };
  const m = raw.toLowerCase();
  if (m.includes('429') || m.includes('rate limit')) return { code: 'RATE_LIMIT', message: raw };
  if (m.includes('timeout') || m.includes('timed out') || m.includes('etimedout') || m.includes('abort')) return { code: 'TIMEOUT', message: raw };
  if (m.includes('401') || m.includes('403') || m.includes('unauthorized') || m.includes('forbidden') || m.includes('auth')) return { code: 'AUTH_FAILED', message: raw };
  if (m.includes('unique') || m.includes('duplicate')) return { code: 'DUPLICATE', message: raw };
  if (m.includes('validation') || m.includes('invalid input') || m.includes('missing')) return { code: 'VALIDATION', message: raw };
  return { code: explicit && !ERROR_CODES.includes(explicit) ? 'PROVIDER_ERROR' : 'PROVIDER_ERROR', message: raw };
}

export function isErrorCode(code) { return ERROR_CODES.includes(code); }
