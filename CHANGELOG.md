# Changelog

## 0.3.0

- **T3 Code panel**: open T3 Code's own interface in a tab beside your code (**T3 Code: Open T3 Code Panel**, or the button on the T3 Agents view). Signs in automatically with a token from T3 Code's bundled CLI, stored in VS Code's secret storage, through a locked-down loopback relay. Desktop-only T3 Code features aren't available in the panel.

## 0.2.0

- **Live agent status** from T3 Code, across all your repos:
  - Explorer badges on project folders with working agents (`!` when one needs you, `×` on errors).
  - **T3 Agents** panel: every project and its threads with status (working, needs you, error, done), plus buttons to open a new thread or the project folder.
  - Status bar summary while agents are active; click to open the panel.
  - Notifications when an agent finishes, needs you, or fails (`t3code.agents.notifications`).
- **Show in T3 Code** brings the T3 Code window to the front.

## 0.1.0

- **Open Thread** on folders in the Explorer: opens the folder as a T3 Code project and starts a new thread.
- **Ctrl+Alt+T** / **Cmd+Alt+T** and **T3 Code: Open Thread for Current Project** for the active project.
- Launches T3 Code if it isn't running (Windows, macOS, Linux AppImage).
