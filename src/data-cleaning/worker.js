import { executeCleaningJob, MAX_FILE_BYTES } from './engine.js';

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
      const parts = [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, payload]) => fromBase64(payload));
      let result;
      try {
        const input = joinBytes(parts);
        result = executeCleaningJob(input, job.options);
      } catch (error) {
        job.status = 'failed';
        job.errorCode = cleanErrorCode(error);
        await this.ctx.storage.put('job', job);
        await deletePrefix(this.ctx.storage, 'input:');
        return json({ status: 'failed', errorCode: job.errorCode }, 422);
      }
      const outputValues = {};
      for (let offset = 0, index = 0; offset < result.bytes.byteLength; offset += CHUNK_BYTES, index++) {
        const part = result.bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, result.bytes.byteLength));
        outputValues['output:' + String(index).padStart(4, '0')] = toBase64(part);
      }
      if (Object.keys(outputValues).length > MAX_CHUNKS) throw fault('OUTPUT_CHUNK_LIMIT_EXCEEDED', 413);
      await this.ctx.storage.put(outputValues);
      await deletePrefix(this.ctx.storage, 'input:');
      job.status = 'complete';
      job.resultBytes = result.bytes.byteLength;
      job.outputFormat = result.outputFormat;
      job.completedAt = Date.now();
      await this.ctx.storage.put('job', job);
      return json({ status: 'complete', resultBytes: job.resultBytes, outputFormat: job.outputFormat });
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
    return options;
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
  const stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(jobId));
  const init = await stub.fetch(new Request('https://job/init', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, totalChunks, options, expiresAt: Date.now() + JOB_TTL_MS }),
  }));
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

export { JobState };

export default {
  async fetch(request, env) {
    if (env.TEST_MODE !== '1') return new Response('Not Found', { status: 404 });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/__test/jobs') return handleCreateJob(request, env);
    const match = /^\/__test\/jobs\/([0-9a-f-]{36})\/(status|result)$/i.exec(url.pathname);
    if (match && request.method === 'GET') {
      const stub = env.JOB_STATE.get(env.JOB_STATE.idFromName(match[1]));
      return stub.fetch(new Request('https://job/' + match[2], { method: 'GET' }));
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
