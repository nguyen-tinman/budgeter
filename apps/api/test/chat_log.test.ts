// Transcript persistence — the chat survives a reload; only "New chat" ends it.
//
// The panel owns the rendered log and hands the whole thing back after each
// turn, so these tests drive the routes the way the panel does: PUT what is on
// screen, GET it back, POST /clear to discard.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sanitizeChatLog, MAX_PERSISTED_MESSAGES, MAX_PERSISTED_TEXT_CHARS } from "../src/routes/chat.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-chatlog-test-"));
  process.env.BUDGETKIT_DB = join(tmpRoot, "test.db");
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  const { closeDb, defaultDbConfig } = await import("@budgetkit/db");
  closeDb();
  const cfg = defaultDbConfig();
  rmSync(cfg.path, { force: true });
  for (const side of ["-wal", "-shm"]) rmSync(`${cfg.path}${side}`, { force: true });
});

async function freshApp(): Promise<Hono> {
  const { openDb, migrate } = await import("@budgetkit/db");
  const { chatRouter } = await import("../src/routes/chat.js");
  migrate(openDb());
  const app = new Hono();
  app.route("/api/chat", chatRouter({
    client: {
      baseUrl: "stub://",
      chat: async () => {
        throw new Error("not used");
      },
      health: async () => ({ ok: true, status: 200 }),
    },
  }));
  return app;
}

const put = (app: Hono, body: unknown) =>
  app.request("/api/chat/log", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const get = async (app: Hono) =>
  (await (await app.request("/api/chat/log")).json()) as {
    ok: boolean;
    messages: Array<Record<string, unknown>>;
    priorSummary: string | null;
  };

describe("chat transcript — round trip", () => {
  it("returns an empty transcript before anything is stored", async () => {
    const app = await freshApp();
    const r = await get(app);
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([]);
    expect(r.priorSummary).toBeNull();
  });

  it("restores exactly what was on screen, chips and all", async () => {
    const app = await freshApp();
    const onScreen = [
      { role: "user", text: "build me a retirement chart" },
      { role: "assistant", text: "", tools: [{ name: "compute_retirement" }], step: true },
      { role: "assistant", text: "", tools: [{ name: "set_custom_page", count: 4 }] },
      { role: "assistant", text: "Done — the chart is on the Custom page." },
    ];
    const stored = await (await put(app, { messages: onScreen, priorSummary: null })).json();
    expect(stored).toMatchObject({ ok: true, stored: 4 });

    const back = await get(app);
    expect(back.messages).toEqual(onScreen);
  });

  it("keeps the folded-context summary with the transcript it belongs to", async () => {
    const app = await freshApp();
    await put(app, {
      messages: [{ role: "user", text: "hi" }],
      priorSummary: "Earlier turns covered rent and groceries.",
    });
    expect((await get(app)).priorSummary).toBe("Earlier turns covered rent and groceries.");
  });

  it("survives a second process opening the same database", async () => {
    const app = await freshApp();
    await put(app, { messages: [{ role: "user", text: "remember me" }], priorSummary: null });
    // Close and reopen — the reload case.
    const { closeDb } = await import("@budgetkit/db");
    closeDb();
    const app2 = await freshApp();
    const back = await get(app2);
    expect(back.messages).toEqual([{ role: "user", text: "remember me" }]);
  });

  it("replaces rather than appends, so folded chips do not duplicate", async () => {
    const app = await freshApp();
    await put(app, {
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "", tools: [{ name: "set_custom_page" }] },
      ],
      priorSummary: null,
    });
    // Same turn, one more identical call folded into a counted chip.
    await put(app, {
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "", tools: [{ name: "set_custom_page", count: 2 }] },
      ],
      priorSummary: null,
    });
    const back = await get(app);
    expect(back.messages).toHaveLength(2);
    expect(back.messages[1]!.tools).toEqual([{ name: "set_custom_page", count: 2 }]);
  });
});

describe("chat transcript — clearing", () => {
  it("is discarded by New chat, and by nothing else", async () => {
    const app = await freshApp();
    await put(app, {
      messages: [{ role: "user", text: "hi" }],
      priorSummary: "a summary",
    });
    expect((await get(app)).messages).toHaveLength(1);

    await app.request("/api/chat/clear", { method: "POST" });

    const back = await get(app);
    expect(back.messages).toEqual([]);
    expect(back.priorSummary).toBeFalsy();
  });
});

describe("sanitizeChatLog", () => {
  it("drops unknown roles rather than failing the whole write", () => {
    // The role column is CHECK-constrained; one bad row must not cost the user
    // their transcript.
    const out = sanitizeChatLog([
      { role: "user", text: "keep" },
      { role: "tool", text: "drop" },
      { role: "assistant", text: "keep too" },
    ]);
    expect(out.map((m) => m.text)).toEqual(["keep", "keep too"]);
  });

  it("never stores pendingActions", () => {
    // A restored Approve button would invite the user to authorize a mutation
    // proposed against a workspace state that has since moved on.
    const out = sanitizeChatLog([
      {
        role: "assistant",
        text: "I'd like to make the following change(s):",
        pendingActions: [{ id: "p1", toolName: "delete_expense", args: { id: 3 } }],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("pendingActions");
  });

  it("drops bubbles that would render as an empty box", () => {
    expect(sanitizeChatLog([{ role: "assistant", text: "" }])).toEqual([]);
    // ...but a chip-only bubble is real content.
    expect(sanitizeChatLog([{ role: "assistant", text: "", tools: [{ name: "x" }] }])).toHaveLength(1);
  });

  it("keeps the newest messages when over the cap", () => {
    const many = Array.from({ length: MAX_PERSISTED_MESSAGES + 50 }, (_, i) => ({
      role: "user" as const,
      text: `m${i}`,
    }));
    const out = sanitizeChatLog(many);
    expect(out).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(out[out.length - 1]!.text).toBe(`m${many.length - 1}`);
  });

  it("clamps oversized text and malformed chips", () => {
    const out = sanitizeChatLog([
      {
        role: "assistant",
        text: "x".repeat(MAX_PERSISTED_TEXT_CHARS + 1000),
        tools: [{ name: "ok" }, { count: 3 }, null, { name: "" }],
      },
    ]);
    expect(out[0]!.text).toHaveLength(MAX_PERSISTED_TEXT_CHARS);
    expect(out[0]!.tools).toEqual([{ name: "ok" }]);
  });

  it("rejects a body that is not an array of messages", async () => {
    const app = await freshApp();
    const res = await put(app, { messages: "nope" });
    expect(res.status).toBe(400);
  });
});
