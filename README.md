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
- Session names set via `--name` flag at launch, shown in CLI `/resume` and Colony sidebar
- Kill, restart, remove, rename, recolor sessions from the sidebar
- Pin important sessions to the top of the list
- Per-session split view — each session can have a split partner, click to toggle
- Activity detection — pulsing dot when busy, solid dot when idle
- Smart unread indicator — filters TUI redraws, only triggers on genuinely new content
- Info popup showing launch command, directory, PID, MCP servers, token usage, and child processes
- **Child process visibility** — info popover lists processes (vite, runserver, redis, etc.) running under the session's directory with CPU/memory stats and kill button
- Auto-cleanup of exited sessions after configurable timeout
- Unique colors — new sessions pick the least-used color (Colony-tracked)
- Shortcut numbers (1-9) shown on each session in sidebar for quick `Cmd+N` jumping
- Resume from history detects already-running sessions and focuses them instead of duplicating

### Persistent PTY Daemon
- Standalone Node.js daemon owns all PTY file descriptors independently of Electron
- Sessions survive app crashes and restarts — reconnect to running sessions
- Unix domain socket communication with NDJSON protocol
- Auto-spawns daemon on app start, auto-reconnects on disconnect
- Fast activity detection — 500ms polling during startup, 2s during normal operation
- **Version tracking** — daemon reports its protocol version; app shows an amber banner when the daemon is outdated with a one-click "Restart Daemon" button
- Daemon restart from Settings (with confirmation warning, version display)
- Daemon logs visible in Settings alongside app logs

### GitHub PR Integration
- **PRs tab** in the sidebar — configure repositories you care about
- **Add repos** by owner/name or paste any GitHub URL — auto-parses the owner and repo name
- Fetches open PRs via `gh` CLI with descriptions, comments (general + file-level), assignees, reviewers, labels
- **CI/CD Status** — GitHub Actions check status per PR across all repos (green/red/yellow badges), fetch logs for failures
- **PR filters** — text search across titles/descriptions/comments, status/author/reviewer/label multiselect chips
- **Quick actions** per PR — configurable prompt templates (Review, Summarize, Checkout & Test)
- **Colony Feedback Review** — when Colony Feedback pipeline is enabled, the Review button instructs the agent to push structured feedback to the `colony-feedback` branch
- **Global prompts** — prefill the ask bar with common questions (My PRs, Needs Review, Stale PRs)
- **Ask bar** — natural language questions about your PRs with persistent PR Assistant session
- **Comments viewer** — split modal with sidebar grouped by general/file, markdown rendered, newest first
- **PR Memory** — persistent knowledge base that CLI sessions read/write across conversations
- **PR Context file** — auto-generated markdown with all PR data, referenced by CLI sessions
- **Comment files** — separate file per PR with full comment history
- **Repo config refresh** — PR refresh also fetches the bare repo and discovers `.colony/` templates
- Template variables: `{{pr.number}}`, `{{pr.title}}`, `{{pr.description}}`, `{{pr.branch}}`, `{{pr.url}}`, `{{pr.author}}`, `{{pr.status}}`, `{{pr.reviewDecision}}`, `{{pr.assignees}}`, `{{pr.reviewers}}`, `{{pr.labels}}`, `{{pr.additions}}`, `{{pr.deletions}}`, `{{repo.owner}}`, `{{repo.name}}`

### Command Palette
- **Cmd+K** opens a fuzzy search across everything
- Switch to any active session, resume history sessions, navigate to any panel
- **Cross-session terminal search** — type 3+ characters to search terminal output across all running sessions
- Actions: New Session, Kill active, Toggle Split
- Arrow keys + Enter to select, Escape to close

