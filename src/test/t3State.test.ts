import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AgentStateUnavailableError, diffSnapshots, readAgentSnapshot, type AgentSnapshot } from "../t3State";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => { exec(sql: string): void; close(): void };
};

type ThreadRow = {
  id: string;
  project: string;
  title?: string;
  updated?: string;
  approvals?: number;
  inputs?: number;
  archived?: boolean;
  deleted?: boolean;
  session?: string | null;
  lastError?: string;
};

/** Builds a database with the subset of T3 Code's projection schema we read. */
function makeDb(projects: { id: string; title: string; root: string; deleted?: boolean }[], threads: ThreadRow[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-state-"));
  const file = path.join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    create table projection_projects (project_id text, title text, workspace_root text, deleted_at text);
    create table projection_threads (thread_id text, project_id text, title text, updated_at text, deleted_at text,
      archived_at text, pending_approval_count integer, pending_user_input_count integer);
    create table projection_thread_sessions (thread_id text, status text, provider_name text, last_error text, updated_at text);
  `);
  const q = (value: string | null | undefined) => (value == null ? "null" : `'${value.replace(/'/g, "''")}'`);
  for (const p of projects) {
    db.exec(`insert into projection_projects values (${q(p.id)}, ${q(p.title)}, ${q(p.root)}, ${q(p.deleted ? "2026-01-01" : null)})`);
  }
  for (const t of threads) {
    db.exec(`insert into projection_threads values (${q(t.id)}, ${q(t.project)}, ${q(t.title ?? t.id)},
      ${q(t.updated ?? "2026-09-01T00:00:00.000Z")}, ${q(t.deleted ? "2026-01-01" : null)}, ${q(t.archived ? "2026-01-01" : null)},
      ${t.approvals ?? 0}, ${t.inputs ?? 0})`);
    if (t.session !== undefined && t.session !== null) {
      db.exec(`insert into projection_thread_sessions values (${q(t.id)}, ${q(t.session)}, 'claudeAgent', ${q(t.lastError)},
        ${q(t.updated ?? "2026-09-01T00:00:00.000Z")})`);
    }
  }
  db.close();
  return file;
}

