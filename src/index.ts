// ATLAS Worker — M2: Telegram webhook (receive + log only) + async CEO pipeline.
// The webhook NEVER runs CEO reasoning synchronously: it inserts into event_log
// (idempotency at DB level) and defers heavy processing via ctx.waitUntil.
// AI_PROVIDER=MOCK by default — zero external AI calls in M2.

// @ts-ignore — JS module without declaration file (Worker bundler resolves it)
import { processUpdate } from './ceo/pipeline.js';
// @ts-ignore
import { handleChatGptBridge } from './bridges/chatgpt.js';
// @ts-ignore
import { handleSiweBridge } from './bridges/siwe.js';
// @ts-ignore
import { handleBountyBookAuth } from './bridges/bountybook.js';
// @ts-ignore
import { processOrder } from './orders/intake.js';
// @ts-ignore
import { ensureOrderSchema } from './orders/schema.js';
// @ts-ignore
import { runDailyReport } from './crons/dailyReport.js';
// @ts-ignore
import { runRevenueWatch } from './crons/revenueWatch.js';
// @ts-ignore
import { runTelegraphMonitor } from './crons/telegraphMonitor.js';
// @ts-ignore
import { getTelegramProvider } from './core/outbox.js';

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  AI_PROVIDER?: string;
  AI_MOCK_SCENARIO?: string;
  OPENROUTER_API_KEY?: string;
  ORDER_WEBHOOK_SECRET?: string;
  PROCESS_SYNC?: string; // '1' for local tests: run pipeline inline and return its result
  DEV_MODE?: string;     // '1' for local tests only: enables /dev/* inspection endpoints. NEVER set in production.
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      let db = 'unknown';
      try {
        await env.DB.prepare('SELECT 1').first();
        db = 'ok';
      } catch (e) {
        db = 'error';
      }
      return json({ ok: true, service: 'atlas-worker', phase: 'M5', db, ai_provider: env.AI_PROVIDER || 'MOCK', brave: env.BRAVE || 'MOCK', telegram: env.TELEGRAM_PROVIDER || 'MOCK', email: env.EMAIL_PROVIDER || 'MOCK', payment: env.PAYMENT_PROVIDER || 'MOCK' });
    }

    // ---- M3 bridges (same contracts as backup workflows; MOCK adapters by default) ----
    if (url.pathname === '/bridge/chatgpt' && request.method === 'POST') {
      return handleChatGptBridge(request, env);
    }
    if (url.pathname === '/bridge/siwe') {
      return handleSiweBridge(request, env);
    }
    if (url.pathname === '/bridge/bountybook') {
      return handleBountyBookAuth(request, env);
    }

    // ---- M4 Order Intake (ports the n8n Form Trigger; multipart/form-data with file upload) ----
    if (url.pathname === '/webhook/order' && request.method === 'POST') {
      // Fail closed: this endpoint handles paid orders and must never be public by
      // accident. A missing secret disables the endpoint rather than bypassing auth.
      if (!env.ORDER_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'order webhook not configured' }, 503);
      }
      const suppliedSecret = request.headers.get('x-atlas-order-webhook-secret');
      if (suppliedSecret !== env.ORDER_WEBHOOK_SECRET) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      const t0 = Date.now();
      await ensureOrderSchema(env.DB);
      let input: any = {};
      const ct = request.headers.get('content-type') || '';
      try {
        if (ct.includes('multipart/form-data')) {
          const form = await request.formData();
          input.client_email = form.get('client_email');
          input.tx_hash = form.get('tx_hash');
          const file = form.get('file_upload');
          if (file && typeof file === 'object' && 'arrayBuffer' in file) {
            input.__file_name = (file as File).name;
            input.__file_bytes = new Uint8Array(await (file as File).arrayBuffer());
          }
        } else {
          // JSON test path (no real file possible — used only by local tests)
          const body: any = await request.json();
          input.client_email = body.client_email;
          input.tx_hash = body.tx_hash;
          if (body.file_base64) {
            input.__file_name = body.file_name || 'upload.csv';
            const bin = atob(body.file_base64);
            input.__file_bytes = Uint8Array.from(bin, (c: string) => c.charCodeAt(0));
          }
        }
      } catch {
        return json({ ok: false, error: 'bad request body' }, 400);
      }
      try {
        const result = await processOrder(env.DB, env, input);
        return json({ ok: true, ...result, webhook_latency_ms: Date.now() - t0 });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    // Dev-only inspection of order state (local tests)
    if (url.pathname === '/dev/orders' && request.method === 'GET') {
      await ensureOrderSchema(env.DB);
      const { results } = await env.DB.prepare('SELECT * FROM order_ledger ORDER BY created_at DESC LIMIT 50').all();
      const outbox = await env.DB.prepare('SELECT order_id, channel, status, attempts, last_error FROM delivery_outbox ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, ledger: results, outbox: outbox.results });
    }

    if (url.pathname === '/webhook/telegram' && request.method === 'POST') {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const token = request.headers.get('x-telegram-bot-api-secret-token');
        if (token !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'forbidden' }, 403);
      }

      const t0 = Date.now();
      let update: any;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: 'bad json' }, 400);
      }

      const updateId = update?.update_id;
      if (updateId === undefined || updateId === null) {
        return json({ ok: false, error: 'missing update_id' }, 400);
      }
      // webhook only accepts message-bearing updates for CEO processing; others are ACKed
      const hasMessage = !!(update.message && typeof update.message.text === 'string');

      let eventPk: number | null = null;
      let status: 'ACCEPTED' | 'DUPLICATE' | 'IGNORED' | 'ERROR';
      let errorText: string | null = null;

      if (!hasMessage) {
        return json({ ok: true, status: 'IGNORED', update_id: updateId, latency_ms: Date.now() - t0 });
      }

      try {
        const res = await env.DB.prepare(
          "INSERT INTO event_log (source, external_id, payload_json, status) VALUES (?, ?, ?, 'PENDING')"
        )
          .bind('telegram', String(updateId), JSON.stringify(update))
          .run();
        eventPk = res.meta.last_row_id as number;
        status = 'ACCEPTED';
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.toLowerCase().includes('unique')) {
          status = 'DUPLICATE';
        } else {
          status = 'ERROR';
          errorText = msg;
        }
      }

      const latency = Date.now() - t0;

      if (status === 'ACCEPTED' && eventPk !== null) {
        const timings: Record<string, number> = {};
        const run = () => processUpdate(env, update, eventPk as number, timings)
          .then((result: any) => ({ result, timings }))
          .catch(async (err: any) => {
            // last-resort: never lose the event; record the failure
            try {
              await env.DB.prepare('UPDATE event_log SET status = ?, error = ? WHERE id = ?')
                .bind('PIPELINE_ERROR', String(err?.message || err), eventPk).run();
            } catch { /* nothing else to do */ }
            return { result: { outcome: 'PIPELINE_ERROR', error: String(err?.message || err) }, timings };
          });
        if (env.PROCESS_SYNC === '1') {
          // local test mode: run inline so tests can assert on the result
          const out = await run();
          return json({ ok: true, status, update_id: updateId, latency_ms: latency, pipeline: out.result, timings: out.timings });
        }
        // production shape: async — webhook returns immediately, heavy work continues
        ctx.waitUntil(run());
      }

      return json({ ok: true, status, update_id: updateId, error: errorText, latency_ms: latency });
    }

    // ---- local test/inspection endpoints (dev only, no secrets) ----
    // Production guard: /dev/* is reachable ONLY when DEV_MODE='1' is set explicitly.
    // DEV_MODE is never declared in wrangler.toml [vars], so a deployed Worker 404s these.
    if (url.pathname.startsWith('/dev/') && env.DEV_MODE !== '1') {
      return json({ ok: false, error: 'not found' }, 404);
    }
    if (url.pathname === '/dev/state' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT idempotency_key, record_kind, request_id, entity_type, entity_id, status, progress, error_code, delivery_state FROM execution_state LIMIT 200').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/memory' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, category, content, created_at FROM ceo_memory ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/events' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, source, external_id, status, error, created_at FROM event_log ORDER BY id DESC LIMIT 50').all();
      return json({ ok: true, rows: results });
    }
    if (url.pathname === '/dev/reset' && request.method === 'POST') {
      // local-only reset between test scenarios — never exposed in production config
      await env.DB.prepare('DELETE FROM event_log').run();
      await env.DB.prepare('DELETE FROM execution_state').run();
      await env.DB.prepare('DELETE FROM ceo_memory').run();
      await ensureOrderSchema(env.DB);
      await env.DB.prepare('DELETE FROM order_ledger').run();
      await env.DB.prepare('DELETE FROM order_quotes').run();
      await env.DB.prepare('DELETE FROM order_files').run();
      await env.DB.prepare('DELETE FROM delivery_outbox').run();
      return json({ ok: true, reset: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // M6A item 7/8: Cron entry point. Schedules are declared in wrangler.toml but stay
  // commented until the founder activates them at deploy. The handler runs all three
  // engines idempotently (each engine self-skips when there is nothing new).
  // alertAdapter bridges to the LIVE/MOCK telegram provider; MOCK sends nothing.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const tg = getTelegramProvider(env as any);
    const alertAdapter = {
      async send(chatId: string, text: string, _opts: any) {
        const res = await tg.send({ to: chatId, text });
        return res && res.ok ? { message_id: res.provider_message_id } : null;
      },
    };
    const run = async () => {
      const results: Record<string, unknown> = {};
      for (const [name, fn] of [
        ['daily_report', () => runDailyReport(env, undefined, alertAdapter)],
        ['revenue_watch', () => runRevenueWatch(env, undefined, alertAdapter)],
        ['telegraph_monitor', () => runTelegraphMonitor(env, undefined, alertAdapter)],
      ] as const) {
        try { results[name] = await fn(); }
        catch (e: any) { results[name] = { error: String(e?.message || e) }; }
      }
      return results;
    };
    ctx.waitUntil(run());
  },
};