### Task Queue
- **Tasks tab** — ask bar + YAML editor with Config/Memory/Outputs tabs
- Define task queues as YAML files in `~/.claude-colony/task-queues/`
- Each task: prompt + optional working directory, run parallel or sequential in a single session
- **Single-session execution** — all tasks run in one Claude session (parallel: agent optimizes order; sequential: one at a time)
- **Output directory** — injected at runtime as `~/.claude-colony/outputs/<queue-name>/<timestamp>/`, task prompts don't hardcode paths
- **Outputs tab** — browse run folders with files, split view with markdown/source toggle and table rendering
- **Memory** — `<queue>.memory.md` files with learnings from previous runs, injected into prompts automatically
- **Task Assistant** — ask bar launches a session to help create/edit task YAML
- **Convert to Pipeline** — one-click conversion with editable name, cron schedule, and reuse toggle
- Parse validation shows task count and mode before running

### Pipelines
- **Pipelines tab** — reactive automation: trigger → condition → action
- Define pipelines as YAML files in `~/.claude-colony/pipelines/`
- **Triggers**: `git-poll` (polls repos on interval), `cron` (fires once per schedule), `file-poll`
- **Cron scheduling** — `"0 9-17 * * 1-5"` = hourly 9am-5pm weekdays. Supports `*`, `*/N`, `N-M`, named days
- **Conditions**: `branch-file-exists`, `pr-checks-failed` (with `exclude` list), `always`
- **Actions**: `launch-session`, `route-to-session` (score-based matching), `reuse: true` flag
- **Intelligent session routing** — finds existing sessions by live git branch, repo name, PR number, session name. Resumes from CLI history via `--resume`. Falls back to launching new.
- **Content-hash dedup** — tracks Git SHA of matched files, only re-fires when content changes
- **Memory** — `<pipeline>.memory.md` injected into prompts, sessions told to append learnings
- **Outputs** — configurable `outputs` directory, browsable in the UI
- **Companion docs** — `<name>.readme.md` shown as a Docs tab
- **Pipeline Assistant** — ask bar to create/modify pipelines
- **Running indicator** — pulsing amber dot + badge when actively polling
- **Error display** — inline error block with full message
- Prompts delivered via `--append-system-prompt-file` (no PTY pollution)
- **Pre-seeded pipelines** (disabled):
  - **Colony Feedback** — routes reviewer feedback from `colony-feedback` branch to existing session
  - **CI Auto-Fix** — hourly during work hours, finds failing CI (excluding playwright/e2e), auto-fixes
  - **PR Attention Digest** — hourly digest of PRs needing attention with risk assessment
- **Parent-child sessions** — spawn child sessions that report back via structured handoff documents
  - Child writes a handoff to `~/.claude-colony/handoffs/<id>.md` when done
  - Parent is automatically notified to read the handoff and decide next steps
  - Sidebar shows parent/child relationships (↳ indicator, child count)

### Environments
- **Template-based dev environments** — define environment templates with repos, services, and hooks
- **Environment daemon** — dedicated Node.js process managing service lifecycles, port allocation, and log streaming
- **Service management** — start, stop, restart individual services; live status with uptime, restarts, port info
- **Port allocator** — automatic unique port assignment per environment to avoid conflicts
- **Setup hooks** — clone repos, install dependencies, run migrations on environment creation
- **Logs tab** — real-time streaming log viewer across all services with per-service filtering, auto-scroll, and 2K line buffer
- **Diagnose mode** — launch a Claude session pre-loaded with environment state, crash info, and service logs
- **Template editor** — edit environment templates with a Claude-assisted session
- **`.colony/` repo convention** — repos define templates, pipelines, prompts, and context in `.colony/` directories; discovered from bare repo refs (`origin/HEAD`) on PR refresh and app boot
- **Lazy template loading** — Environments tab reads from cache instantly; heavy repo scanning only on boot and manual refresh

### Resource Monitor
- Live CPU and memory usage in the status bar
- Per-session usage for the active session
- Total Colony resource usage (all sessions + child processes)
- Polls every 5 seconds via `ps`

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
- **File preview** with line numbers and toggleable word wrap
- **Cmd+F in preview** — search within file with Enter/Shift+Enter navigation, active match highlighting
- Click a file to paste its path into the terminal

