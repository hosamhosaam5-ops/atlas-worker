import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function createAtlasMcpServer(env) {
  const server = new McpServer({
    name: "ATLAS Cloudflare",
    version: "1.0.0",
  });

  server.registerTool(
    "health",
    {
      description: "Read-only ATLAS Worker health and provider configuration status. Never returns secrets.",
      inputSchema: {},
    },
    async () => {
      let db = "unknown";
      try {
        await env.DB.prepare("SELECT 1").first();
        db = "ok";
      } catch {
        db = "error";
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: db === "ok",
            service: "atlas-worker",
            db,
            ai_provider: env.AI_PROVIDER || "MOCK",
            ai_model: env.AI_MODEL || null,
            telegram: env.TELEGRAM_PROVIDER || "MOCK",
            brave: env.BRAVE || "MOCK",
            email: env.EMAIL_PROVIDER || "MOCK",
            payment: env.PAYMENT_PROVIDER || "MOCK",
          }),
        }],
      };
    },
  );

  server.registerTool(
    "read_state",
    {
      description: "Read ATLAS execution state from D1. Read-only; secrets are not returned.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ limit = 50 }) => {
      const { results } = await env.DB.prepare(
        "SELECT idempotency_key, record_kind, correlation_id, request_id, entity_type, entity_id, action_id, tool, status, progress, error_code, attempt_count, delivery_state, message_key, expires_at, created_at, updated_at FROM execution_state ORDER BY updated_at DESC LIMIT ?"
      ).bind(limit).all();
      return {
        content: [{ type: "text", text: JSON.stringify({ rows: results || [] }) }],
      };
    },
  );

  server.registerTool(
    "read_tables",
    {
      description: "Read ATLAS CEO memory and key operational table counts. Read-only; secrets are not returned.",
      inputSchema: {
        memory_limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ memory_limit = 20 }) => {
      const memory = await env.DB.prepare(
        "SELECT id, category, content, created_at FROM ceo_memory ORDER BY id DESC LIMIT ?"
      ).bind(memory_limit).all();
      const counts = {};
      for (const table of ["event_log", "execution_state", "ceo_memory", "delivery_outbox", "bridge_audit"]) {
        try {
          const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM " + table).first();
          counts[table] = Number(row?.count || 0);
        } catch {
          counts[table] = null;
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ counts, ceo_memory: memory.results || [] }),
        }],
      };
    },
  );

  server.registerTool(
    "read_workflow_metadata",
    {
      description: "Read ATLAS Cloudflare Worker metadata and exposed MCP capabilities. Read-only.",
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          service: "ATLAS Cloudflare Worker",
          bridge: "/bridge/chatgpt",
          mcp: "/mcp",
          mcp_mode: "READ_ONLY",
          mcp_transport: "Streamable HTTP",
          write_execute_via_mcp: false,
          note: "Write/execute MCP tools are intentionally withheld until authenticated authorization is implemented.",
        }),
      }],
    }),
  );

  return server;
}
