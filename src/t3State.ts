/**
 * Reads live agent status from T3 Code's local state database.
 *
 * T3 Code keeps projections of its projects, threads, and provider sessions in
 * `<T3 home>/userdata/state.sqlite`. We open it read-only, per read, so we never
 * hold locks T3 Code needs. The schema is internal to T3 Code: if a query stops
 * matching it, reads throw {@link AgentStateUnavailableError} and callers hide
 * agent features instead of failing.
 */
import * as fs from "fs";
import * as path from "path";

export type AgentState = "working" | "waiting" | "error" | "idle";

export interface AgentThread {
  threadId: string;
  title: string;
  state: AgentState;
  sessionStatus: string | null;
  provider: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface AgentProject {
  projectId: string;
  title: string;
  workspaceRoot: string;
  /** Sorted: working, waiting, error, then idle; most recently updated first within each. */
  threads: AgentThread[];
  counts: Record<AgentState, number>;
  lastActivity: string;
}

export interface AgentSnapshot {
  /** Projects with at least one thread; active projects first, then most recent activity. */
  projects: AgentProject[];
  totals: Record<AgentState, number>;
}

export type AgentTransition = {
  kind: "finished" | "needsYou" | "failed";
  thread: AgentThread;
  project: AgentProject;
};

export class AgentStateUnavailableError extends Error {}

type SqliteRow = Record<string, unknown>;
type SqliteDatabase = {
  prepare(sql: string): { all(...params: unknown[]): SqliteRow[] };
  close(): void;
};
type SqliteModule = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

let sqlite: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqlite === undefined) {
    try {
      sqlite = require("node:sqlite") as SqliteModule;
    } catch {
      sqlite = null;
    }
  }
  return sqlite;
}

export function stateDbPath(baseDir: string): string {
  return path.join(baseDir, "userdata", "state.sqlite");
}

const STATE_ORDER: Record<AgentState, number> = { working: 0, waiting: 1, error: 2, idle: 3 };
const WORKING_SESSION_STATUSES = new Set(["starting", "running"]);

const THREADS_QUERY = `
  select p.project_id, p.title as project_title, p.workspace_root,
         t.thread_id, t.title, t.updated_at, t.pending_approval_count, t.pending_user_input_count,
         s.status as session_status, s.provider_name, s.last_error, s.updated_at as session_updated_at
  from projection_projects p
  join projection_threads t
    on t.project_id = p.project_id and t.deleted_at is null and t.archived_at is null
  left join projection_thread_sessions s on s.thread_id = t.thread_id
  where p.deleted_at is null`;

function emptyCounts(): Record<AgentState, number> {
  return { working: 0, waiting: 0, error: 0, idle: 0 };
}

function toState(row: SqliteRow): AgentState {
  if (Number(row.pending_approval_count) > 0 || Number(row.pending_user_input_count) > 0) return "waiting";
  const status = row.session_status as string | null;
  if (status && WORKING_SESSION_STATUSES.has(status)) return "working";
  if (status === "error") return "error";
  return "idle";
}

function latest(a: string, b: unknown): string {
  return typeof b === "string" && b > a ? b : a;
}

export function readAgentSnapshot(dbPath: string): AgentSnapshot {
  const module = loadSqlite();
  if (!module) throw new AgentStateUnavailableError("This editor's runtime doesn't include SQLite support.");
  if (!fs.existsSync(dbPath)) throw new AgentStateUnavailableError(`T3 Code's state database wasn't found at ${dbPath}.`);

  let rows: SqliteRow[];
  let db: SqliteDatabase | undefined;
  try {
    db = new module.DatabaseSync(dbPath, { readOnly: true });
    rows = db.prepare(THREADS_QUERY).all();
  } catch (error) {
    throw new AgentStateUnavailableError(
      `Couldn't read T3 Code's state (${error instanceof Error ? error.message : String(error)}).`,
    );
  } finally {
    db?.close();
  }

  const projects = new Map<string, AgentProject>();
  for (const row of rows) {
    const projectId = String(row.project_id);
    let project = projects.get(projectId);
    if (!project) {
      project = {
        projectId,
        title: String(row.project_title),
        workspaceRoot: String(row.workspace_root),
        threads: [],
        counts: emptyCounts(),
        lastActivity: "",
      };
      projects.set(projectId, project);
    }
    const thread: AgentThread = {
      threadId: String(row.thread_id),
      title: String(row.title),
      state: toState(row),
      sessionStatus: (row.session_status as string | null) ?? null,
      provider: (row.provider_name as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      updatedAt: latest(String(row.updated_at), row.session_updated_at),
    };
    project.threads.push(thread);
    project.counts[thread.state]++;
    project.lastActivity = latest(project.lastActivity, thread.updatedAt);
  }

  const totals = emptyCounts();
  for (const project of projects.values()) {
    project.threads.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt));
    for (const state of Object.keys(totals) as AgentState[]) totals[state] += project.counts[state];
  }

  const isActive = (project: AgentProject) => project.counts.working + project.counts.waiting + project.counts.error > 0;
  const sorted = [...projects.values()].sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || b.lastActivity.localeCompare(a.lastActivity),
  );
  return { projects: sorted, totals };
}

/** State changes worth telling the user about between two snapshots. */
export function diffSnapshots(previous: AgentSnapshot, next: AgentSnapshot): AgentTransition[] {
  const before = new Map<string, AgentState>();
  for (const project of previous.projects) for (const thread of project.threads) before.set(thread.threadId, thread.state);

  const transitions: AgentTransition[] = [];
  for (const project of next.projects) {
    for (const thread of project.threads) {
      const was = before.get(thread.threadId);
      if (was === thread.state) continue;
      if (thread.state === "idle" && was === "working") transitions.push({ kind: "finished", thread, project });
      else if (thread.state === "waiting") transitions.push({ kind: "needsYou", thread, project });
      else if (thread.state === "error") transitions.push({ kind: "failed", thread, project });
    }
  }
  return transitions;
}
