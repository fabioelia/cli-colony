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
- Pin important instances to the top
- Unread indicator (pulsing dot) when background instances have new output
- Info popup showing command, directory, PID, MCP servers
- Auto-cleanup of exited instances after configurable timeout

### Terminal
- Full xterm.js terminal with transparent PTY passthrough
- Sync-block-aware proxy for smooth rendering during Claude's TUI redraws
- Search within terminal output (Cmd+F)
- Font size zoom (Cmd+= / Cmd+- / Cmd+0)
- Drag & drop files onto terminal to paste their path
- Colored header accent bar per instance
- Scroll navigation buttons (hover bottom-right)
- Links open in system browser (Cmd+click)

### Sessions
- Browse Claude CLI conversation history with search
- Resume prior sessions with one click (deduplicates already-open ones)
- Sessions renamed via `/rename` show their custom name
- "Recent" badge on sessions previously opened in the app
- Restore all sessions from last app run on launch

### Agents
- Browse personal agents from `~/.claude/agents/`
- Edit agents in a split view: markdown file editor + live Claude terminal
- Launch instances pre-configured from agent definitions
- Cmd+S to save agent files

### Settings
- Default CLI arguments (e.g. `--permission-mode bypassPermissions`) applied to all new instances
- Sound notification on instance exit (macOS Glass sound)
- Font size persistence
- Theme selection
- Auto-cleanup timeout (default 5 minutes, 0 to disable)
- Global hotkey (default `Ctrl+Shift+Space`)
- Application logs viewer

### System Integration
- Tray menu with running instance count and quick access
- Global hotkey to bring app to front from anywhere
- Keyboard shortcuts:
  - `Cmd+T` — New instance
  - `Cmd+W` — Kill/remove active instance
  - `Cmd+K` — Clear terminal
  - `Cmd+F` — Find in terminal
  - `Cmd+1` through `Cmd+9` — Switch instance by position
  - `Cmd+=` / `Cmd+-` / `Cmd+0` — Zoom in/out/reset
- Native macOS notifications with app icon
- Git branch detection per instance
- Token/cost tracking parsed from CLI output
- MCP server detection from CLI output
- Drag & drop folders onto sidebar to create new instance

### Status Bar
Running instance count, git branch, model, aggregated cost, font size, working directory, PID.

## Data Storage

All app data lives in `~/.claude-colony/`:

```
~/.claude-colony/
├── settings.json          # App settings (default args, font size, theme, etc.)
└── recent-sessions.json   # Tracks recently opened sessions for restore
```

Session history is read from Claude CLI's own data at `~/.claude/history.jsonl`.

Agent definitions are read from `~/.claude/agents/` (personal) and `<project>/.claude/agents/` (project-level).

## Tech Stack

- **Electron** (electron-vite) — desktop shell
- **React 19** — UI
- **xterm.js 5** — terminal rendering (with fit, search, web-links addons)
- **node-pty** — PTY management for Claude CLI processes
- **TypeScript** — throughout

## Project Structure

```
src/
├── main/                    # Electron main process
│   ├── index.ts             # App bootstrap, window, menu, tray, global hotkey
│   ├── instance-manager.ts  # PTY lifecycle, git branch, token parsing, MCP detection
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
        ├── App.tsx           # Root component, state orchestration
        ├── main.tsx          # React entry point
        ├── lib/
        │   └── terminal-proxy.ts  # Sync-block buffering for smooth TUI rendering
        ├── components/
        │   ├── Sidebar.tsx          # Instance list, sessions, tabs
        │   ├── TerminalView.tsx     # xterm.js terminal with search, drag-drop
        │   ├── NewInstanceDialog.tsx # Create instance form
        │   ├── AgentsPanel.tsx      # Agent browser
        │   ├── AgentEditor.tsx      # Split view: file editor + terminal
        │   ├── SettingsPanel.tsx     # Settings + logs viewer
        │   ├── LogsViewer.tsx       # Standalone logs component
        │   └── SessionsList.tsx     # Session browser (standalone, unused)
        ├── styles/
        │   └── global.css           # All styles
        └── types/
            └── index.ts             # Shared TypeScript interfaces
```

## License

MIT
