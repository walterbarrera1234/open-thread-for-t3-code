import * as path from "path";
import * as vscode from "vscode";
import {
  T3AppUnreachableError,
  canLaunchWithoutPath,
  detectAppPath,
  isServerRunning,
  launchApp,
  resolveBaseDir,
  resolveControlAddress,
  sendOpenWorkspace,
  sendOpenWorkspaceWhenReady,
  type OpenWorkspaceResponse,
} from "./t3Bridge";
import { registerAgentViews } from "./agents";
import { stateDbPath } from "./t3State";

const RUNNING_APP_GRACE_MS = 5_000;

const FAILURE_HINTS: Record<string, string> = {
  "environment-unavailable": "T3 Code's local environment isn't connected yet. Try again in a moment.",
  "platform-mismatch": "This folder lives on a different OS than T3 Code's local environment.",
  "project-create-failed": "T3 Code couldn't add this folder as a project.",
  "thread-open-failed": "T3 Code added the project but couldn't open a new thread.",
  "renderer-unavailable": "The T3 Code window isn't ready.",
};

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.openFolder", (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : uri ? [uri] : [];
      if (targets.length === 0) return openWorkspaceFolder();
      return openInT3(targets);
    }),
    vscode.commands.registerCommand("t3code.openWorkspace", openWorkspaceFolder),
    vscode.commands.registerCommand("t3code.showApp", showApp),
  );
  registerAgentViews(context, {
    dbPath: () => stateDbPath(resolveBaseDir(vscode.workspace.getConfiguration("t3code").get<string>("homeDir"))),
    openThread: openOne,
    showApp,
  });
}

export function deactivate() {}

async function openWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage("Open a folder first.");
    return;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const folder =
    activeFolder ??
    (folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Folder to open in T3 Code" }));
  if (folder) await openInT3([folder.uri]);
}

async function openInT3(uris: vscode.Uri[]) {
  for (const uri of uris) {
    if (uri.scheme !== "file") {
      vscode.window.showErrorMessage(`T3 Code can only open local folders (got ${uri.scheme}://).`);
      continue;
    }
    await openOne(await toFolderPath(uri));
  }
}

async function toFolderPath(uri: vscode.Uri): Promise<string> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) return uri.fsPath;
  } catch {
    // Fall through and let T3 Code report the problem.
  }
  return path.dirname(uri.fsPath);
}

async function openOne(folderPath: string) {
  const config = vscode.workspace.getConfiguration("t3code");
  const baseDir = resolveBaseDir(config.get<string>("homeDir"));
  const address = resolveControlAddress(baseDir);
  const name = path.basename(folderPath) || folderPath;

  let response: OpenWorkspaceResponse;
  try {
    response = await sendOpenWorkspace(address, folderPath);
  } catch (error) {
    if (!(error instanceof T3AppUnreachableError)) return reportError(name, error);
    if (isServerRunning(baseDir)) {
      // T3 Code is up but not listening yet (just started) or too old to support app control.
      try {
        response = await sendOpenWorkspaceWhenReady(address, folderPath, RUNNING_APP_GRACE_MS);
      } catch (retryError) {
        if (!(retryError instanceof T3AppUnreachableError)) return reportError(name, retryError);
        vscode.window.showErrorMessage(
          "T3 Code is running but isn't accepting Open Thread requests. Update T3 Code to the latest version and try again.",
        );
        return;
      }
    } else {
      if (!(await tryLaunch(config))) return;
      try {
        response = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Starting T3 Code and opening ${name}…` },
          () => sendOpenWorkspaceWhenReady(address, folderPath),
        );
      } catch (retryError) {
        return reportError(name, retryError);
      }
    }
  }

  if (response.ok) {
    vscode.window.setStatusBarMessage(`$(check) Opened ${name} in T3 Code`, 4000);
    return;
  }
  const hint = FAILURE_HINTS[response.code];
  vscode.window.showErrorMessage(`T3 Code couldn't open ${name}: ${response.message}${hint && hint !== response.message ? ` ${hint}` : ""}`);
}

async function tryLaunch(config: vscode.WorkspaceConfiguration): Promise<boolean> {
  if (!config.get<boolean>("launchIfNotRunning", true)) {
    vscode.window.showErrorMessage("T3 Code isn't running. Start the desktop app and try again.");
    return false;
  }
  const appPath = config.get<string>("appPath")?.trim() || detectAppPath();
  if (!appPath && !canLaunchWithoutPath()) return promptForAppPath("T3 Code isn't running and the desktop app couldn't be found.");
  try {
    await launchApp(appPath);
    return true;
  } catch (error) {
    return promptForAppPath(`T3 Code isn't running and couldn't be started (${error instanceof Error ? error.message : String(error)}).`);
  }
}

/** Brings T3 Code to the front; launching a running app just focuses its window. */
async function showApp() {
  const appPath = vscode.workspace.getConfiguration("t3code").get<string>("appPath")?.trim() || detectAppPath();
  if (!appPath && !canLaunchWithoutPath()) {
    await promptForAppPath("The T3 Code desktop app couldn't be found.");
    return;
  }
  try {
    await launchApp(appPath);
  } catch (error) {
    await promptForAppPath(`T3 Code couldn't be opened (${error instanceof Error ? error.message : String(error)}).`);
  }
}

async function promptForAppPath(reason: string): Promise<false> {
  const choice = await vscode.window.showErrorMessage(`${reason} Set its location in settings.`, "Open Settings");
  if (choice) vscode.commands.executeCommand("workbench.action.openSettings", "t3code.appPath");
  return false;
}

function reportError(name: string, error: unknown) {
  const message =
    error instanceof T3AppUnreachableError
      ? "T3 Code didn't start in time. Make sure the desktop app is running."
      : error instanceof Error
        ? error.message
        : String(error);
  vscode.window.showErrorMessage(`T3 Code couldn't open ${name}: ${message}`);
}
