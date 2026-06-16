// BudgetKit MCP server — stdio JSON-RPC 2.0.
//
// Why no @modelcontextprotocol/sdk: the protocol surface we need is small
// (initialize, tools/list, tools/call, plus error responses). A hand-rolled
// reader keeps the dependency footprint minimal and the wire format
// directly inspectable in tests.
//
// Transport: line-delimited JSON-RPC over stdin/stdout. One JSON object per
// line. stderr is reserved for diagnostics.
//
// Wire shape:
//   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
//   {"jsonrpc":"2.0","id":2,"method":"tools/list"}
//   {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"...","arguments":{...}}}

import {
  ALL_TOOLS,
  NeedsConfirmationError,
  ToolArgError,
  ToolRegistry,
  SCHEMA_VERSION,
  type JsonSchema,
  type ToolDef,
} from "@budgetkit/core";
import { openDb, migrate, buildToolCtx } from "@budgetkit/db";
import { createInterface } from "node:readline";

const SERVER_INFO = {
  name: "budgetkit-mcp",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2024-11-05";

// Consent-gated registry (C1 / audit MCP-1): mutating tools refuse to run
// unless the call carries mutationConsent. The MCP transport maps a
// `confirm: true` argument (advertised on every mutating tool's inputSchema
// below) to that consent and strips it before invocation.
const registry = new ToolRegistry(ALL_TOOLS, { requireMutationConsent: true });

/** Schema fragment advertised for the `confirm` argument on mutating tools. */
const CONFIRM_PROP: JsonSchema = {
  type: "boolean",
  description:
    "REQUIRED for this tool: it MODIFIES budget data. Set to true only after " +
    "the user has explicitly approved this exact action; calls without " +
    "confirm:true are rejected.",
};

/**
 * The inputSchema a tool advertises over tools/list. Mutating tools get a
 * `confirm` boolean appended (and marked required) so MCP hosts surface the
 * confirmation contract to the model; read-only tools are unchanged. The
 * `confirm` key is stripped from arguments before the registry validates
 * them, so the underlying tool schemas never see it.
 */
function advertisedSchema(t: ToolDef): JsonSchema {
  if (t.readOnly === true) return t.inputSchema;
  const schema = t.inputSchema;
  // All registry tools use object input schemas; guard defensively anyway.
  if (schema.type !== "object") return schema;
  return {
    ...schema,
    properties: { ...schema.properties, confirm: CONFIRM_PROP },
    required: [...(schema.required ?? []), "confirm"],
  };
}

// MCP servers connect ONCE per session. The DB stays open for the session.
const db = openDb();
migrate(db);
const ctx = buildToolCtx(db, "mcp_client");

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function write(msg: JsonRpcResponse): void {
  // JSON-RPC over stdio uses newline-delimited objects; flush per-message.
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function diag(line: string): void {
  process.stderr.write(`[budgetkit-mcp] ${line}\n`);
}

function err(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications (no id) are fire-and-forget.
  const isNotification = req.id === undefined;

  try {
    switch (req.method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: { listChanged: false },
            },
            instructions: `BudgetKit MCP — exposes ${ALL_TOOLS.length} tools for budget/scenario manipulation. DB schema v${SCHEMA_VERSION}.`,
          },
        };
      }
      case "initialized":
      case "notifications/initialized": {
        // Notification from client; no response expected.
        return null;
      }
      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: registry.list().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: advertisedSchema(t),
            })),
          },
        };
      }
      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: unknown;
        };
        if (typeof params.name !== "string") {
          return err(id, -32602, "Invalid params: 'name' must be a string");
        }
        // Pull the transport-level `confirm` flag out of the arguments (it is
        // advertised on mutating tools' schemas but is NOT part of the
        // underlying tool input) and map it to registry mutation consent.
        let toolArgs: unknown = params.arguments ?? {};
        let mutationConsent = false;
        if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
          const rec = toolArgs as Record<string, unknown>;
          if ("confirm" in rec) {
            mutationConsent = rec.confirm === true;
            const { confirm: _stripped, ...rest } = rec;
            toolArgs = rest;
          }
        }
        try {
          const result = await registry.invoke(params.name, toolArgs, ctx, { mutationConsent });
          // MCP wraps tool results in a structured shape with content blocks.
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: false,
            },
          };
        } catch (e) {
          const msg = (e as Error).message;
          if (e instanceof NeedsConfirmationError) {
            // Missing confirmation is a caller-protocol problem, not a tool
            // failure — surface it as a JSON-RPC error (invalid params) so
            // hosts can distinguish "ask the user, then retry with
            // confirm:true" from a genuine tool error.
            return err(
              id,
              -32602,
              `Tool "${e.toolName}" modifies budget data and was called without ` +
                `"confirm": true. Ask the user to approve this exact action, then ` +
                `retry the call with "confirm": true in arguments.`,
              { code: e.code, tool: e.toolName },
            );
          }
          if (e instanceof ToolArgError) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Validation error: ${msg}` }],
                isError: true,
              },
            };
          }
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Tool failed: ${msg}` }],
              isError: true,
            },
          };
        }
      }
      case "ping": {
        return { jsonrpc: "2.0", id, result: {} };
      }
      case "shutdown": {
        return { jsonrpc: "2.0", id, result: null };
      }
      default: {
        if (isNotification) return null;
        return err(id, -32601, `Method not found: ${req.method}`);
      }
    }
  } catch (e) {
    if (isNotification) return null;
    return err(id, -32603, `Internal error: ${(e as Error).message}`);
  }
}

// Read JSON-RPC messages line-by-line from stdin.
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed);
  } catch {
    write(err(null, -32700, "Parse error: invalid JSON"));
    return;
  }
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    write(err(req.id ?? null, -32600, "Invalid Request: missing jsonrpc/method"));
    return;
  }
  const res = await handle(req);
  if (res) write(res);
});

rl.on("close", () => {
  diag("stdin closed; exiting");
  try {
    db.close();
  } catch {
    // ignore close errors
  }
  process.exit(0);
});

diag(`ready; ${ALL_TOOLS.length} tools registered (schema v${SCHEMA_VERSION})`);
