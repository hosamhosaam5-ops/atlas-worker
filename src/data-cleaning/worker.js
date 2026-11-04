import { createCleaningSession, finalizeCleaningSession, parseCsv, parseJson, processCleaningChunk, MAX_FILE_BYTES } from './engine.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const CHUNK_BYTES = 48 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function fault(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
function toBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.length)));
  }
  return btoa(binary);
}
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 70 * 1024) throw fault('CHUNK_ENCODING_INVALID');
  let binary;
  try { binary = atob(value); } catch { throw fault('CHUNK_ENCODING_INVALID'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function joinBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total > MAX_FILE_BYTES) throw fault('FILE_SIZE_LIMIT_EXCEEDED', 413);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
async function readBodyLimited(request) {
  if (!request.body) throw fault('FILE_BODY_REQUIRED');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw fault('FILE_SIZE_LIMIT_EXCEEDED', 413);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw fault('FILE_SIZE_LIMIT_EXCEEDED', 413);
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return joinBytes(parts);
}
function cleanErrorCode(error) {
  const candidate = error && typeof error.code === 'string' ? error.code : 'CLEANING_FAILED';
  return /^[A-Z0-9_]{3,64}$/.test(candidate) ? candidate : 'CLEANING_FAILED';
}
async function deletePrefix(storage, prefix) {
  while (true) {
    const entries = await storage.list({ prefix, limit: 100 });
    if (entries.size === 0) return;
    await storage.delete([...entries.keys()]);
  }
}
async function clearJobStorage(storage) {
  await deletePrefix(storage, '');
}

class RateLimitState {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/consume') {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const body = await request.json();
    const limit = Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 60 ? body.limit : 10;
    const windowMs = Number.isInteger(body.windowMs) && body.windowMs >= 1000 && body.windowMs <= 300_000
      ? body.windowMs : 60_000;
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      let bucket = await this.ctx.storage.get('bucket');
      if (!bucket || now - bucket.windowStartedAt >= windowMs) bucket = { windowStartedAt: now, count: 0 };
      if (bucket.count >= limit) {
        return json({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000)) }, 429);
      }
      bucket.count += 1;
      await this.ctx.storage.put('bucket', bucket);
      await this.ctx.storage.setAlarm(bucket.windowStartedAt + windowMs);
      return json({ allowed: true, remaining: limit - bucket.count, resetAt: bucket.windowStartedAt + windowMs });
    });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

async function constantTimeTokenMatch(provided, expected) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function authorize(request, env) {
  const expected = env.CLEANING_API_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32) {
    return { ok: false, response: json({ error: 'AUTH_NOT_CONFIGURED' }, 503) };
  }
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{32,512})$/.exec(header);
  if (!match || !(await constantTimeTokenMatch(match[1], expected))) {
    return { ok: false, response: json({ error: 'UNAUTHORIZED' }, 401) };
  }
  return { ok: true, token: expected };
}

async function enforceRateLimit(request, env, token) {
  if (!env.RATE_LIMITER) return json({ error: 'RATE_LIMITER_NOT_CONFIGURED' }, 503);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown-client';
  const material = new TextEncoder().encode(token + '\n' + ip);
  const digest = await crypto.subtle.digest('SHA-256', material);
  const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const limitValue = Number(env.CLEANING_RATE_LIMIT_PER_MINUTE);
  const limit = Number.isInteger(limitValue) && limitValue >= 1 && limitValue <= 60 ? limitValue : 10;
  let response;
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    response = await stub.fetch(new Request('https://rate-limit/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit, windowMs: 60_000 }),
    }));
  } catch {
    return json({ error: 'RATE_LIMIT_CHECK_FAILED' }, 503);
  }
  if (response.status === 429) return json({ error: 'RATE_LIMIT_EXCEEDED' }, 429);
  if (!response.ok) return json({ error: 'RATE_LIMIT_CHECK_FAILED' }, 503);
  return null;
}

