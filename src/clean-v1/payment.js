const PAYMENT_CONFIG = Object.freeze({
  x402Version: 2,
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x59Ea688b36464133E71873d8BeE8Fcb3BC369383',
  maxTimeoutSeconds: 300,
  extra: Object.freeze({
    assetTransferMethod: 'eip3009',
    paymentFlow: 'upfront',
    name: 'USDC',
    version: '2',
  }),
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const NONCE = /^0x[0-9a-f]{64}$/i;
const DECIMAL = /^[0-9]{1,20}$/;
const MAX_PAYMENT_HEADER_CHARS = 16_384;
const DEFAULT_FACILITATOR_URL = 'https://facilitator.openx402.ai';
const FACILITATOR_TIMEOUT_MS = 12_000;

function base64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function paymentRequirements(resourceUrl) {
  return {
    scheme: PAYMENT_CONFIG.scheme,
    network: PAYMENT_CONFIG.network,
    amount: PAYMENT_CONFIG.amount,
    asset: PAYMENT_CONFIG.asset,
    payTo: PAYMENT_CONFIG.payTo,
    maxTimeoutSeconds: PAYMENT_CONFIG.maxTimeoutSeconds,
    extra: { ...PAYMENT_CONFIG.extra },
  };
}

export function paymentRequired(resourceUrl, error = 'PAYMENT-SIGNATURE header is required') {
  return {
    x402Version: PAYMENT_CONFIG.x402Version,
    error,
    resource: {
      url: resourceUrl,
      description: 'Clean and normalize CSV or JSON data',
      mimeType: 'application/json',
      serviceName: 'ATLAS Clean v1',
      tags: ['data', 'cleaning', 'csv', 'json'],
    },
    accepts: [paymentRequirements(resourceUrl)],
    extensions: {},
  };
}

export function encodePaymentHeader(value) {
  return base64Json(value);
}

export function decodePaymentSignature(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue.length > MAX_PAYMENT_HEADER_CHARS) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(headerValue) || headerValue.length % 4 !== 0) return null;
  try {
    const binary = atob(headerValue);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function matchesPaymentRequirements(paymentPayload, resourceUrl) {
  if (!paymentPayload || typeof paymentPayload !== 'object' || paymentPayload.x402Version !== 2) return false;
  if (paymentPayload.resource?.url && paymentPayload.resource.url !== resourceUrl) return false;

  const accepted = paymentPayload.accepted;
  const extra = accepted?.extra;
  const authorization = paymentPayload.payload?.authorization;

  if (
    accepted?.scheme !== PAYMENT_CONFIG.scheme ||
    accepted?.network !== PAYMENT_CONFIG.network ||
    accepted?.amount !== PAYMENT_CONFIG.amount ||
    String(accepted?.asset || '').toLowerCase() !== PAYMENT_CONFIG.asset.toLowerCase() ||
    String(accepted?.payTo || '').toLowerCase() !== PAYMENT_CONFIG.payTo.toLowerCase() ||
    accepted?.maxTimeoutSeconds !== PAYMENT_CONFIG.maxTimeoutSeconds ||
    extra?.assetTransferMethod !== PAYMENT_CONFIG.extra.assetTransferMethod ||
    extra?.paymentFlow !== PAYMENT_CONFIG.extra.paymentFlow ||
    extra?.name !== PAYMENT_CONFIG.extra.name ||
    extra?.version !== PAYMENT_CONFIG.extra.version
  ) return false;

  if (
    !SIGNATURE.test(paymentPayload.payload?.signature || '') ||
    !ADDRESS.test(authorization?.from || '') ||
    String(authorization?.to || '').toLowerCase() !== PAYMENT_CONFIG.payTo.toLowerCase() ||
    authorization?.value !== PAYMENT_CONFIG.amount ||
    !DECIMAL.test(authorization?.validAfter || '') ||
    !DECIMAL.test(authorization?.validBefore || '') ||
    !NONCE.test(authorization?.nonce || '')
  ) return false;

  try {
    return BigInt(authorization.validBefore) > BigInt(authorization.validAfter);
  } catch {
    return false;
  }
}

function facilitatorSettleUrl(configuredUrl) {
  const base = new URL(configuredUrl || DEFAULT_FACILITATOR_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('FACILITATOR_CONFIGURATION_INVALID');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/settle`;
  return base.toString();
}

function failed(status, code) {
  return { ok: false, status, code };
}

export async function settleUpfrontPayment({
  paymentPayload,
  facilitatorUrl = DEFAULT_FACILITATOR_URL,
  facilitatorFetch = (...args) => fetch(...args),
}) {
  let endpoint;
  try {
    endpoint = facilitatorSettleUrl(facilitatorUrl);
  } catch {
    return failed(503, 'PAYMENT_FACILITATOR_CONFIG_INVALID');
  }

  let response;
  try {
    response = await facilitatorFetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        x402Version: PAYMENT_CONFIG.x402Version,
        paymentPayload,
        paymentRequirements: paymentRequirements(paymentPayload.resource?.url || ''),
      }),
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
  } catch {
    return failed(503, 'PAYMENT_FACILITATOR_UNAVAILABLE');
  }

  if (!response || !response.ok) {
    const status = Number(response?.status);
    return status >= 400 && status < 500 && status !== 429
      ? failed(402, 'PAYMENT_SETTLEMENT_FAILED')
      : failed(503, 'PAYMENT_FACILITATOR_UNAVAILABLE');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    return failed(503, 'PAYMENT_FACILITATOR_BAD_RESPONSE');
  }

  if (result?.success !== true) return failed(402, 'PAYMENT_SETTLEMENT_FAILED');

  const authorization = paymentPayload.payload.authorization;
  const payerMatches = ADDRESS.test(result.payer || '') &&
    result.payer.toLowerCase() === authorization.from.toLowerCase();
  const validTransaction = /^0x[0-9a-f]{64}$/i.test(result.transaction || '');
  if (result.network !== PAYMENT_CONFIG.network || !payerMatches || !validTransaction) {
    return failed(503, 'PAYMENT_SETTLEMENT_UNCONFIRMED');
  }

  return {
    ok: true,
    settlement: {
      success: true,
      transaction: result.transaction,
      network: PAYMENT_CONFIG.network,
      payer: result.payer,
    },
  };
}

export const DEFAULT_CLEAN_V1_FACILITATOR_URL = DEFAULT_FACILITATOR_URL;
