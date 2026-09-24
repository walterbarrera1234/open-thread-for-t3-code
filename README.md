# Open Thread for T3 Code

Right-click a folder in the VS Code Explorer and choose **Open Thread**. T3 Code adds the folder as a project (or reuses the existing one), opens a new thread in it, and brings its window to the front.

Press **Ctrl+Alt+T** (**Cmd+Alt+T** on macOS), or run **T3 Code: Open Thread for Current Project** from the Command Palette, to open a thread for the project you're in: the workspace folder containing the active file, or a picker if that's ambiguous.

Each run opens a new thread in the folder's project. If the previous new thread was never sent, T3 Code reuses that empty draft instead of creating another.

> Unofficial community extension, not affiliated with T3 Tools. Requires the [T3 Code desktop app](https://github.com/pingdotgg/t3code/releases).

## Platform support

| OS | Auto-launch when T3 Code isn't running |
| --- | --- |
| Windows (x64, arm64) | Finds per-user and per-machine installs. |
| macOS | Launches by bundle ID (`com.t3tools.t3code`), wherever it's installed. |
| Linux | Finds `T3-Code-*.AppImage` in `~/Applications`, `~/.local/bin`, `~/bin`, `~/Downloads` or `/opt`; otherwise set `t3code.appPath`. |

If T3 Code is running but too old to accept requests, you'll be asked to update it.

## How it works

The T3 Code desktop app listens on a local app-control socket, the same one the `t3 app` CLI uses:

- Windows: `\\.\pipe\t3code-app-<hash>`
- macOS/Linux: `$TMPDIR/t3code-<uid>/<hash>.sock`

`<hash>` is the first 12 bytes of `sha256(<T3 home>/userdata)`, hex-encoded. The extension sends one JSON line:

```json
{"version":1,"requestId":"<uuid>","type":"open-workspace","workspaceRoot":"C:\\path\\to\\folder","platform":"win32"}
```

and gets back `{ ok: true, projectId, threadId }` or `{ ok: false, code, message }`. No tokens or network access are involved; the socket is local to your user.

If the app isn't running, the extension launches it and retries for up to 60 seconds.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `t3code.homeDir` | `$T3CODE_HOME` or `~/.t3` | T3 Code data directory (determines the socket name). |
| `t3code.appPath` | auto-detect | Desktop app executable used for auto-launch. |
| `t3code.launchIfNotRunning` | `true` | Launch T3 Code if it isn't running. |

## Develop

```sh
npm install
npm run compile      # or: npm run watch, then F5 in VS Code
npm run package      # builds open-thread-for-t3-code-<version>.vsix
code --install-extension open-thread-for-t3-code-0.1.0.vsix
```

Limitation: local folders only. Folders from Remote-SSH/WSL/containers are rejected, since T3 Code's local environment can't map those paths.
