# Claude Colony

Desktop app for managing multiple Claude CLI instances. Launch, track, and interact with parallel Claude terminal sessions from a single window.

## Install & Run

```bash
# Clone
git clone git@github.com:fabioelia/cli-manager.git
cd cli-manager

# Install dependencies (requires Node.js 20+ and Yarn 3.6+)
yarn install

# Run in development
yarn dev

# Build for production
yarn package
```

Requires `claude` CLI installed and available in your PATH (`~/.local/bin/claude`).

## Features

### Instance Management
- Launch multiple Claude CLI instances with custom names, colors, and working directories
- Kill, restart, remove, rename, recolor instances from the sidebar
- Pin important instances to the top of the list
- Activity detection — pulsing dot when an instance is actively streaming, solid dot when idle
- Unread indicator on background instances with new output
- Info popup showing launch command, directory, PID, MCP servers, token usage
- Auto-cleanup of exited instances after configurable timeout

### Split View
- Side-by-side terminal panes for monitoring two agents simultaneously
- Right-click any instance → "Open in Split View"
- Click a pane to focus it; `Cmd+Option+Left/Right` to toggle focus
- Draggable divider (min 30% per pane, double-click to reset 50/50)
- L/R badges on sidebar instances showing which pane they occupy
- `Cmd+\` to toggle split, `Cmd+Shift+W` to close split keeping both instances alive

### Terminal
- Full xterm.js terminal with transparent PTY passthrough
- Sync-block-aware proxy (DEC 2026h/l) for smooth rendering during Claude's TUI redraws
- Scroll position preservation — reading scroll history while output streams won't jump you around
- Search within terminal output (`Cmd+F`)
- Font size zoom (`Cmd+=` / `Cmd+-` / `Cmd+0`)
- Drag & drop files onto terminal to paste their path
- Colored header accent bar per instance
- Scroll-to-bottom button (hover bottom-right)
- Links open in system browser

### Sessions
- Browse Claude CLI conversation history with search
- Resume prior sessions with one click (deduplicates already-open ones)
- Sessions renamed via `/rename` show their custom name
- "Recent" badge on sessions previously opened in the app
- Restore all sessions from last app run on launch

### Agents
- Browse personal agents from `~/.claude/agents/` and project-level agents
- Edit agents in a split view: markdown file editor + live Claude terminal
- Launch instances pre-configured from agent definitions
- `Cmd+S` to save agent files (scoped to editor focus)

### Settings
- Default CLI arguments applied to all new instances
- Global hotkey to summon the app (default `Ctrl+Shift+Space`, requires restart)
- Sound notification toggle on instance exit (macOS Glass sound)
- Auto-cleanup timeout for exited instances (default 5 min, 0 to disable)
- Application logs viewer with auto-refresh

### System Integration
- Tray menu with running instance count and quick access
- Global hotkey to bring app to front from anywhere
- Native macOS notifications with click-to-focus
- Git branch detection per instance
- Token/cost tracking parsed from CLI output
- MCP server detection from CLI output
- Drag & drop folders onto sidebar to create new instance

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New instance |
| `Cmd+W` | Kill/remove active instance |
| `Cmd+\` | Toggle split view |
| `Cmd+Shift+W` | Close split view (keep both instances) |
| `Cmd+Option+Left/Right` | Switch focus between split panes |
| `Cmd+F` | Find in terminal |
| `Cmd+1` – `Cmd+9` | Switch instance by position |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Zoom in / out / reset |

## Data Storage

All app data lives in `~/.claude-colony/`:

```
~/.claude-colony/
├── settings.json          # App settings
└── recent-sessions.json   # Tracks recently opened sessions for restore
```

Session history is read from Claude CLI's own data at `~/.claude/history.jsonl`.

Agent definitions are read from `~/.claude/agents/` (personal) and `<project>/.claude/agents/` (project-level).

## Tech Stack

- **Electron** (electron-vite) — desktop shell
- **React 19** — UI
- **xterm.js 5** — terminal rendering (with fit, search, web-links addons)
- **node-pty** — PTY management for Claude CLI processes
- **Lucide React** — icons
- **TypeScript** — throughout

## Project Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App bootstrap, window, menu, tray, global hotkey
│   ├── instance-manager.ts  # PTY lifecycle, activity detection, token parsing, MCP detection
│   ├── ipc-handlers.ts      # IPC bridge between main and renderer
│   ├── agent-scanner.ts     # Scans ~/.claude/agents/ for agent definitions
│   ├── session-scanner.ts   # Reads ~/.claude/history.jsonl for session history
│   ├── recent-sessions.ts   # Tracks sessions opened via the app
│   ├── settings.ts          # Read/write ~/.claude-colony/settings.json
│   ├── tray.ts              # System tray menu
│   └── logger.ts            # In-memory log buffer for the logs viewer
├── preload/
│   └── index.ts             # Typed IPC bridge (contextBridge)
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx           # Root component, state orchestration, split view
        ├── main.tsx          # React entry point
        ├── lib/
        │   ├── constants.ts       # Shared colors, utilities
        │   └── terminal-proxy.ts  # Sync-block buffering, scroll preservation
        ├── components/
        │   ├── Sidebar.tsx          # Instance list, sessions, tabs, context menu
        │   ├── TerminalView.tsx     # xterm.js terminal with search, drag-drop, focus model
        │   ├── NewInstanceDialog.tsx # Create instance form
        │   ├── AgentsPanel.tsx      # Agent browser
        │   ├── AgentEditor.tsx      # Split view: file editor + terminal
        │   └── SettingsPanel.tsx    # Settings + logs viewer
        ├── styles/
        │   └── global.css           # All styles
        └── types/
            └── index.ts             # Shared TypeScript interfaces
```

## License

MIT
