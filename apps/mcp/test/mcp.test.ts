// MCP stdio JSON-RPC integration test. Spawns the actual binary via tsx,
// pipes requests in, reads responses out. This is the closest thing to
// "Claude Desktop just registered this server and called it."

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-mcp-test-"));
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * Spawn the MCP server in a child process. Yields a typed object with
 * helpers to send a request and await its response.
 */
function spawnMcp(): {
  proc: ChildProcessWithoutNullStreams;
  request: (req: object) => Promise<unknown>;
  notify: (req: object) => void;
  close: () => Promise<void>;
} {
  const dbPath = join(tmpRoot, `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const entry = resolve(import.meta.dirname, "..", "src", "index.ts");
  const proc = spawn(
    process.execPath,
    ["--import", "tsx/esm", entry],
    {
      env: { ...process.env, BUDGETKIT_DB: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Buffer stdout into newline-delimited records keyed by id.
  const pending = new Map<number | string, (v: unknown) => void>();
  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { id?: number | string; result?: unknown; error?: unknown };
        if (obj.id !== undefined && pending.has(obj.id)) {
          pending.get(obj.id)!(obj);
          pending.delete(obj.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });

  let nextId = 1;
  function request(body: object): Promise<unknown> {
    const id = nextId++;
    const full = { jsonrpc: "2.0", id, ...body };
    return new Promise((resolveReq, rejectReq) => {
      pending.set(id, resolveReq);
      proc.stdin.write(JSON.stringify(full) + "\n", (e) => {
        if (e) rejectReq(e);
      });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectReq(new Error(`MCP request id=${id} timed out`));
        }
      }, 5000);
    });
  }

  function notify(body: object): void {
    const full = { jsonrpc: "2.0", ...body };
    proc.stdin.write(JSON.stringify(full) + "\n");
  }

  async function close(): Promise<void> {
    proc.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    if (!proc.killed) proc.kill();
  }

  return { proc, request, notify, close };
}

describe("MCP server — stdio JSON-RPC", () => {
  it("initialize returns server info + protocolVersion + capabilities", async () => {
    const mcp = spawnMcp();
    const res = (await mcp.request({
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} },
    })) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object } };
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("budgetkit-mcp");
    expect(res.result.capabilities).toHaveProperty("tools");
    await mcp.close();
  });

  it("tools/list returns the full registry with schemas", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const res = (await mcp.request({ method: "tools/list" })) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: object }> };
    };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("list_workspaces");
    expect(names).toContain("add_expense");
    expect(names).toContain("compute_take_home");
    expect(res.result.tools.length).toBeGreaterThanOrEqual(10);
    await mcp.close();
  });

  it("tools/call list_workspaces returns the seeded Current workspace", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const res = (await mcp.request({
      method: "tools/call",
      params: { name: "list_workspaces", arguments: {} },
    })) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(res.result.isError).toBe(false);
    const parsed = JSON.parse(res.result.content[0]!.text) as Array<{ name: string }>;
    expect(parsed[0]!.name).toBe("Current");
    await mcp.close();
  });

  it("tools/call add_expense (with confirm) writes to DB; subsequent list_expenses sees it", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const addRes = (await mcp.request({
      method: "tools/call",
      params: {
        name: "add_expense",
        // confirm:true is the transport-level consent flag (C1); it is
        // stripped before the tool's own schema validation runs.
        arguments: { workspaceId: 1, label: "MCP", amountDollars: 42.42, frequency: "monthly", confirm: true },
      },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(addRes.result.isError).toBe(false);

    const listRes = (await mcp.request({
      method: "tools/call",
      params: { name: "list_expenses", arguments: { workspaceId: 1 } },
    })) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(listRes.result.content[0]!.text) as Array<{ label: string }>;
    expect(parsed.some((e) => e.label === "MCP")).toBe(true);
    await mcp.close();
  });

  it("validation errors are surfaced with isError: true", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const res = (await mcp.request({
      method: "tools/call",
      // Missing fields; confirm present so we exercise validation, not the gate.
      params: { name: "add_expense", arguments: { workspaceId: 1, confirm: true } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/Validation error/);
    await mcp.close();
  });

  it("unknown method returns JSON-RPC error -32601", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const res = (await mcp.request({ method: "nope/nada" })) as {
      error: { code: number; message: string };
    };
    expect(res.error.code).toBe(-32601);
    await mcp.close();
  });

  it("source is recorded as mcp_client in the audit log (mutation path)", async () => {
    // Use add_expense — a mutation — so the registry actually writes an
    // audit row. list_workspaces was previously used here but is now
    // read-only and skips the audit log for privacy.
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    await mcp.request({
      method: "tools/call",
      params: {
        name: "add_expense",
        arguments: {
          workspaceId: 1,
          label: "MCPAuditTest",
          amountDollars: 12.34,
          frequency: "monthly",
          confirm: true,
        },
      },
    });
    await mcp.close();
    expect(mcp.proc.exitCode === null || mcp.proc.exitCode === 0).toBe(true);
  });

  // -------------------------------------------------------------------------
  // C1 — mutation gate over the MCP transport (audit finding MCP-1). Mutating
  // tools advertise a `confirm` boolean in tools/list; calls without
  // confirm:true are refused with a JSON-RPC error BEFORE any state changes.
  // -------------------------------------------------------------------------
  it("tools/list advertises `confirm` on mutating tools but not on read-only ones", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });
    const res = (await mcp.request({ method: "tools/list" })) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, unknown>; required?: string[] };
        }>;
      };
    };
    const byName = new Map(res.result.tools.map((t) => [t.name, t]));
    const addExpense = byName.get("add_expense")!;
    expect(addExpense.inputSchema.properties).toHaveProperty("confirm");
    expect(addExpense.inputSchema.required).toContain("confirm");
    const listWorkspaces = byName.get("list_workspaces")!;
    expect(listWorkspaces.inputSchema.properties).not.toHaveProperty("confirm");
    await mcp.close();
  });

  it("rejects a mutating call without confirm (JSON-RPC error), then succeeds with confirm:true", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });

    // 1. No confirm → JSON-RPC error naming the tool; nothing written.
    const refused = (await mcp.request({
      method: "tools/call",
      params: {
        name: "add_expense",
        arguments: { workspaceId: 1, label: "GateTest", amountDollars: 10, frequency: "monthly" },
      },
    })) as { error?: { code: number; message: string; data?: { tool?: string; code?: string } } };
    expect(refused.error).toBeDefined();
    expect(refused.error!.code).toBe(-32602);
    expect(refused.error!.message).toMatch(/confirm/);
    expect(refused.error!.message).toMatch(/add_expense/);
    expect(refused.error!.data?.code).toBe("needs_confirmation");

    // confirm:false is NOT consent either.
    const refusedFalse = (await mcp.request({
      method: "tools/call",
      params: {
        name: "add_expense",
        arguments: { workspaceId: 1, label: "GateTest", amountDollars: 10, frequency: "monthly", confirm: false },
      },
    })) as { error?: { code: number } };
    expect(refusedFalse.error).toBeDefined();

    // The refused mutation must not have landed.
    const listBefore = (await mcp.request({
      method: "tools/call",
      params: { name: "list_expenses", arguments: { workspaceId: 1 } },
    })) as { result: { content: Array<{ text: string }> } };
    const rowsBefore = JSON.parse(listBefore.result.content[0]!.text) as Array<{ label: string }>;
    expect(rowsBefore.some((e) => e.label === "GateTest")).toBe(false);

    // 2. With confirm:true → executes (and the stripped key never reaches the
    //    tool schema, which uses additionalProperties:false).
    const ok = (await mcp.request({
      method: "tools/call",
      params: {
        name: "add_expense",
        arguments: { workspaceId: 1, label: "GateTest", amountDollars: 10, frequency: "monthly", confirm: true },
      },
    })) as { result: { isError: boolean } };
    expect(ok.result.isError).toBe(false);

    const listAfter = (await mcp.request({
      method: "tools/call",
      params: { name: "list_expenses", arguments: { workspaceId: 1 } },
    })) as { result: { content: Array<{ text: string }> } };
    const rowsAfter = JSON.parse(listAfter.result.content[0]!.text) as Array<{ label: string }>;
    expect(rowsAfter.some((e) => e.label === "GateTest")).toBe(true);
    await mcp.close();
  }, 15_000);

  // -------------------------------------------------------------------------
  // The /custom page write auto-applies in the in-app chat ONLY. Over MCP it
  // is an ordinary mutation and stays consent-gated — that asymmetry is the
  // security property, so it gets its own test.
  // -------------------------------------------------------------------------
  it("set_custom_page still requires confirm over MCP; its readers do not", async () => {
    const mcp = spawnMcp();
    await mcp.request({ method: "initialize", params: {} });

    const listed = (await mcp.request({ method: "tools/list" })) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, unknown>; required?: string[] };
        }>;
      };
    };
    const byName = new Map(listed.result.tools.map((t) => [t.name, t]));
    const setPage = byName.get("set_custom_page")!;
    expect(setPage.inputSchema.properties).toHaveProperty("confirm");
    expect(setPage.inputSchema.required).toContain("confirm");
    for (const readOnly of ["get_custom_page", "query_transactions"]) {
      expect(byName.get(readOnly)!.inputSchema.properties).not.toHaveProperty("confirm");
    }

    const definition = {
      action: "set",
      title: "MCP page",
      queries: [{ id: "cats", tool: "list_categories", args: {} }],
      render: 'bk.note(root, "hi");',
    };

    const refused = (await mcp.request({
      method: "tools/call",
      params: { name: "set_custom_page", arguments: definition },
    })) as { error?: { code: number; data?: { code?: string } } };
    expect(refused.error).toBeDefined();
    expect(refused.error!.data?.code).toBe("needs_confirmation");

    const blank = (await mcp.request({
      method: "tools/call",
      params: { name: "get_custom_page", arguments: {} },
    })) as { result: { content: Array<{ text: string }> } };
    expect((JSON.parse(blank.result.content[0]!.text) as { exists: boolean }).exists).toBe(false);

    const ok = (await mcp.request({
      method: "tools/call",
      params: { name: "set_custom_page", arguments: { ...definition, confirm: true } },
    })) as { result: { isError: boolean } };
    expect(ok.result.isError).toBe(false);

    const after = (await mcp.request({
      method: "tools/call",
      params: { name: "get_custom_page", arguments: {} },
    })) as { result: { content: Array<{ text: string }> } };
    const page = JSON.parse(after.result.content[0]!.text) as {
      exists: boolean;
      definition: { title: string };
    };
    expect(page.exists).toBe(true);
    expect(page.definition.title).toBe("MCP page");
    await mcp.close();
  }, 15_000);
});
