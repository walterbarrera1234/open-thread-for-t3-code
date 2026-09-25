import * as vscode from "vscode";
import { startPanelProxy, type PanelProxy } from "./panelProxy";
import { isTokenValid, issueToken, readServerEndpoint, type ServerEndpoint } from "./t3Auth";

const TOKEN_SECRET = "t3code.panelToken";

export interface PanelDeps {
  baseDir(): string;
  appPath(): string | undefined;
  showApp(): Promise<void>;
}

let panel: vscode.WebviewPanel | undefined;
let proxy: PanelProxy | undefined;
let token: string | undefined;

async function ensureToken(context: vscode.ExtensionContext, deps: PanelDeps, endpoint: ServerEndpoint): Promise<string> {
  token ??= await context.secrets.get(TOKEN_SECRET);
  if (token && (await isTokenValid(endpoint, token))) return token;

  const appPath = deps.appPath();
  if (!appPath) throw new Error("The T3 Code desktop app couldn't be found. Set t3code.appPath.");
  const issued = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Signing the T3 Code panel in…" },
    () => issueToken(appPath, deps.baseDir()),
  );
  token = issued.token;
  await context.secrets.store(TOKEN_SECRET, token);
  return token;
}

function html(webview: vscode.Webview, entryUrl: string, port: number): string {
  const csp = [`default-src 'none'`, `frame-src http://127.0.0.1:${port}`, `style-src ${webview.cspSource} 'unsafe-inline'`].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; }</style>
</head>
<body>
  <iframe src="${entryUrl}" allow="clipboard-read; clipboard-write" title="T3 Code"></iframe>
</body>
</html>`;
}

export async function openPanel(context: vscode.ExtensionContext, deps: PanelDeps, log: vscode.OutputChannel) {
  if (panel) {
    panel.reveal(undefined, true);
    return;
  }
  const endpoint = readServerEndpoint(deps.baseDir());
  if (!endpoint) {
    const choice = await vscode.window.showErrorMessage("T3 Code isn't running. Start it, then open the panel again.", "Start T3 Code");
    if (choice) await deps.showApp();
    return;
  }

  try {
    await ensureToken(context, deps, endpoint);
  } catch (error) {
    vscode.window.showErrorMessage(`Couldn't sign the T3 Code panel in: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  proxy = await startPanelProxy({
    target: () => readServerEndpoint(deps.baseDir()),
    token: () => token ?? "",
    log: (message) => log.appendLine(message),
  });

  panel = vscode.window.createWebviewPanel(
    "t3code.panel",
    "T3 Code",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "agents.svg");
  panel.webview.html = html(panel.webview, proxy.entryUrl, proxy.port);
  panel.onDidDispose(() => {
    panel = undefined;
    void proxy?.close();
    proxy = undefined;
  });
}

export function registerPanel(context: vscode.ExtensionContext, deps: PanelDeps) {
  const log = vscode.window.createOutputChannel("T3 Code Panel");
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("t3code.openPanel", () => openPanel(context, deps, log)),
    { dispose: () => void proxy?.close() },
  );
}
