import * as path from "path";
import * as vscode from "vscode";
import {
  AgentStateUnavailableError,
  diffSnapshots,
  readAgentSnapshot,
  type AgentProject,
  type AgentSnapshot,
  type AgentState,
  type AgentThread,
  type AgentTransition,
} from "./t3State";

const POLL_MS = 2_000;
const TREE_TICK_MS = 60_000;
const MAX_IDLE_THREADS_SHOWN = 15;
const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

export interface AgentActions {
  dbPath(): string;
  openThread(folderPath: string): Promise<void>;
  showApp(): Promise<void>;
}

type SnapshotChange = { snapshot: AgentSnapshot | undefined; previous: AgentSnapshot | undefined };

/** Polls T3 Code's state and publishes snapshots when they change. */
class AgentMonitor implements vscode.Disposable {
  private snapshot: AgentSnapshot | undefined;
  private serialized = "";
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<SnapshotChange>();
  readonly onDidChange = this.emitter.event;
  unavailableReason: string | undefined;

  constructor(private readonly dbPath: () => string) {}

  get current() {
    return this.snapshot;
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  refresh() {
    let next: AgentSnapshot | undefined;
    let reason: string | undefined;
    try {
      next = readAgentSnapshot(this.dbPath());
    } catch (error) {
      reason = error instanceof AgentStateUnavailableError ? error.message : String(error);
    }
    const serialized = next ? JSON.stringify(next) : `unavailable:${reason}`;
    if (serialized === this.serialized) return;
    this.serialized = serialized;

    const previous = this.snapshot;
    this.snapshot = next;
    this.unavailableReason = reason;
    void vscode.commands.executeCommand("setContext", "t3code.agentsAvailable", next !== undefined);
    void vscode.commands.executeCommand("setContext", "t3code.agentsEmpty", next?.projects.length === 0);
    this.emitter.fire({ snapshot: next, previous });
  }

  dispose() {
    clearInterval(this.timer);
    this.emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sidebar tree

type AgentNode =
  | { kind: "project"; project: AgentProject }
  | { kind: "thread"; project: AgentProject; thread: AgentThread }
  | { kind: "more"; project: AgentProject; count: number };

const STATE_ICONS: Record<AgentState, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue")),
  waiting: new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow")),
  error: new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red")),
  idle: new vscode.ThemeIcon("check"),
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function summarize(counts: Record<AgentState, number>): string {
  const parts: string[] = [];
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.waiting) parts.push(`${counts.waiting} ${counts.waiting === 1 ? "needs" : "need"} you`);
  if (counts.error) parts.push(`${counts.error} failed`);
  return parts.join(" · ");
}

function threadDescription(thread: AgentThread): string {
  switch (thread.state) {
    case "working":
      return "working";
    case "waiting":
      return "needs you";
    case "error":
      return "error";
    case "idle":
      return `done · ${timeAgo(thread.updatedAt)}`;
  }
}

class AgentTreeProvider implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly tick = setInterval(() => this.emitter.fire(), TREE_TICK_MS);

  constructor(private readonly monitor: AgentMonitor) {
    monitor.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: AgentNode): AgentNode[] {
    const snapshot = this.monitor.current;
    if (!snapshot) return [];
    if (!node) return snapshot.projects.map((project) => ({ kind: "project", project }));
    if (node.kind !== "project") return [];

    const { project } = node;
    const active = project.threads.filter((thread) => thread.state !== "idle");
    const idle = project.threads.filter((thread) => thread.state === "idle");
    const children: AgentNode[] = [...active, ...idle.slice(0, MAX_IDLE_THREADS_SHOWN)].map((thread) => ({
      kind: "thread",
      project,
      thread,
    }));
    if (idle.length > MAX_IDLE_THREADS_SHOWN) {
      children.push({ kind: "more", project, count: idle.length - MAX_IDLE_THREADS_SHOWN });
    }
    return children;
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === "project") {
      const { project } = node;
      const summary = summarize(project.counts);
      const active = summary.length > 0;
      const item = new vscode.TreeItem(
        project.title,
        active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `project:${project.projectId}`;
      item.description = summary || `${project.threads.length} thread${project.threads.length === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon(active ? "folder-active" : "folder");
      item.tooltip = new vscode.MarkdownString(`**${project.title}**\n\n\`${project.workspaceRoot}\``);
      item.contextValue = "t3Project";
      return item;
    }

    if (node.kind === "more") {
      const item = new vscode.TreeItem(`${node.count} older thread${node.count === 1 ? "" : "s"} in T3 Code`);
      item.id = `more:${node.project.projectId}`;
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      item.command = { command: "t3code.showApp", title: "Show in T3 Code" };
      return item;
    }

    const { thread, project } = node;
    const item = new vscode.TreeItem(thread.title);
    item.id = `thread:${thread.threadId}`;
    item.description = threadDescription(thread);
    item.iconPath = STATE_ICONS[thread.state];
    const tooltip = new vscode.MarkdownString(`**${thread.title}**\n\n${project.title} · ${item.description}`);
    if (thread.provider) tooltip.appendMarkdown(` · ${thread.provider}`);
    if (thread.state === "error" && thread.lastError) tooltip.appendMarkdown(`\n\n${thread.lastError}`);
    tooltip.appendMarkdown("\n\n_Click to show T3 Code._");
    item.tooltip = tooltip;
    item.contextValue = "t3Thread";
    item.command = { command: "t3code.showApp", title: "Show in T3 Code" };
    return item;
  }

