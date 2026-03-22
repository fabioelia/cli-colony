# Claude Colony

Desktop app for managing multiple Claude CLI sessions. Launch, track, and interact with parallel Claude terminal sessions from a single window.

## Install & Run

```bash
# Clone
git clone git@github.com:fabioelia/cli-colony.git
cd cli-colony

# Install dependencies (requires Node.js 20+ and Yarn 3.6+)
yarn install

# Run in development
yarn dev

# Build for production
yarn package
```

Requires `claude` CLI installed and available in your PATH (`~/.local/bin/claude`).

## Features

### Session Management
- Launch multiple Claude CLI sessions with custom names, colors, and working directories
- Kill, restart, remove, rename, recolor sessions from the sidebar
- Pin important sessions to the top of the list
- Per-session split view — each session can have a split partner, click to toggle
- Activity detection — pulsing dot when busy, solid dot when idle
- Smart unread indicator — filters TUI redraws, only triggers on genuinely new content
- Info popup showing launch command, directory, PID, MCP servers, token usage
- Auto-cleanup of exited sessions after configurable timeout
- Unique colors — new sessions pick the least-used color, synced to Claude CLI via `/color`
- Session name synced to Claude CLI via `/rename`

### Persistent PTY Daemon
- Standalone Node.js daemon owns all PTY file descriptors independently of Electron
- Sessions survive app crashes and restarts — reconnect to running sessions
- Unix domain socket communication with NDJSON protocol
- Auto-spawns daemon on app start, auto-reconnects on disconnect
- Daemon restart from Settings (with confirmation warning)
- Daemon logs visible in Settings alongside app logs

### GitHub PR Integration
- **PRs tab** in the sidebar — configure repositories you care about
- Fetches open PRs via `gh` CLI with descriptions, comments (general + file-level), assignees, reviewers, labels
- **PR filters** — text search across titles/descriptions/comments, status/author/reviewer/label multiselect chips
- **Quick actions** per PR — configurable prompt templates (Review, Summarize, Checkout & Test)
- **Global prompts** — prefill the ask bar with common questions (My PRs, Needs Review, Stale PRs)
- **Ask bar** — natural language questions about your PRs with persistent PR Assistant session
- **Comments viewer** — split modal with sidebar grouped by general/file, markdown rendered, newest first
- **PR Memory** — persistent knowledge base that CLI sessions read/write across conversations
- **PR Context file** — auto-generated markdown with all PR data, referenced by CLI sessions
- **Comment files** — separate file per PR with full comment history
- Prompt scope system: `pr` (per-PR with template variables) vs `global` (prefills ask bar)
- 15 template variables: `{{pr.number}}`, `{{pr.title}}`, `{{pr.branch}}`, `{{pr.status}}`, `{{pr.author}}`, `{{pr.assignees}}`, `{{pr.reviewers}}`, `{{pr.labels}}`, etc.
- Relative markdown links resolved to absolute GitHub URLs
- Auto-refresh all repos on page load, ensures context is current before launching prompts

### Split View
- Per-session split partners — session A's split with B persists when switching away
- Split indicator icon in sidebar for sessions with split partners
- Click a pane to focus it; `Cmd+Option+Left/Right` to toggle focus
- Draggable divider (min 30% per pane, double-click to reset 50/50)
- L/R badges on sidebar sessions showing which pane they occupy
- Auto-scroll both terminals to bottom when entering split mode
- `Cmd+\` to toggle split, `Cmd+Shift+W` to close split

### Terminal
- Full xterm.js terminal — xterm cursor hidden, Claude CLI renders its own
- SIGWINCH resize bounce on instance switch and window resize forces Claude CLI to repaint
- Sync-block-aware proxy (DEC 2026h/l) for smooth TUI redraws
- Scroll position preservation — reading history while output streams won't jump
- Search within terminal output (`Cmd+F`)
- Font size zoom (`Cmd+=` / `Cmd+-` / `Cmd+0`)
- Drag & drop files onto terminal to paste their path
- Left padding for breathing room

### File Explorer
- **Files tab** per session — split view with tree on left, file preview on right
- Lazy-loading directory tree with expand/collapse all per folder
- Root folder node for the working directory
- **Open in Finder** button to open the directory in macOS Finder
- **File name filter** — type to filter the tree by name, matching dirs auto-expand
- **Content search** — grep-powered search across all files in the project
  - Results grouped by directory in a tree view
  - Click a match to preview the file with search term highlighted
  - Infinite scroll — auto-loads more results as you scroll
  - Configurable ignore rules (gear icon) — add custom patterns, persisted to settings
- **File preview** with line numbers
- **Cmd+F in preview** — search within file with Enter/Shift+Enter navigation, active match highlighting
- Click a file to paste its path into the terminal

### Session History
- Browse Claude CLI conversation history with search
- Resume prior sessions with one click (deduplicates already-open ones)
- Sessions renamed via `/rename` show their custom name
- "Recent" badge on sessions previously opened in the app
- Restore all sessions from last app run on launch (preserves pinned state)

### Agents
- Browse personal agents from `~/.claude/agents/` and project-level agents
- Card-based UI with color accent, model badge, description, tool tags
- **Create agents** directly from the UI with template
- Edit agents in a split view: markdown file editor + live Claude terminal
- CLI primed to help build/refine the agent definition
- **Auto-reload** — editor refreshes from disk when CLI finishes editing
- Export/import agents as zip files per section
- Launch sessions pre-configured from agent definitions

### Settings
- Default CLI arguments applied to all new sessions
- **Shell profile** — choose which shell to load environment from (reads `/etc/shells`)
- Global hotkey to summon the app (default `Ctrl+Shift+Space`)
- Sound notification when Claude finishes processing (busy → waiting, app not focused)
- Native notification with click-to-focus
- Auto-cleanup timeout for stopped sessions
- Search ignore rules for file tree and content search
- PTY Daemon restart with confirmation
- Application + daemon logs viewer

### System Integration
- macOS tray icon (template image, auto light/dark mode) with running session count
- App name shows "Claude Colony" in Cmd+Tab switcher
- Global hotkey to bring app to front
- Git branch detection per session
- Token/cost tracking parsed from CLI output
- MCP server detection from CLI output
- Drag & drop folders onto sidebar to create new session
- Rich tooltips on all buttons with descriptions and keyboard shortcuts
- Crash handler with reload/continue options and stack trace

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New session |
| `Cmd+W` | Kill/remove active session |
| `Cmd+\` | Toggle split view |
| `Cmd+Shift+W` | Close split view |
| `Cmd+Option+Left/Right` | Switch focus between split panes |
| `Cmd+F` | Find in terminal / file preview |
| `Cmd+1` – `Cmd+9` | Switch session by position (pinned → active → stopped) |
| `Alt+Tab` / `Alt+Shift+Tab` | Cycle through sessions |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Zoom in / out / reset |
| `Escape` | Close any open modal |

## Data Storage

All app data lives in `~/.claude-colony/`:

```
~/.claude-colony/
├── settings.json          # App settings (args, shell, hotkey, ignore rules)
├── recent-sessions.json   # Tracks recently opened sessions for restore
├── github.json            # GitHub repos and custom PR prompts
├── daemon.sock            # Unix socket for daemon communication
├── daemon.pid             # Daemon process ID
├── daemon.log             # Daemon process logs
├── screenshots/           # Pasted clipboard images
└── pr-workspace/          # Dedicated workspace for PR-related instances
    ├── pr-context.md      # Auto-generated PR data for CLI consumption
    ├── pr-memory.md       # Persistent knowledge from PR conversations
    └── comments/          # Per-PR comment files (repo-number.md)
