/**
 * Talks to the running T3 Code desktop app over its local app-control socket.
 *
 * This is the same channel the `t3 app` CLI uses: one newline-delimited JSON
 * `open-workspace` request per connection, answered with one JSON response.
 * The desktop app finds (or creates) the project for the folder, opens a new
 * thread in it, and focuses its window.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export type OpenWorkspaceSuccess = {
  version: 1;
  requestId: string;
  ok: true;
  projectId: string;
  threadId: string;
};

export type OpenWorkspaceFailure = {
  version: 1;
  requestId: string;
  ok: false;
  code: string;
  message: string;
};

export type OpenWorkspaceResponse = OpenWorkspaceSuccess | OpenWorkspaceFailure;

const RESPONSE_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 65_536;
const LAUNCH_WAIT_MS = 60_000;
const LAUNCH_POLL_MS = 500;

export class T3AppUnreachableError extends Error {
  constructor(readonly address: string, cause: unknown) {
    super(`Could not reach the T3 Code desktop app at ${address}.`, { cause });
  }
}

export function resolveBaseDir(configured?: string): string {
  const raw = configured?.trim() || process.env.T3CODE_HOME?.trim();
  if (!raw) return path.join(os.homedir(), ".t3");
  const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Mirrors `resolveDesktopAppControlAddress` in T3 Code. */
export function resolveControlAddress(baseDir: string): string {
  const stateDir = path.resolve(path.join(baseDir, "userdata"));
  const stateHash = shortHash(stateDir);
  if (process.platform === "win32") return `\\\\.\\pipe\\t3code-app-${stateHash}`;
  const uid = process.getuid?.();
  const userKey = uid === undefined ? stateHash.slice(0, 12) : String(uid);
  return path.join(os.tmpdir(), `t3code-${userKey}`, `${stateHash}.sock`);
}

function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function sendOpenWorkspace(address: string, workspaceRoot: string): Promise<OpenWorkspaceResponse> {
  const request = {
    version: 1,
    requestId: crypto.randomUUID(),
    type: "open-workspace",
    workspaceRoot,
    platform: process.platform,
  };

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (error: unknown, response?: OpenWorkspaceResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (response) resolve(response);
      else reject(error);
    };

    const timeout = setTimeout(
      () => finish(new Error("T3 Code did not respond in time.")),
      RESPONSE_TIMEOUT_MS,
    );

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("T3 Code sent an oversized response."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let parsed: OpenWorkspaceResponse;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("T3 Code sent an invalid response."));
        return;
      }
      if (parsed.requestId !== request.requestId) {
        finish(new Error("T3 Code response did not match the request."));
        return;
      }
      finish(undefined, parsed);
    });

    socket.once("error", (error) => {
      finish(!connected && isUnreachable(error) ? new T3AppUnreachableError(address, error) : error);
    });

    socket.once("end", () => finish(new Error("T3 Code closed the connection.")));
  });
}

/** macOS bundle identifier of the T3 Code desktop app. */
const MAC_BUNDLE_ID = "com.t3tools.t3code";

function findEntries(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => pattern.test(entry))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** Best-effort guess at where the desktop app is installed. */
export function detectAppPath(): string | undefined {
  const home = os.homedir();
  if (process.platform === "win32") {
    const installDirs = [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs", "t3code")];
    for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (programFiles) installDirs.push(path.join(programFiles, "t3code"), ...findEntries(programFiles, /^T3 Code/i));
    }
    const exe = /^T3[ -]Code.*\.exe$/i;
    return installDirs.flatMap((dir) => findEntries(dir, exe)).find((file) => !/uninstall/i.test(path.basename(file)));
  }
  if (process.platform === "darwin") {
    return ["/Applications", path.join(home, "Applications")].flatMap((dir) => findEntries(dir, /^T3 Code.*\.app$/i))[0];
  }
  const appImageDirs = [
    path.join(home, "Applications"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, "Downloads"),
    "/opt",
  ];
  return appImageDirs.flatMap((dir) => findEntries(dir, /^T3[ -]?Code.*\.AppImage$/i))[0];
}

/** Whether the app can be launched without a configured or detected path. */
export function canLaunchWithoutPath(): boolean {
  return process.platform === "darwin";
}

/** Starts the desktop app. Resolves once the launcher has started, rejects if it can't. */
export function launchApp(appPath: string | undefined): Promise<void> {
  const [command, args] =
    process.platform === "darwin" && (!appPath || appPath.endsWith(".app"))
      ? ["open", appPath ? ["-a", appPath] : ["-b", MAC_BUNDLE_ID]]
      : [appPath ?? "", []];
  if (!command) return Promise.reject(new Error("No T3 Code app path to launch."));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    if (command === "open") {
      // `open` exits right after handing off to Launch Services; non-zero means it couldn't find the app.
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("macOS couldn't find the T3 Code app."))));
    } else {
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }
  });
}

/** Whether the T3 Code server recorded in `server-runtime.json` is still alive. */
export function isServerRunning(baseDir: string): boolean {
  let pid: unknown;
  try {
    pid = JSON.parse(fs.readFileSync(path.join(baseDir, "userdata", "server-runtime.json"), "utf8")).pid;
  } catch {
    return false;
  }
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Sends the request, retrying while the freshly launched app starts up. */
export async function sendOpenWorkspaceWhenReady(
  address: string,
  workspaceRoot: string,
  timeoutMs = LAUNCH_WAIT_MS,
): Promise<OpenWorkspaceResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await sendOpenWorkspace(address, workspaceRoot);
    } catch (error) {
      if (!(error instanceof T3AppUnreachableError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
    }
  }
}