describe("readAgentSnapshot", () => {
  it("derives each thread's state from its session and pending requests", () => {
    const db = makeDb(
      [{ id: "p1", title: "App", root: "/work/app" }],
      [
        { id: "running", project: "p1", session: "running" },
        { id: "starting", project: "p1", session: "starting" },
        { id: "approval", project: "p1", session: "running", approvals: 1 },
        { id: "question", project: "p1", session: "ready", inputs: 2 },
        { id: "broken", project: "p1", session: "error", lastError: "boom" },
        { id: "ready", project: "p1", session: "ready" },
        { id: "stopped", project: "p1", session: "stopped" },
        { id: "never-started", project: "p1", session: null },
      ],
    );

    const states = Object.fromEntries(readAgentSnapshot(db).projects[0].threads.map((t) => [t.threadId, t.state]));

    assert.deepEqual(states, {
      running: "working",
      starting: "working",
      approval: "waiting",
      question: "waiting",
      broken: "error",
      ready: "idle",
      stopped: "idle",
      "never-started": "idle",
    });
  });

  it("counts per project and in total, skipping deleted and archived rows", () => {
    const db = makeDb(
      [
        { id: "p1", title: "App", root: "/work/app" },
        { id: "p2", title: "Api", root: "/work/api" },
        { id: "gone", title: "Gone", root: "/work/gone", deleted: true },
      ],
      [
        { id: "a", project: "p1", session: "running" },
        { id: "b", project: "p1", session: "running", approvals: 1 },
        { id: "c", project: "p1", session: "running", archived: true },
        { id: "d", project: "p2", session: "error" },
        { id: "e", project: "p2", session: "ready", deleted: true },
        { id: "f", project: "gone", session: "running" },
      ],
    );

    const snapshot = readAgentSnapshot(db);

    assert.deepEqual(
      snapshot.projects.map((p) => [p.title, p.counts]).sort(),
      [
        ["Api", { working: 0, waiting: 0, error: 1, idle: 0 }],
        ["App", { working: 1, waiting: 1, error: 0, idle: 0 }],
      ],
    );
    assert.deepEqual(snapshot.totals, { working: 1, waiting: 1, error: 1, idle: 0 });
  });

  it("orders active projects first, then by most recent activity", () => {
    const db = makeDb(
      [
        { id: "old-busy", title: "Old but busy", root: "/a" },
        { id: "new-idle", title: "New and idle", root: "/b" },
        { id: "older-idle", title: "Older and idle", root: "/c" },
      ],
      [
        { id: "1", project: "old-busy", session: "running", updated: "2026-01-01T00:00:00.000Z" },
        { id: "2", project: "new-idle", session: "ready", updated: "2026-09-20T00:00:00.000Z" },
        { id: "3", project: "older-idle", session: "ready", updated: "2026-05-01T00:00:00.000Z" },
      ],
    );

    assert.deepEqual(
      readAgentSnapshot(db).projects.map((p) => p.title),
      ["Old but busy", "New and idle", "Older and idle"],
    );
  });

  it("orders threads working, waiting, error, idle, newest first", () => {
    const db = makeDb(
      [{ id: "p", title: "P", root: "/p" }],
      [
        { id: "idle-new", project: "p", session: "ready", updated: "2026-09-02T00:00:00.000Z" },
        { id: "idle-old", project: "p", session: "ready", updated: "2026-09-01T00:00:00.000Z" },
        { id: "err", project: "p", session: "error" },
        { id: "wait", project: "p", session: "running", inputs: 1 },
        { id: "work", project: "p", session: "running" },
      ],
    );

    assert.deepEqual(
      readAgentSnapshot(db).projects[0].threads.map((t) => t.threadId),
      ["work", "wait", "err", "idle-new", "idle-old"],
    );
  });

  it("reports a missing database or unexpected schema as unavailable", () => {
    assert.throws(() => readAgentSnapshot(path.join(os.tmpdir(), "no-such-t3", "state.sqlite")), AgentStateUnavailableError);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-state-"));
    const file = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(file);
    db.exec("create table something_else (x integer)");
    db.close();
    assert.throws(() => readAgentSnapshot(file), AgentStateUnavailableError);
  });
});

describe("diffSnapshots", () => {
  function snapshot(threads: Record<string, "working" | "waiting" | "error" | "idle">): AgentSnapshot {
    const list = Object.entries(threads).map(([threadId, state]) => ({
      threadId,
      title: threadId,
      state,
      sessionStatus: null,
      provider: null,
      lastError: null,
      updatedAt: "",
    }));
    const project = {
      projectId: "p",
      title: "P",
      workspaceRoot: "/p",
      threads: list,
      counts: { working: 0, waiting: 0, error: 0, idle: 0 },
      lastActivity: "",
    };
    return { projects: [project], totals: project.counts };
  }

  it("reports finished, needs-you, and failed transitions only", () => {
    const transitions = diffSnapshots(
      snapshot({ done: "working", asks: "working", breaks: "working", same: "working", wasIdle: "idle" }),
      snapshot({ done: "idle", asks: "waiting", breaks: "error", same: "working", wasIdle: "idle", fresh: "waiting" }),
    );

    assert.deepEqual(
      transitions.map((t) => [t.thread.threadId, t.kind]),
      [
        ["done", "finished"],
        ["asks", "needsYou"],
        ["breaks", "failed"],
        ["fresh", "needsYou"],
      ],
    );
  });

  it("does not call an idle thread that was never working finished", () => {
    assert.deepEqual(diffSnapshots(snapshot({ a: "waiting" }), snapshot({ a: "idle" })), []);
  });
});