  dispose() {
    clearInterval(this.tick);
    this.emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Explorer badges

function pathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

class AgentDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private byRoot = new Map<string, AgentProject>();

  constructor(monitor: AgentMonitor) {
    monitor.onDidChange(({ snapshot }) => {
      const previousRoots = [...this.byRoot.values()].map((project) => project.workspaceRoot);
      this.byRoot = new Map(snapshot?.projects.map((project) => [pathKey(project.workspaceRoot), project]));
      // Name the roots explicitly: VS Code only queries URIs it has rendered, so a
      // repo inside a collapsed folder would otherwise never be asked about and
      // its decoration could not propagate up to the visible parent.
      const roots = new Set([...previousRoots, ...(snapshot?.projects.map((project) => project.workspaceRoot) ?? [])]);
      this.emitter.fire([...roots].map((root) => vscode.Uri.file(root)));
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const project = this.byRoot.get(pathKey(uri.fsPath));
    const summary = project ? summarize(project.counts) : "";
    if (!project || !summary) return undefined;

    const { working, waiting } = project.counts;
    const badge = waiting > 0 ? "!" : working > 0 ? (working > 9 ? "9+" : String(working)) : "×";
    const color = waiting > 0 ? "charts.yellow" : working > 0 ? "charts.blue" : "charts.red";
    const decoration = new vscode.FileDecoration(badge, `T3 Code: ${summary}`, new vscode.ThemeColor(color));
    // Tint collapsed parent folders too, so activity in nested repos is visible from the top.
    decoration.propagate = true;
    return decoration;
  }

  dispose() {
    this.emitter.dispose();
  }
}

// ---------------------------------------------------------------------------
// Status bar

function createStatusBar(monitor: AgentMonitor): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem("t3code.agents", vscode.StatusBarAlignment.Left, 50);
  item.name = "T3 Code Agents";
  item.command = "t3code.agents.focus";
  monitor.onDidChange(({ snapshot }) => {
    const totals = snapshot?.totals;
    if (!totals || totals.working + totals.waiting + totals.error === 0) {
      item.hide();
      return;
    }
    const parts: string[] = [];
    if (totals.working) parts.push(`$(sync~spin) ${totals.working} working`);
    if (totals.waiting) parts.push(`$(bell-dot) ${totals.waiting} ${totals.waiting === 1 ? "needs" : "need"} you`);
    if (totals.error) parts.push(`$(error) ${totals.error} failed`);
    item.text = parts.join("  ");
    item.tooltip = "T3 Code agents. Click to show the Agents panel.";
    item.backgroundColor = totals.waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    item.show();
  });
  return item;
}

// ---------------------------------------------------------------------------
// Notifications

async function notify(transitions: AgentTransition[], actions: AgentActions) {
  const mode = vscode.workspace.getConfiguration("t3code").get<string>("agents.notifications", "all");
  if (mode === "off") return;
  // Every VS Code window runs this extension; only the focused one speaks up.
  if (!vscode.window.state.focused) return;

  const relevant = mode === "needsYou" ? transitions.filter((t) => t.kind !== "finished") : transitions;
  if (relevant.length === 0) return;

  const show = "Show in T3 Code";
  let choice: string | undefined;
  if (relevant.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
    choice = await vscode.window.showInformationMessage(`${relevant.length} T3 Code agents changed state.`, show);
  } else {
    const shown = relevant.map(({ kind, thread, project }) => {
      const where = `${project.title}: ${thread.title}`;
      if (kind === "finished") return vscode.window.showInformationMessage(`Agent finished — ${where}`, show);
      if (kind === "needsYou") return vscode.window.showWarningMessage(`Agent needs you — ${where}`, show);
      return vscode.window.showErrorMessage(`Agent hit an error — ${where}`, show);
    });
    choice = (await Promise.all(shown)).find(Boolean);
  }
  if (choice) await actions.showApp();
}

// ---------------------------------------------------------------------------

export function registerAgentViews(context: vscode.ExtensionContext, actions: AgentActions) {
  const enabled = vscode.workspace.getConfiguration("t3code").get<boolean>("agents.enabled", true);
  void vscode.commands.executeCommand("setContext", "t3code.agentsEnabled", enabled);
  if (!enabled) return;

  const monitor = new AgentMonitor(actions.dbPath);
  const tree = new AgentTreeProvider(monitor);
  const decorations = new AgentDecorationProvider(monitor);
  const statusBar = createStatusBar(monitor);

  monitor.onDidChange(({ snapshot, previous }) => {
    if (snapshot && previous) void notify(diffSnapshots(previous, snapshot), actions);
  });

  context.subscriptions.push(
    monitor,
    tree,
    decorations,
    statusBar,
    vscode.window.registerTreeDataProvider("t3code.agents", tree),
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand("t3code.refreshAgents", () => monitor.refresh()),
    vscode.commands.registerCommand("t3code.openThreadInProject", (node?: AgentNode) => {
      if (node?.kind === "project") return actions.openThread(node.project.workspaceRoot);
    }),
    vscode.commands.registerCommand("t3code.openProjectFolder", (node?: AgentNode) => {
      if (node?.kind !== "project") return;
      return vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(node.project.workspaceRoot), {
        forceNewWindow: true,
      });
    }),
  );
  monitor.start();
}