```

Session history is read from Claude CLI's own data at `~/.claude/history.jsonl`.

Agent definitions are read from `~/.claude/agents/` (personal) and `<project>/.claude/agents/` (project-level).

## Tech Stack

- **Electron** (electron-vite) — desktop shell
- **React 19** — UI
- **xterm.js 5** — terminal rendering (with fit, search, web-links addons)
- **node-pty** — PTY management for Claude CLI processes
- **marked** — markdown rendering for PR descriptions and comments
- **archiver / unzipper** — agent export/import
- **Lucide React** — icons
- **TypeScript** — throughout

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Electron App (Renderer + Main)                 │
│  ├── React UI (sidebar, terminals, panels)      │
│  ├── IPC handlers (bridge to daemon)            │
│  └── Notifications, tray, global hotkey         │
└──────────────┬──────────────────────────────────┘
               │ Unix domain socket (NDJSON)
┌──────────────▼──────────────────────────────────┐
│  PTY Daemon (standalone Node.js process)        │
│  ├── Owns all PTY file descriptors              │
│  ├── Survives app crashes / restarts            │
│  ├── Activity detection, token parsing          │
│  └── Color sync, MCP detection                  │
└─────────────────────────────────────────────────┘
```

## Project Structure

```
src/
├── daemon/                  # Standalone PTY daemon
│   ├── protocol.ts          # Shared NDJSON message types
│   └── pty-daemon.ts        # Daemon: PTY lifecycle, activity detection, color sync
├── main/                    # Electron main process
│   ├── index.ts             # App bootstrap, window, menu, tray, global hotkey
│   ├── instance-manager.ts  # Thin proxy over daemon client
│   ├── daemon-client.ts     # Connects to PTY daemon, auto-spawn, auto-reconnect
│   ├── ipc-handlers.ts      # IPC bridge between main and renderer
│   ├── github.ts            # GitHub integration (gh CLI, PR data, memory, workspace)
│   ├── agent-scanner.ts     # Scans for agent definitions, creates new agents
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
        ├── main.tsx          # React entry point (with ErrorBoundary)
        ├── lib/
        │   ├── constants.ts       # Shared colors, utilities
        │   └── terminal-proxy.ts  # Sync-block buffering, scroll preservation
        ├── components/
        │   ├── Sidebar.tsx          # Session list, history, tabs, context menu
        │   ├── TerminalView.tsx     # xterm.js terminal with file explorer
        │   ├── NewInstanceDialog.tsx # Create session form
        │   ├── GitHubPanel.tsx      # PR browser, filters, ask bar, comments viewer
        │   ├── AgentsPanel.tsx      # Agent browser with cards, create, export/import
        │   ├── AgentEditor.tsx      # Split view: file editor + terminal
        │   ├── SettingsPanel.tsx    # Settings + daemon + logs
        │   ├── Tooltip.tsx          # Rich tooltip component
        │   └── ErrorBoundary.tsx    # Crash handler with reload
        ├── styles/
        │   └── global.css           # All styles
        └── types/
            └── index.ts             # Shared TypeScript interfaces
```

## License

MIT