### External Sessions
- **Detect** Claude CLI processes running outside Colony (terminal, VS Code, etc.)
- Preview conversation messages before taking over
- **Takeover** — kills the external process and resumes the session inside Colony with full history
- Session ID detection via open file handles, command-line flags, or project directory matching
- CWD resolution via `lsof` before process termination

### Session History
- Browse Claude CLI conversation history with search
- Session names resolved from `customTitle` in CLI session files (set via `--name` flag)
- Resume prior sessions with one click — detects already-running sessions and focuses them
- "Recent" badge on sessions previously opened in the app
- **Snapshot-based restore** — on app quit, snapshots running sessions to a separate file; only those are offered for restore on next launch (not sessions previously stopped by the user)
- Deduplicates by sessionId and filters out sessions the daemon already reconnected to

### Agents
- Browse personal agents from `~/.claude/agents/` and project-level agents
- Card-based UI with color accent, model badge, description, tool tags
- **Create agents** directly from the UI with template
- Edit agents in a split view: markdown file editor + live Claude terminal
- CLI primed to help build/refine the agent definition
- **Auto-reload** — editor refreshes from disk when CLI finishes editing
- Export/import agents as zip files per section
- Launch sessions pre-configured from agent definitions

### Personas
- **Autonomous AI agents** with persistent identity, goals, memory, and a planning loop
- Persona defined by a single `.md` file with YAML frontmatter (schedule, model, permissions) and self-managed sections (Role, Objectives, Active Situations, Learnings, Session Log)
- **Planning loop** — each session: read identity file → read colony context → assess changes → decide actions → execute → update memory
- **Self-modifying memory** — persona reads and writes its own `.md` file for continuity across sessions
- **Permission scopes** — `can_push`, `can_merge`, `can_create_sessions` flags in frontmatter
- **Sub-task sessions** — persona can launch `claude -p` sessions for delegated work
- **Persona Assistant** — ask bar with system prompt that knows the file format and creates/modifies personas
- Manual run button + enable/disable toggle for scheduled runs
- Expandable cards showing role, objectives, active situations, learnings, session log, and permissions

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

### In-App Help
- **Help popovers** on every panel — click the `?` icon to see zone-structured descriptions of each area of the UI
- Content organized by visual zones (Header, Main area, Actions, etc.) with collapsible sections
- **Inline icons** — action items show the same Lucide icon used in the UI so users can visually match
- Keyboard shortcuts listed where applicable
- Help content defined in `src/renderer/src/lib/help-content.ts` — kept in sync via CLAUDE.md guidelines

### Consistent UI Patterns
- **Shared panel header** — all panels use `.panel-header` with title, spacer, help icon, and action buttons
- **Shared ask bar** — GitHub, Tasks, and Pipelines use `.panel-ask-bar` positioned below the header
- **Settings and help in sidebar footer** — bottom-left of the sidebar, outside the nav tabs

### System Integration
- macOS tray icon (template image, auto light/dark mode) with running session count
- App name shows "Claude Colony" in Cmd+Tab switcher
- Global hotkey to bring app to front
- Git branch + repo detection per session (shown as badges in session header)
- Token/cost tracking parsed from CLI output
- MCP server detection from CLI output
- Drag & drop folders onto sidebar to create new session
- Rich tooltips on all buttons with descriptions and keyboard shortcuts
- Crash handler with reload/continue options and stack trace
- **Colony Context** — shared `colony-context.md` file auto-generated with all active sessions, repos, agents, task queues, and handoffs. Every Colony-launched session is told to read it for broader workspace awareness.

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
| `Cmd+K` | Command palette (+ cross-session terminal search) |
| `Cmd+=` / `Cmd+-` / `Cmd+0` | Zoom in / out / reset |
| `Escape` | Close any open modal |