class JobState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/init') return await this.init(request);
      if (request.method === 'POST' && url.pathname === '/chunk') return await this.addChunk(request);
      if (request.method === 'POST' && url.pathname === '/process') return await this.process();
      if (request.method === 'POST' && url.pathname === '/fail') return await this.fail(request);
      if (request.method === 'GET' && url.pathname === '/status') return await this.status();
      if (request.method === 'GET' && url.pathname === '/result') return await this.deliver();
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ error: cleanErrorCode(error) }, error.status || 500);
    }
  }

  async init(request) {
    const body = await request.json();
    const { jobId, totalChunks, options, expiresAt } = body;
    if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) throw fault('JOB_ID_INVALID');
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) throw fault('CHUNK_COUNT_INVALID');
    if (!options || !['csv', 'json'].includes(options.inputFormat)) throw fault('INPUT_FORMAT_UNSUPPORTED');
    if (!Array.isArray(options.operations)) throw fault('OPERATIONS_MUST_BE_ARRAY');
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get('job');
      if (existing) return json({ error: 'JOB_ALREADY_EXISTS' }, 409);
      const job = {
        id: jobId, status: 'queued', totalChunks, options,
        failAtChunk: Number.isInteger(body.failAtChunk) ? body.failAtChunk : null,
        processAttempts: 0, retryCount: 0, chunkMetrics: [],
        createdAt: Date.now(),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + JOB_TTL_MS,
        errorCode: null, resultBytes: 0, outputFormat: null,
      };
      await this.ctx.storage.put('job', job);
      await this.ctx.storage.setAlarm(job.expiresAt);
      return json({ status: job.status, totalChunks });
    });
  }

  async addChunk(request) {
    const body = await request.json();
    const { index, totalChunks, payload } = body;
    if (!Number.isInteger(index) || !Number.isInteger(totalChunks) ||
        index < 0 || index >= totalChunks || totalChunks > MAX_CHUNKS) throw fault('CHUNK_INDEX_INVALID');
    const decoded = fromBase64(payload);
    if (decoded.byteLength > CHUNK_BYTES) throw fault('CHUNK_SIZE_INVALID');
    return this.ctx.blockConcurrencyWhile(async () => {
      const job = await this.ctx.storage.get('job');
      if (!job) return json({ error: 'JOB_EXPIRED' }, 410);
      if (job.status === 'complete' || job.status === 'failed') return json({ ready: false, status: job.status });
      if (job.totalChunks !== totalChunks) throw fault('CHUNK_COUNT_MISMATCH');
      await this.ctx.storage.put('input:' + String(index).padStart(4, '0'), payload);
      const entries = await this.ctx.storage.list({ prefix: 'input:', limit: MAX_CHUNKS + 1 });
      return json({ ready: entries.size === job.totalChunks, receivedChunks: entries.size, status: job.status });
    });
  }

  async process() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const job = await this.ctx.storage.get('job');
      if (!job) return json({ error: 'JOB_EXPIRED' }, 410);
      if (job.status === 'complete') return json({ status: 'complete', resultBytes: job.resultBytes });
      if (job.status === 'failed') return json({ status: 'failed', errorCode: job.errorCode }, 422);
      if (job.status !== 'queued' && job.status !== 'processing') return json({ error: 'JOB_STATE_INVALID' }, 409);

      const entries = await this.ctx.storage.list({ prefix: 'input:', limit: MAX_CHUNKS + 1 });
      if (entries.size !== job.totalChunks) return json({ error: 'CHUNKS_INCOMPLETE' }, 409);

      try {
        const parts = [...entries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, payload]) => fromBase64(payload));
        const input = joinBytes(parts);
        const parsed = job.options.inputFormat === 'csv'
          ? parseCsv(input, job.options)
          : parseJson(input, job.options);
        const chunkRows = job.options.chunkRows;
        const processingChunkCount = Math.max(1, Math.ceil(parsed.rows.length / chunkRows));
        if (job.failAtChunk !== null && job.failAtChunk !== undefined &&
            (!Number.isInteger(job.failAtChunk) || job.failAtChunk < 0 || job.failAtChunk >= processingChunkCount)) {
          throw fault('TEST_FAILURE_CHUNK_OUT_OF_RANGE');
        }

        let session = await this.ctx.storage.get('session');
        if (!session) session = createCleaningSession(parsed, job.options);
        job.status = 'processing';
        job.processAttempts = (job.processAttempts || 0) + 1;
        job.inputRowCount = parsed.rowCount;
        job.processingChunkRows = chunkRows;
        job.processingChunkCount = processingChunkCount;
        job.chunkMetrics = job.chunkMetrics || [];
        await this.ctx.storage.put('job', job);

        for (let index = 0; index < processingChunkCount; index++) {
          if (await this.ctx.storage.get('processed:' + index)) continue;
          const sourceRows = parsed.rows.slice(index * chunkRows, (index + 1) * chunkRows);
          const started = performance.now();
          const outputRows = processCleaningChunk(sourceRows, session);
          const computeMs = Number((performance.now() - started).toFixed(3));
          const metric = { index, inputRows: sourceRows.length, outputRows: outputRows.length, computeMs };
          job.chunkMetrics[index] = metric;
          await this.ctx.storage.put({
            session,
            job,
            ['processed:' + index]: true,
            ['rows:' + index]: outputRows,
          });

          // Test-only fault is injected after the middle chunk is durably committed.
          // The Queue retries its trigger message; the processed marker prevents duplicate work.
          if (job.failAtChunk === index && !job.failureInjected) {
            job.failureInjected = true;
            job.retryCount = (job.retryCount || 0) + 1;
            await this.ctx.storage.put('job', job);
            return json({ error: 'SIMULATED_TRANSIENT_FAILURE' }, 503);
          }
        }

        const outputChunks = [];
        for (let index = 0; index < processingChunkCount; index++) {
          const chunk = await this.ctx.storage.get('rows:' + index);
          if (!Array.isArray(chunk)) throw fault('PROCESSED_CHUNK_MISSING', 500);
          outputChunks.push(chunk);
        }
        const result = finalizeCleaningSession(session, outputChunks);
        const outputValues = {};
        for (let offset = 0, index = 0; offset < result.bytes.byteLength; offset += CHUNK_BYTES, index++) {
          const part = result.bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, result.bytes.byteLength));
          outputValues['output:' + String(index).padStart(4, '0')] = toBase64(part);
        }
        if (Object.keys(outputValues).length > MAX_CHUNKS) throw fault('OUTPUT_CHUNK_LIMIT_EXCEEDED', 413);
        await this.ctx.storage.put(outputValues);
        await deletePrefix(this.ctx.storage, 'input:');
        await deletePrefix(this.ctx.storage, 'rows:');
        await deletePrefix(this.ctx.storage, 'processed:');
        await this.ctx.storage.delete('session');

        const computeTimes = job.chunkMetrics.map(metric => metric.computeMs).sort((a, b) => a - b);
        const p95Index = Math.max(0, Math.ceil(computeTimes.length * 0.95) - 1);
        job.status = 'complete';
        job.resultBytes = result.bytes.byteLength;
        job.outputFormat = result.outputFormat;
        job.outputRowCount = result.rowCount;
        job.completedAt = Date.now();
        job.p95ChunkComputeMs = computeTimes.length ? computeTimes[p95Index] : 0;
        job.maxChunkComputeMs = computeTimes.length ? computeTimes[computeTimes.length - 1] : 0;
        job.processedChunkCount = processingChunkCount;
        await this.ctx.storage.put('job', job);
        return json({
          status: 'complete',
          resultBytes: job.resultBytes,
          outputFormat: job.outputFormat,
          processingChunkCount,
          processAttempts: job.processAttempts,
          retryCount: job.retryCount || 0,
          p95ChunkComputeMs: job.p95ChunkComputeMs,
          maxChunkComputeMs: job.maxChunkComputeMs,
        });
      } catch (error) {
        if (error?.status === 500 && error?.code === 'PROCESSED_CHUNK_MISSING') throw error;
        job.status = 'failed';
        job.errorCode = cleanErrorCode(error);
        await this.ctx.storage.put('job', job);
        await deletePrefix(this.ctx.storage, 'input:');
        await deletePrefix(this.ctx.storage, 'rows:');
        await deletePrefix(this.ctx.storage, 'processed:');
        await this.ctx.storage.delete('session');
        return json({ status: 'failed', errorCode: job.errorCode }, 422);
      }
    });
  }

  async fail(request) {
    const body = await request.json().catch(() => ({}));
    return this.ctx.blockConcurrencyWhile(async () => {
      const job = await this.ctx.storage.get('job');
      if (!job) return json({ error: 'JOB_EXPIRED' }, 410);
      if (job.status === 'complete') return json({ status: 'complete' }, 409);
      job.status = 'failed';
      job.errorCode = cleanErrorCode({ code: body.code || 'QUEUE_SUBMISSION_FAILED' });
      await this.ctx.storage.put('job', job);
      await clearJobStorage(this.ctx.storage);
      await this.ctx.storage.put('job', job);
      return json({ status: 'failed', errorCode: job.errorCode });
    });
  }

  async status() {
    const job = await this.ctx.storage.get('job');
    if (!job) return json({ error: 'JOB_NOT_FOUND' }, 404);
    return json({
      jobId: job.id, status: job.status, errorCode: job.errorCode,
      resultBytes: job.status === 'complete' ? job.resultBytes : undefined,
      outputFormat: job.status === 'complete' ? job.outputFormat : undefined,
      inputRowCount: job.inputRowCount,
      outputRowCount: job.outputRowCount,
      processingChunkRows: job.processingChunkRows,
      processingChunkCount: job.processingChunkCount,
      processedChunkCount: job.processedChunkCount,
      processAttempts: job.processAttempts,
      retryCount: job.retryCount,
      p95ChunkComputeMs: job.p95ChunkComputeMs,
      maxChunkComputeMs: job.maxChunkComputeMs,
      chunkMetrics: job.chunkMetrics,
    });
  }

  async deliver() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const job = await this.ctx.storage.get('job');
      if (!job) return json({ error: 'JOB_NOT_FOUND' }, 404);
      if (job.status === 'failed') return json({ error: job.errorCode || 'CLEANING_FAILED' }, 422);
      if (job.status !== 'complete') return json({ error: 'JOB_NOT_READY' }, 409);
      const entries = await this.ctx.storage.list({ prefix: 'output:', limit: MAX_CHUNKS + 1 });
      const parts = [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, payload]) => fromBase64(payload));
      const bytes = joinBytes(parts);
      if (bytes.byteLength !== job.resultBytes) throw fault('RESULT_SIZE_MISMATCH', 500);
      await clearJobStorage(this.ctx.storage);
      await this.ctx.storage.deleteAlarm();
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': job.outputFormat === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
          'x-atlas-temporary-job-deleted': 'true',
        },
      });
    });
  }

  async alarm() { await clearJobStorage(this.ctx.storage); }
}

