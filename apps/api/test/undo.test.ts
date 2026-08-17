// Undo of assistant-driven changes, one step per USER turn.
//
// These exercise the property that matters: after undo, the data is exactly
// what it was before the turn ran — not "the last tool call was reversed".

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { Hono } from "hono";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "budgetkit-undo-test-"));
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
  // The undo stack lives beside the db; clear it so counts start from zero.
  rmSync(resolve(dirname(cfg.path), "undo"), { recursive: true, force: true });
});

async function freshDb() {
  const { openDb, migrate } = await import("@budgetkit/db");
  const db = openDb();
  migrate(db);
  return db;
}

async function freshApp(): Promise<Hono> {
  await freshDb();
  const { undoRouter } = await import("../src/routes/undo.js");
  const app = new Hono();
  app.route("/api/undo", undoRouter());
  return app;
}

function workspaceNames(db: { prepare: (s: string) => { all: () => Array<{ name: string }> } }): string[] {
  return db.prepare("SELECT name FROM workspaces ORDER BY id").all().map((r) => r.name);
}

describe("undo — snapshots keyed to user turns", () => {
  it("restores every change a turn made, not just the last one", async () => {
    const db = await freshDb();
    const { snapshotForUndo, undoLastUserTurn } = await import("@budgetkit/db");
    const before = workspaceNames(db);

    snapshotForUndo("set up my accounts");
    // One user turn, several writes — the case a per-tool undo would get wrong.
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('A', 'scenario')");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('B', 'scenario')");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('C', 'scenario')");
    expect(workspaceNames(db).length).toBe(before.length + 3);

    const result = undoLastUserTurn();
    expect(result.restored).toBe(true);
    expect(workspaceNames(db)).toEqual(before);
  });

  it("walks back one user turn per press", async () => {
    const db = await freshDb();
    const { snapshotForUndo, undoLastUserTurn } = await import("@budgetkit/db");

    snapshotForUndo("turn one");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('one', 'scenario')");
    snapshotForUndo("turn two");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('two', 'scenario')");

    expect(workspaceNames(db)).toContain("two");
    undoLastUserTurn();
    expect(workspaceNames(db)).toContain("one");
    expect(workspaceNames(db)).not.toContain("two");
    undoLastUserTurn();
    expect(workspaceNames(db)).not.toContain("one");
  });

  it("keeps at most ten steps, dropping the oldest", async () => {
    const db = await freshDb();
    const { snapshotForUndo, listUndoSnapshots, UNDO_DEPTH } = await import("@budgetkit/db");

    for (let i = 0; i < UNDO_DEPTH + 4; i++) {
      snapshotForUndo(`turn ${i}`);
      db.exec(`INSERT INTO workspaces (name, kind) VALUES ('w${i}', 'scenario')`);
    }
    const stack = listUndoSnapshots();
    expect(stack.length).toBe(UNDO_DEPTH);
    // Newest first, and the earliest turns are gone.
    expect(stack[0]!.label).toBe(`turn ${UNDO_DEPTH + 3}`);
    expect(stack.map((s) => s.label)).not.toContain("turn 0");
  });

  it("does not spend a slot when the turn changed nothing", async () => {
    await freshDb();
    const { snapshotForUndo, listUndoSnapshots } = await import("@budgetkit/db");

    expect(snapshotForUndo("first")).not.toBeNull();
    // A chat-only turn writes nothing; a second identical copy would otherwise
    // shorten how far back the user can reach.
    expect(snapshotForUndo("second, changed nothing")).toBeNull();
    expect(listUndoSnapshots().length).toBe(1);
  });

  it("deletes the snapshot file once it has been applied", async () => {
    const db = await freshDb();
    const { snapshotForUndo, undoLastUserTurn, listUndoSnapshots } = await import("@budgetkit/db");
    const { defaultDbConfig } = await import("@budgetkit/db");

    const snap = snapshotForUndo("turn");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('x', 'scenario')");
    const file = join(resolve(dirname(defaultDbConfig().path), "undo"), `${snap!.id}.db`);
    expect(existsSync(file)).toBe(true);

    undoLastUserTurn();
    expect(existsSync(file)).toBe(false);
    expect(listUndoSnapshots().length).toBe(0);
  });

  it("reports nothing to undo on an empty stack", async () => {
    await freshDb();
    const { undoLastUserTurn } = await import("@budgetkit/db");
    const r = undoLastUserTurn();
    expect(r.restored).toBe(false);
    expect(r.remaining).toBe(0);
  });
});

describe("undo — REST surface", () => {
  it("lists an empty stack, then reflects a snapshot", async () => {
    const app = await freshApp();
    const { snapshotForUndo } = await import("@budgetkit/db");

    let res = await app.request("/api/undo");
    let body = await res.json();
    expect(body.available).toBe(0);
    expect(body.depth).toBe(10);

    snapshotForUndo("add my 401k");
    res = await app.request("/api/undo");
    body = await res.json();
    expect(body.available).toBe(1);
    expect(body.snapshots[0].label).toBe("add my 401k");
  });

  it("409s when there is nothing to undo", async () => {
    const app = await freshApp();
    const res = await app.request("/api/undo", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_undo");
  });

  it("applies an undo and tells the client to refetch everything", async () => {
    const app = await freshApp();
    const { snapshotForUndo, openDb } = await import("@budgetkit/db");
    const db = openDb();

    snapshotForUndo("make a scenario");
    db.exec("INSERT INTO workspaces (name, kind) VALUES ('gone-after-undo', 'scenario')");

    const res = await app.request("/api/undo", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.snapshot.label).toBe("make a scenario");
    expect(body.affectedResources).toContain("customPage");
    expect(workspaceNames(db)).not.toContain("gone-after-undo");
  });
});
