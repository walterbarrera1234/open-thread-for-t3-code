/**
 * Obtains a bearer token for T3 Code's local server without user interaction,
 * using the `t3 auth session issue` CLI that ships inside the desktop app.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface ServerEndpoint {
  host: string;
  port: number;
}

export interface IssuedToken {
  token: string;
  sessionId: string;
  expiresAt: string;
}

export const PANEL_TOKEN_LABEL = "VS Code panel (Open Thread for T3 Code)";

/** Where the running T3 Code server listens, from `server-runtime.json`. */
export function readServerEndpoint(baseDir: string): ServerEndpoint | undefined {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(baseDir, "userdata", "server-runtime.json"), "utf8"));
    if (typeof runtime.port === "number") return { host: typeof runtime.host === "string" ? runtime.host : "127.0.0.1", port: runtime.port };
  } catch {
    // Not running or never started.
  }
  return undefined;
}

/** The desktop app's executable and its bundled server CLI entry point. */
export function resolveServerCli(appPath: string): { executable: string; cli: string } | undefined {
  const cliInResources = (resources: string) => path.join(resources, "server.asar", "apps", "server", "dist", "bin.mjs");
  if (appPath.endsWith(".app")) {
    const macOsDir = path.join(appPath, "Contents", "MacOS");
    const executable = fs.existsSync(macOsDir) ? fs.readdirSync(macOsDir).map((f) => path.join(macOsDir, f))[0] : undefined;
    const resources = path.join(appPath, "Contents", "Resources");
    return executable && fs.existsSync(path.join(resources, "server.asar")) ? { executable, cli: cliInResources(resources) } : undefined;
  }
  const resources = path.join(path.dirname(appPath), "resources");
  return fs.existsSync(path.join(resources, "server.asar")) ? { executable: appPath, cli: cliInResources(resources) } : undefined;
}

export function issueToken(appPath: string, baseDir: string, ttl = "30d"): Promise<IssuedToken> {
  const cli = resolveServerCli(appPath);
  if (!cli) return Promise.reject(new Error("This T3 Code install doesn't include the server CLI needed to sign in."));
  const args = [cli.cli, "auth", "session", "issue", "--label", PANEL_TOKEN_LABEL, "--ttl", ttl, "--json", "--base-dir", baseDir];
  return new Promise((resolve, reject) => {
    execFile(
      cli.executable,
      args,
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 90_000, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(new Error(`T3 Code's CLI couldn't issue a token (${error.message}).`));
        try {
          const issued = JSON.parse(stdout.slice(stdout.indexOf("{")));
          if (typeof issued.token !== "string") throw new Error("missing token");
          resolve({ token: issued.token, sessionId: String(issued.sessionId), expiresAt: String(issued.expiresAt) });
        } catch (parseError) {
          reject(new Error(`T3 Code's CLI returned an unexpected response (${String(parseError)}).`));
        }
      },
    );
  });
}

/** Whether the server still accepts the token (it may have expired or been revoked). */
export async function isTokenValid(endpoint: ServerEndpoint, token: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/api/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await response.json()) as { authenticated?: boolean };
    return body.authenticated === true;
  } catch {
    return false;
  }
}