async function readOptions(request) {
  const raw = request.headers.get('x-atlas-cleaning-options') || '';
  if (!raw || raw.length > 16 * 1024) throw fault('CLEANING_OPTIONS_REQUIRED');
  try {
    const options = JSON.parse(raw);
    if (!options || !['csv', 'json'].includes(options.inputFormat) || !Array.isArray(options.operations)) {
      throw fault('CLEANING_OPTIONS_INVALID');
    }
    const chunkRows = options.chunkRows === undefined ? 250 : options.chunkRows;
    if (!Number.isInteger(chunkRows) || chunkRows < 1 || chunkRows > 500) throw fault('CHUNK_ROWS_INVALID');
    return { ...options, chunkRows };
  } catch (error) {
    if (error.code) throw error;
    throw fault('CLEANING_OPTIONS_INVALID');
  }
}

async function handleCreateJob(request, env) {
  let options;
  try { options = await readOptions(request); }
  catch (error) { return json({ error: cleanErrorCode(error) }, 400); }
  let bytes;
  try { bytes = await readBodyLimited(request); }
  catch (error) { return json({ error: cleanErrorCode(error) }, error.status || 400); }

  const jobId = crypto.randomUUID();
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  let failAtChunk = null;
  const failHeader = request.headers.get('x-atlas-test-fail-chunk');
  if (env.TEST_MODE === '1' && failHeader !== null) {
    if (!/^\d+$/.test(failHeader)) return json({ error: 'TEST_FAILURE_CHUNK_INVALID' }, 400);
    failAtChunk = Number(failHeader);
  }
  let stub;
  let init;
  try {
    stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobId));
    init = await stub.fetch(new Request('https://job/init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, totalChunks, options, failAtChunk, expiresAt: Date.now() + JOB_TTL_MS }),
    }));
  } catch {
    return json({ error: 'JOB_INITIALIZATION_FAILED' }, 503);
  }
  if (!init.ok) return json({ error: 'JOB_INITIALIZATION_FAILED' }, 503);

  const messages = [];
  for (let index = 0; index < totalChunks; index++) {
    const part = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.byteLength));
    messages.push({ body: { jobId, index, totalChunks, payload: toBase64(part) } });
  }
  try {
    for (let offset = 0; offset < messages.length; offset += 3) {
      await env.ATLAS_CLEANING_QUEUE.sendBatch(messages.slice(offset, offset + 3));
    }
  } catch {
    await stub.fetch(new Request('https://job/fail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'QUEUE_SUBMISSION_FAILED' }),
    })).catch(() => {});
    return json({ error: 'QUEUE_SUBMISSION_FAILED' }, 503);
  }
  return json({ jobId, status: 'queued', chunks: totalChunks }, 202);
}

