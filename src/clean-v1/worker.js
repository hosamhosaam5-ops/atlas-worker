import cleanV1Utilities, { MAX_FILE_BYTES } from './engine.js';

const { cleanInputPreview, publicError } = cleanV1Utilities;
const PREVIEW_WINDOW_MS = 60_000;
const PREVIEW_REQUESTS_PER_WINDOW = 10;
const MAX_PREVIEW_GET_URL_CHARS = 8_000;
const previewBuckets = new Map();

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function previewRateLimit(request) {
  const now = Date.now();
  const client = request.headers.get('cf-connecting-ip') || 'unknown-client';

  // Best-effort per-isolate limiter. Expired keys are pruned without storing file data.
  for (const [key, bucket] of previewBuckets) {
    if (now - bucket.startedAt >= PREVIEW_WINDOW_MS) previewBuckets.delete(key);
  }

  const current = previewBuckets.get(client);
  if (!current || now - current.startedAt >= PREVIEW_WINDOW_MS) {
    previewBuckets.set(client, { startedAt: now, count: 1 });
    return null;
  }
  if (current.count >= PREVIEW_REQUESTS_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((current.startedAt + PREVIEW_WINDOW_MS - now) / 1000));
    return json({ code: 'PREVIEW_RATE_LIMITED' }, 429, { 'retry-after': String(retryAfter) });
  }
  current.count += 1;
  return null;
}

function getFormat(request, url) {
  const explicit = url.searchParams.get('format');
  if (explicit === 'csv' || explicit === 'json') return explicit;
  const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType === 'text/csv' || contentType === 'application/csv' || contentType === 'text/plain') return 'csv';
  if (contentType === 'application/json') return 'json';
  throw Object.assign(new Error('INPUT_FORMAT_UNSUPPORTED'), { code: 'INPUT_FORMAT_UNSUPPORTED', status: 415 });
}

async function readBodyLimited(request) {
  if (!request.body) throw Object.assign(new Error('FILE_BODY_REQUIRED'), { code: 'FILE_BODY_REQUIRED', status: 400 });
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    throw Object.assign(new Error('FILE_SIZE_LIMIT_EXCEEDED'), { code: 'FILE_SIZE_LIMIT_EXCEEDED', status: 413 });
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('FILE_SIZE_LIMIT_EXCEEDED'), { code: 'FILE_SIZE_LIMIT_EXCEEDED', status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function preview(request, url) {
  const limited = previewRateLimit(request);
  if (limited) return limited;

  const format = getFormat(request, url);
  let input;
  if (request.method === 'GET') {
    if (url.href.length > MAX_PREVIEW_GET_URL_CHARS) {
      throw Object.assign(new Error('PREVIEW_GET_QUERY_TOO_LARGE'), { code: 'PREVIEW_GET_QUERY_TOO_LARGE', status: 413 });
    }
    input = url.searchParams.get('data');
    if (input === null || input.length === 0) {
      throw Object.assign(new Error('FILE_BODY_REQUIRED'), { code: 'FILE_BODY_REQUIRED', status: 400 });
    }
  } else {
    input = await readBodyLimited(request);
  }
  return json(cleanInputPreview(input, format));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true, service: 'atlas-clean-v1', mode: 'isolated' });
      }
      if (url.pathname === '/x402/clean_v1/preview' && (request.method === 'GET' || request.method === 'POST')) {
        return await preview(request, url);
      }
      if (url.pathname === '/x402/clean_v1' && request.method === 'POST') {
        // Payment is deliberately added in the separate payment PR. Never process a paid request here.
        return json({ code: 'PAYMENT_ROUTE_NOT_READY' }, 503);
      }
      if (url.pathname === '/x402/clean_v1/preview' || url.pathname === '/x402/clean_v1') {
        return json({ code: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, POST' });
      }
      return json({ code: 'NOT_FOUND' }, 404);
    } catch (error) {
      const safe = publicError(error);
      return json({ code: safe.code }, safe.status);
    }
  },
};