## Data Storage

All app data lives in `~/.claude-colony/`:

```
~/.claude-colony/
├── settings.json          # App settings (args, shell, hotkey, ignore rules)
├── recent-sessions.json   # Tracks recently opened sessions for restore
├── restore-snapshot.json  # Sessions running at last app quit (for restore)
├── github.json            # GitHub repos and custom PR prompts
├── daemon.sock            # Unix socket for PTY daemon
├── daemon.pid             # PTY daemon process ID
├── daemon.log             # PTY daemon logs
├── env-daemon.sock        # Unix socket for environment daemon
├── env-daemon.pid         # Environment daemon process ID
├── env-daemon.log         # Environment daemon logs
├── colony-context.md      # Auto-generated shared context for all sessions
├── environments/          # Template-based dev environments
│   └── <name>/            # Per-environment directory
│       ├── instance.json  # Environment manifest (repos, services, ports)
│       └── <repos>/       # Cloned repositories
├── repos/                 # Bare git repo clones for .colony/ config discovery
│   └── <owner>/<name>.git
├── environment-templates/ # User environment template definitions (JSON)
├── env-templates/         # Environment template definitions (YAML)
├── pipelines/             # YAML pipeline definitions (trigger → action)
│   ├── *.yaml             # Pipeline configs
│   ├── *.memory.md        # Pipeline learnings
│   └── *.readme.md        # Pipeline companion docs
├── pipeline-state.json    # Pipeline poll state, dedup keys, content hashes
├── pipeline-prompts/      # Temp files for --append-system-prompt-file
├── outputs/               # Task/pipeline output files
│   └── <queue-name>/      # Per-queue output directory
│       └── <timestamp>/   # Per-run timestamped folder
├── screenshots/           # Pasted clipboard images
├── task-queues/           # YAML task queue definitions
│   ├── *.yaml             # Task configs
│   └── *.memory.md        # Task learnings
├── task-workspace/        # Per-task run directories
├── handoffs/              # Child session handoff documents
├── reports/               # Pipeline-generated reports
└── pr-workspace/          # Dedicated workspace for PR-related instances
    ├── pr-context.md      # Auto-generated PR data for CLI consumption
    ├── pr-memory.md       # Persistent knowledge from PR conversations
    └── comments/          # Per-PR comment files (repo-number.md)
```

Session history is read from Claude CLI's own data at `~/.claude/history.jsonl` and `~/.claude/projects/*/`.

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
│  ├── IPC handlers (bridge to daemons)           │
│  ├── Pipeline engine (polling, routing, dedup)  │
│  └── Notifications, tray, global hotkey         │
└──────────┬──────────────────┬───────────────────┘
           │                  │ Unix domain sockets (NDJSON)