export { JobState, RateLimitState };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      const auth = await authorize(request, env);
      if (!auth.ok) return auth.response;
      const limited = await enforceRateLimit(request, env, auth.token);
      if (limited) return limited;
      return handleCreateJob(request, env);
    }
    const publicMatch = new RegExp('^/v1/jobs/([0-9a-f-]{36})/(status|result)$', 'i').exec(url.pathname);
    if (publicMatch && request.method === 'GET') {
      const auth = await authorize(request, env);
      if (!auth.ok) return auth.response;
      const stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(publicMatch[1]));
      return stub.fetch(new Request('https://job/' + publicMatch[2], { method: 'GET' }));
    }

    if (env.TEST_MODE === '1') {
      if (request.method === 'GET' && url.pathname === '/__test/health') {
        return json({ ok: true, scope: 'local-test-only' });
      }
      if (request.method === 'POST' && url.pathname === '/__test/jobs') return handleCreateJob(request, env);
      const testMatch = new RegExp('^/__test/jobs/([0-9a-f-]{36})/(status|result)$', 'i').exec(url.pathname);
      if (testMatch && request.method === 'GET') {
        const stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(testMatch[1]));
        return stub.fetch(new Request('https://job/' + testMatch[2], { method: 'GET' }));
      }
    }
    return new Response('Not Found', { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        if (!body || typeof body.jobId !== 'string') { message.ack(); continue; }
        const stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(body.jobId));
        const chunkResponse = await stub.fetch(new Request('https://job/chunk', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index: body.index, totalChunks: body.totalChunks, payload: body.payload }),
        }));
        if (chunkResponse.status === 410 || chunkResponse.status === 404) { message.ack(); continue; }
        if (!chunkResponse.ok) {
          if (chunkResponse.status >= 500) message.retry({ delaySeconds: 1 });
          else message.ack();
          continue;
        }
        const chunkResult = await chunkResponse.json();
        if (chunkResult.ready) {
          const processResponse = await stub.fetch(new Request('https://job/process', { method: 'POST' }));
          if (processResponse.status >= 500) message.retry({ delaySeconds: 1 });
          else message.ack();
        } else message.ack();
      } catch {
        message.retry({ delaySeconds: 1 });
      }
    }
  },
};
