export async function handleAtlasMcp(request, env) {
  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  if (request.method !== "POST") {
    return json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method Not Allowed" } },
      405,
      { Allow: "POST" },
    );
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, 400);
  }

  const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  const result = (payload) =>
    json(
      { jsonrpc: "2.0", id, ...payload },
      200,
      { "MCP-Protocol-Version": "2025-03-26" },
    );

  if (!msg || msg.jsonrpc !== "2.0") {
    return result({ error: { code: -32600, message: "Invalid Request" } });
  }

  if (msg.method === "initialize") {
    return result({
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ATLAS Cloudflare", version: "1.0.0" },
      },
    });
  }

  if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (msg.method === "ping") return result({ result: {} });

  if (msg.method === "tools/list") {
    return result({
      result: {
        tools: [
          {
            name: "health",
            description: "Read-only ATLAS Worker health and provider status; never returns secrets.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "read_state",
            description: "Read ATLAS execution state from D1. Read-only.",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
              additionalProperties: false,
            },
          },
          {
            name: "read_tables",
            description: "Read ATLAS CEO memory and operational table counts. Read-only.",
            inputSchema: {
              type: "object",
              properties: { memory_limit: { type: "integer", minimum: 1, maximum: 100 } },
              additionalProperties: false,
            },
          },
          {
            name: "read_workflow_metadata",
            description: "Read ATLAS Worker and MCP metadata. Read-only.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  }

  if (msg.method !== "tools/call") {
    return result({ error: { code: -32601, message: "Method not found" } });
  }

  const name = msg.params?.name;
  const args = msg.params?.arguments || {};
  let out;

  try {
    if (name === "health") {
      let db = "unknown";
      try {
        await env.DB.prepare("SELECT 1").first();
        db = "ok";
      } catch {}
      out = {
        ok: db === "ok",
        service: "atlas-worker",
        db,
        ai_provider: env.AI_PROVIDER || "MOCK",
        ai_model: env.AI_MODEL || null,
        telegram: env.TELEGRAM_PROVIDER || "MOCK",
        brave: env.BRAVE || "MOCK",
        email: env.EMAIL_PROVIDER || "MOCK",
        payment: env.PAYMENT_PROVIDER || "MOCK",
      };
    } else if (name === "read_state") {
      const limit = Math.min(200, Math.max(1, Number(args.limit || 50)));
      const q = await env.DB.prepare(
        "SELECT idempotency_key,record_kind,correlation_id,request_id,entity_type,entity_id,action_id,tool,status,progress,error_code,attempt_count,delivery_state,message_key,expires_at,created_at,updated_at FROM execution_state ORDER BY updated_at DESC LIMIT ?",
      ).bind(limit).all();
      out = { rows: q.results || [] };
    } else if (name === "read_tables") {
      const limit = Math.min(100, Math.max(1, Number(args.memory_limit || 20)));
      const memory = await env.DB.prepare(
        "SELECT id,category,content,created_at FROM ceo_memory ORDER BY id DESC LIMIT ?",
      ).bind(limit).all();
      const counts = {};
      for (const table of ["event_log", "execution_state", "ceo_memory", "delivery_outbox", "bridge_audit"]) {
        try {
          const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM " + table).first();
          counts[table] = Number(row?.count || 0);
        } catch {
          counts[table] = null;
        }
      }
      out = { counts, ceo_memory: memory.results || [] };
    } else if (name === "read_workflow_metadata") {
      out = {
        service: "ATLAS Cloudflare Worker",
        bridge: "/bridge/chatgpt",
        mcp: "/mcp",
        mcp_mode: "READ_ONLY",
        mcp_transport: "Streamable HTTP",
        write_execute_via_mcp: false,
      };
    } else {
      return result({ error: { code: -32602, message: "Unknown tool" } });
    }
  } catch (e) {
    return result({
      result: {
        isError: true,
        content: [{ type: "text", text: String(e?.message || e) }],
      },
    });
  }

  return result({
    result: {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out,
    },
  });
}
