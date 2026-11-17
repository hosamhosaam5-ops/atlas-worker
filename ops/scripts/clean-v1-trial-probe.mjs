import { pathToFileURL } from 'node:url';

export const CLEAN_V1_PREVIEW_PATH = '/x402/clean_v1/preview';
export const CLEAN_V1_PAID_PATH = '/x402/clean_v1';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 5_000;
const MAX_DIAGNOSTIC_BODY_CHARS = 2 * 1024;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeBody(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/("(?:authorization|token|secret|api[_-]?key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/0x[a-f0-9]{64,}/gi, '0x[REDACTED]')
    .replace(/[A-Za-z0-9_=-]{96,}/g, '[REDACTED]')
    .slice(0, MAX_DIAGNOSTIC_BODY_CHARS);
}

async function logUnexpectedResponse(label, response) {
  let body = '';
  try {
    body = await response.clone().text();
  } catch (error) {
    body = '[body-read-error: ' + String(error?.message || error) + ']';
  }
  console.log(label + ' | status=' + response.status);
  console.log(label + ' | cf-ray=' + (response.headers.get('cf-ray') || 'UNKNOWN'));
  console.log(label + ' | content-type=' + (response.headers.get('content-type') || 'UNKNOWN'));
  console.log(label + ' | body-sanitized-2kb=' + sanitizeBody(body));
}

function logNoResponse(label, error) {
  console.log(label + ' | status=NO_RESPONSE');
  console.log(label + ' | cf-ray=UNKNOWN');
  console.log(label + ' | content-type=UNKNOWN');
  console.log(label + ' | body-sanitized-2kb=' + sanitizeBody(error?.message || error));
}

export async function waitForCleanV1PreviewRoute(baseUrl, {
  fetchImpl = fetch,
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
} = {}) {
  const startedAt = Date.now();
  let lastResponse = null;
  let lastError = null;
  let attempt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;
    try {
      // Readiness-only GET: deliberately no data, body, or content-type.
      // The Worker returns 415 for this known route; a 404 means the route is not ready yet.
      const response = await fetchImpl(baseUrl + CLEAN_V1_PREVIEW_PATH, { method: 'GET' });
      lastResponse = response;
      lastError = null;
      if (response.status !== 404) {
        if (response.status !== 415) {
          await logUnexpectedResponse('PREVIEW_ROUTE_READINESS_UNEXPECTED_RESPONSE', response);
          throw Object.assign(new Error('PREVIEW_ROUTE_READINESS_UNEXPECTED_RESPONSE'), {
            code: 'PREVIEW_ROUTE_READINESS_UNEXPECTED_RESPONSE',
          });
        }
        console.log('PASS | preview route readiness | attempt=' + attempt +
          ' | status=' + response.status + ' | elapsed_ms=' + (Date.now() - startedAt));
        return response.status;
      }
    } catch (error) {
      lastError = error;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) break;
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
  }

  if (lastResponse) {
    await logUnexpectedResponse('PREVIEW_ROUTE_NOT_READY_AFTER_60S', lastResponse);
  } else {
    logNoResponse('PREVIEW_ROUTE_NOT_READY_AFTER_60S', lastError || new Error('No HTTP response'));
  }
  throw Object.assign(new Error('PREVIEW_ROUTE_NOT_READY'), { code: 'PREVIEW_ROUTE_NOT_READY' });
}

export function cleanV1CsvBody(rowCount) {
  return ['name,value', ...Array.from(
    { length: rowCount },
    (_, index) => 'row-' + (index + 1) + ',' + (index + 1),
  )].join('\n');
}

async function postPreview(baseUrl, rowCount, fetchImpl) {
  const body = cleanV1CsvBody(rowCount);
  const response = await fetchImpl(baseUrl + CLEAN_V1_PREVIEW_PATH, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body,
  });
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = null;
  }

  const expectedReturned = Math.min(rowCount, 10);
  const valid = response.status === 200 &&
    result?.preview === true &&
    result?.source_rows === rowCount &&
    result?.preview_rows === 10 &&
    result?.data?.length === expectedReturned &&
    result?.truncated === (rowCount > 10);

  if (!valid) {
    await logUnexpectedResponse('PREVIEW_' + rowCount + '_ROWS_FAILED', response);
    throw new Error('PREVIEW_' + rowCount + '_ROWS_CONTRACT_FAILED');
  }

  console.log('PASS | preview upload | source_rows=' + rowCount +
    ' | returned_rows=' + result.data.length + ' | truncated=' + result.truncated);
  return { sourceRows: rowCount, returnedRows: result.data.length, status: response.status };
}

function decodePaymentRequired(value) {
  try {
    return JSON.parse(Buffer.from(value || '', 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function postUnpaid402(baseUrl, fetchImpl) {
  // No body, PAYMENT-SIGNATURE, wallet, or facilitator request.
  const response = await fetchImpl(baseUrl + CLEAN_V1_PAID_PATH, { method: 'POST' });
  const responseText = await response.text();
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = null;
  }

  const requirement = decodePaymentRequired(response.headers.get('PAYMENT-REQUIRED'));
  const accepted = requirement?.accepts?.[0];
  const valid = response.status === 402 &&
    body?.code === 'PAYMENT_REQUIRED' &&
    !response.headers.has('PAYMENT-RESPONSE') &&
    requirement?.x402Version === 2 &&
    accepted?.scheme === 'exact' &&
    accepted?.network === 'eip155:8453' &&
    accepted?.amount === '10000' &&
    String(accepted?.asset || '').toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' &&
    String(accepted?.payTo || '').toLowerCase() === '0x59ea688b36464133e71873d8bee8fcb3bc369383' &&
    accepted?.extra?.paymentFlow === 'upfront' &&
    accepted?.extra?.assetTransferMethod === 'eip3009';

  if (!valid) {
    await logUnexpectedResponse('UNPAID_402_CHALLENGE_FAILED', response);
    throw new Error('UNPAID_402_CHALLENGE_CONTRACT_FAILED');
  }

  console.log('PASS | unpaid paid-route probe | HTTP 402 | exact Base USDC x402 requirements | no PAYMENT-RESPONSE');
  return { status: response.status, code: body.code };
}

export async function runCleanV1TrialProbe(baseUrl, { fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new TypeError('CLEAN_V1_BASE_URL_INVALID');
  }

  const readinessStatus = await waitForCleanV1PreviewRoute(baseUrl, { fetchImpl });
  const tenRows = await postPreview(baseUrl, 10, fetchImpl);
  const twoHundredRows = await postPreview(baseUrl, 200, fetchImpl);
  const unpaid402 = await postUnpaid402(baseUrl, fetchImpl);

  return {
    readinessStatus,
    previews: [tenRows, twoHundredRows],
    unpaid402,
  };
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const baseUrl = process.argv[2] || process.env.CLEAN_V1_BASE_URL;
  if (!baseUrl) {
    console.error('FAIL | provide a base URL argument or CLEAN_V1_BASE_URL');
    process.exitCode = 2;
  } else {
    try {
      await runCleanV1TrialProbe(baseUrl);
    } catch (error) {
      console.error('FAIL | Clean v1 probe | code=' + (error?.code || 'PROBE_FAILED') +
        ' | message=' + sanitizeBody(error?.message || error));
      process.exitCode = 1;
    }
  }
}