┌──────────▼───────────┐  ┌──▼──────────────────────────┐
│  PTY Daemon          │  │  Environment Daemon          │
│  ├── PTY lifecycle   │  │  ├── Service management      │
│  ├── Activity detect │  │  ├── Port allocation         │
│  ├── Token parsing   │  │  ├── Log streaming           │
│  └── MCP detection   │  │  └── Setup hook execution    │
└──────────────────────┘  └─────────────────────────────┘
```

## Project Structure

```
src/
├── shared/                  # Shared types and paths
│   ├── types.ts             # Canonical type definitions (ClaudeInstance, etc.)
│   └── colony-paths.ts      # Centralized path constants
├── daemon/                  # Standalone daemon processes
│   ├── protocol.ts          # PTY daemon NDJSON message types
│   ├── pty-daemon.ts        # PTY daemon: lifecycle, activity detection
│   ├── env-protocol.ts      # Environment daemon message types
│   └── env-daemon.ts        # Environment daemon: services, ports, logs
├── main/                    # Electron main process
│   ├── index.ts             # App bootstrap, window, menu, tray, global hotkey
│   ├── instance-manager.ts  # Thin proxy over PTY daemon client
│   ├── base-daemon-client.ts # Shared daemon client base (socket, NDJSON, reconnect)
│   ├── daemon-client.ts     # PTY daemon client
│   ├── env-daemon-client.ts # Environment daemon client
│   ├── env-manager.ts       # Environment lifecycle (create, start, stop, diagnose)
│   ├── repo-config-loader.ts # .colony/ directory discovery (working tree + bare repo)
│   ├── broadcast.ts         # Centralized event broadcasting to renderer
│   ├── ipc-handlers.ts      # IPC bridge + fs/resource handlers
│   ├── ipc/                 # Domain-specific IPC handlers
│   │   ├── instance-handlers.ts  # Instance CRUD + child process detection
│   │   ├── session-handlers.ts   # Session history, external detection, takeover
│   │   ├── agent-handlers.ts     # Agent CRUD
│   │   ├── github-handlers.ts    # GitHub/PR operations
│   │   ├── pipeline-handlers.ts  # Pipeline management
│   │   ├── task-queue-handlers.ts # Task queue operations
│   │   └── env-handlers.ts       # Environment operations
│   ├── github.ts            # GitHub integration (gh CLI, PR data, memory, workspace)
│   ├── agent-scanner.ts     # Scans for agent definitions, creates new agents
│   ├── session-scanner.ts   # Reads session history + customTitle from CLI data
│   ├── recent-sessions.ts   # Tracks sessions opened via the app
│   ├── colony-context.ts    # Shared context file generator for cross-session awareness
│   ├── pipeline-engine.ts   # Pipeline engine: triggers, conditions, routing, dedup
│   ├── persona-manager.ts   # Persona lifecycle: file parsing, planning loop, session launch
│   ├── port-allocator.ts    # Unique port assignment per environment
│   ├── shell-env.ts         # Shell environment resolution
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
        │   ├── constants.ts            # Shared colors, utilities
        │   ├── help-content.ts         # Zone-structured help content for all panels
        │   ├── terminal-proxy.ts       # Sync-block buffering, scroll preservation
        │   └── send-prompt-when-ready.ts # Reliable prompt delivery with trust prompt handling
        ├── components/
        │   ├── Sidebar.tsx              # Session list, history, external sessions, tabs
        │   ├── TerminalView.tsx         # xterm.js terminal with file explorer
        │   ├── NewInstanceDialog.tsx    # Create session form
        │   ├── ExternalSessionPopover.tsx # Preview & takeover external Claude sessions
        │   ├── GitHubPanel.tsx          # PR browser, filters, ask bar, comments viewer
        │   ├── AgentsPanel.tsx          # Agent browser with cards, create, export/import
        │   ├── AgentEditor.tsx          # Split view: file editor + terminal
        │   ├── SettingsPanel.tsx        # Settings + daemon + logs
        │   ├── TaskQueuePanel.tsx       # Task queue editor, runner, outputs browser
        │   ├── PipelinesPanel.tsx       # Pipeline management, YAML editor, docs viewer
        │   ├── PersonasPanel.tsx       # Autonomous AI persona management
        │   ├── EnvironmentsPanel.tsx    # Environment management, templates, services
        │   ├── EnvironmentLogViewer.tsx # Streaming log viewer per environment/service
        │   ├── NewEnvironmentDialog.tsx # Create environment from template
        │   ├── CommandPalette.tsx       # Cmd+K fuzzy search + cross-session terminal search
        │   ├── HelpPopover.tsx          # Zone-structured help popover with inline icons
        │   ├── Tooltip.tsx              # Rich tooltip component
        │   └── ErrorBoundary.tsx        # Crash handler with reload
        ├── styles/
        │   └── global.css               # All styles
        └── types/
            └── index.ts                 # Shared TypeScript interfaces
```

## License

MIT
