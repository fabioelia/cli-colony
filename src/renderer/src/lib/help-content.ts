/**
 * Help content for each panel/view in the app.
 * Organized by visual zones so first-time users can map descriptions
 * to what they see on screen.
 */

export interface HelpItem {
  label: string
  detail: string
  /** Lucide icon name to show inline (must match a key in the icon map in HelpPopover) */
  icon?: string
}

export interface HelpZone {
  /** Zone name — maps to a visible region of the panel */
  name: string
  /** Where this zone appears */
  position: string
  items: HelpItem[]
}

export interface HelpEntry {
  title: string
  description: string
  /** Flat items (legacy, used if no zones) */
  items?: HelpItem[]
  /** Zone-structured content — groups of items by visual region */
  zones?: HelpZone[]
  shortcuts?: Array<{ keys: string; action: string }>
}

export const helpContent: Record<string, HelpEntry> = {
  sessions: {
    title: 'Sessions',
    description: 'Launch and manage multiple Claude CLI sessions. Each session is an independent terminal running Claude with its own working directory and context.',
    zones: [
      {
        name: 'Navigation Bar',
        position: 'Top of sidebar',
        items: [
          { label: 'Panel icons', detail: 'Switch between Sessions, Agents, PRs, Tasks, Pipelines, and Environments. Badges show counts.' },
        ],
      },
      {
        name: 'New Session Button',
        position: 'Below navigation',
        items: [
          { label: '+ New Session', detail: 'Opens a dialog to create a Claude CLI session. Set a name, color, working directory, and optional CLI args.', icon: 'Plus' },
          { label: 'Restore banner', detail: 'After app restart, shows a button to restore sessions that were running when you last quit.', icon: 'RotateCcw' },
        ],
      },
      {
        name: 'Session List',
        position: 'Main area',
        items: [
          { label: 'Active sessions', detail: 'Pulsing dot = Claude is working. Solid dot = waiting for input. Click to open.' },
          { label: 'Stopped sessions', detail: 'Dimmed with exit code. Auto-cleaned after 5 minutes (configurable in Settings).' },
          { label: 'Pin to top', detail: 'Right-click a session to pin it. Pinned sessions stay at the top and are restored on launch.', icon: 'Pin' },
          { label: 'Export Handoff Doc', detail: 'Generates a markdown snapshot of the session — git commits, terminal output, metadata — ready to paste into a new session to restore context.', icon: 'FileDown' },
          { label: 'Split indicator', detail: 'A columns icon appears on sessions that have a split partner.', icon: 'Columns2' },
          { label: 'Shortcut numbers', detail: 'Numbers 1-9 shown next to sessions for quick Cmd+N jumping.' },
        ],
      },
      {
        name: 'Sidebar Tabs',
        position: 'Below session list',
        items: [
          { label: 'Active tab', detail: 'Shows running sessions. This is the default view.' },
          { label: 'History tab', detail: 'Browse past Claude CLI conversations from ~/.claude/. Click to resume — detects already-running sessions.' },
          { label: 'External tab', detail: 'Detects Claude CLI processes running outside Colony (VS Code, terminal). Preview messages and take over.' },
        ],
      },
      {
        name: 'Footer',
        position: 'Bottom of sidebar',
        items: [
          { label: 'Help icon', detail: 'Opens this help popover.', icon: 'HelpCircle' },
          { label: 'Activity bell', detail: 'Shows recent automation events from personas, pipelines, and environments. Persona completion events include outcome stats: duration, commits made, and files changed.', icon: 'Bell' },
          { label: 'Settings gear', detail: 'Opens the Settings panel for CLI defaults, shell profile, daemon management, and more.', icon: 'Settings' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+T', action: 'New session' },
      { keys: 'Cmd+W', action: 'Kill/remove active session' },
      { keys: 'Cmd+1–9', action: 'Jump to session by position' },
      { keys: 'Alt+Tab', action: 'Cycle through sessions' },
      { keys: 'Cmd+\\', action: 'Toggle split view' },
      { keys: 'Cmd+K', action: 'Command palette — switch sessions, run personas, launch agents, navigate panels, search session history' },
      { keys: 'Cmd+Shift+↵', action: 'Quick Prompt — launch a new session with a prompt pre-filled; ↑↓ to cycle history' },
    ],
  },

  agents: {
    title: 'Agents',
    description: 'Browse, create, and launch Claude agent definitions. Agents are markdown files that configure Claude with specific instructions, tools, and model settings.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Refresh button', detail: 'Re-scans agent directories (~/.claude/agents/ and project-level) for new or changed agents.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Agent Cards',
        position: 'Main area — grid of cards',
        items: [
          { label: 'Card layout', detail: 'Each card shows the agent name, model badge, description, and allowed tool tags.' },
          { label: 'Color accent', detail: 'Top border color distinguishes agents visually.' },
          { label: 'Personal vs Project', detail: 'Personal agents (from ~/.claude/agents/) and project agents (from <project>/.claude/agents/) are shown together.' },
        ],
      },
      {
        name: 'Card Actions',
        position: 'Bottom of each card',
        items: [
          { label: 'Play button', detail: 'Launch a new Claude session pre-configured with this agent definition.', icon: 'Play' },
          { label: 'Edit button', detail: 'Opens a split view: markdown file editor on the left, Claude terminal on the right to help refine the agent.', icon: 'Pencil' },
          { label: 'Export', detail: 'Download the agent as a zip file to share with others.', icon: 'Download' },
        ],
      },
      {
        name: 'Create New',
        position: 'Empty state or + button',
        items: [
          { label: 'New agent dialog', detail: 'Create from a template with name, model, description, and tool permissions.', icon: 'Plus' },
          { label: 'Import', detail: 'Import an agent zip file created by another Colony user.', icon: 'Upload' },
        ],
      },
    ],
  },

  github: {
    title: 'Pull Requests',
    description: 'Monitor and act on open PRs across your GitHub repositories. Requires the gh CLI to be installed and authenticated.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Back arrow', detail: 'Return to the Sessions view.', icon: 'ArrowLeft' },
          { label: 'Memory button', detail: 'Open the PR Memory file — a persistent knowledge base that Claude sessions read and write to across conversations.', icon: 'Brain' },
          { label: 'Context button', detail: 'View the auto-generated PR context file that CLI sessions reference.', icon: 'FileText' },
          { label: 'Prompts button', detail: 'Edit quick-action templates (Review, Summarize, etc.) and global prompt questions.', icon: 'Pencil' },
          { label: 'Add Repo button', detail: 'Track a new repo by owner/name or paste any GitHub URL.', icon: 'Plus' },
        ],
      },
      {
        name: 'Repository List',
        position: 'Main area — expandable repo sections',
        items: [
          { label: 'Repo header', detail: 'Shows repo name, open PR count, and a refresh button. Click to expand/collapse.' },
          { label: 'Refresh', detail: 'Re-fetches PRs, comments, and CI status for that repo. Also updates .colony/ templates from the repo.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'PR Cards',
        position: 'Inside expanded repo',
        items: [
          { label: 'PR row', detail: 'Shows title, author, branch, labels, and review status (approved/changes requested/pending).' },
          { label: 'Review Requested', detail: 'Amber badge appears when your review is requested on a PR.', icon: 'Eye' },
          { label: 'Feedback badge', detail: 'Shows Colony Feedback status: amber = feedback pending, green = new commits since review (ready for re-review).', icon: 'MessageSquare' },
          { label: 'CI badges', detail: 'Green/red/yellow dots for GitHub Actions check status. Click to see details and fetch failure logs.' },
          { label: 'Colony Review', detail: 'Launches a Claude session that reviews the code and pushes structured feedback to the colony-feedback branch.', icon: 'Play' },
          { label: 'Quick actions', detail: 'Buttons (Review, Summarize, Checkout & Test) launch a Claude session with the PR pre-loaded as context.' },
          { label: 'Comments', detail: 'Click to view all PR comments (general + file-level) in a split modal with markdown rendering.', icon: 'MessageSquare' },
        ],
      },
      {
        name: 'Filters & Search',
        position: 'Above PR list',
        items: [
          { label: 'Text search', detail: 'Search across PR titles, descriptions, and comments.', icon: 'Search' },
          { label: 'Filter chips', detail: 'Filter by status (open/draft), author, reviewer, or label. Multiple filters combine.', icon: 'Filter' },
        ],
      },
      {
        name: 'Ask Bar',
        position: 'Bottom of panel',
        items: [
          { label: 'Natural language questions', detail: 'Ask about your PRs (e.g., "Which PRs need my review?"). Launches a persistent PR Assistant session.' },
          { label: 'Global prompts', detail: 'Pre-built questions: My PRs, Needs Review, Stale PRs.' },
        ],
      },
    ],
  },

  tasks: {
    title: 'Task Queues',
    description: 'Define batches of prompts as YAML files and run them in a single Claude session. Use for code generation, analysis, or any repeatable multi-step workflow.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'New button', detail: 'Create a new task queue YAML file.', icon: 'Plus' },
        ],
      },
      {
        name: 'Queue List',
        position: 'Left sidebar',
        items: [
          { label: 'Queue files', detail: 'YAML files from ~/.claude-colony/task-queues/. Click to select and edit.' },
          { label: 'Status icons', detail: 'Shows if a queue is running, has errors, or is idle.' },
        ],
      },
      {
        name: 'Editor',
        position: 'Center — tabbed area',
        items: [
          { label: 'Config tab', detail: 'YAML editor for the task queue. Define name, mode (parallel/sequential), and task list with prompts.' },
          { label: 'Memory tab', detail: 'View/edit the queue\'s memory file. Learnings from past runs are auto-injected into prompts.' },
          { label: 'Outputs tab', detail: 'Browse past run results. Files organized by timestamp with preview and markdown rendering.' },
        ],
      },
      {
        name: 'Run Controls',
        position: 'Above editor',
        items: [
          { label: 'Play button', detail: 'Execute the queue. All tasks run in one session. Output goes to ~/.claude-colony/outputs/<queue>/<timestamp>/.', icon: 'Play' },
          { label: 'Convert to Pipeline', detail: 'Turn this queue into a scheduled pipeline with a cron expression.', icon: 'Zap' },
          { label: 'Task count', detail: 'Shows number of tasks and execution mode (parallel/sequential) parsed from the YAML.' },
        ],
      },
      {
        name: 'Ask Bar',
        position: 'Bottom',
        items: [
          { label: 'Task Assistant', detail: 'Ask Claude to help create or modify your task queue YAML.' },
        ],
      },
    ],
  },

  pipelines: {
    title: 'Pipelines',
    description: 'Reactive automation: define trigger → condition → action patterns. Pipelines poll on intervals and launch Claude sessions when conditions are met.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Reload button', detail: 'Re-read all pipeline YAML files from disk.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Pipeline List',
        position: 'Main area — expandable cards',
        items: [
          { label: 'Pipeline card', detail: 'Shows name, trigger type (git-poll/cron/file-poll), and enabled/disabled toggle.' },
          { label: 'Schedule badge', detail: 'Shows the current cron schedule as a human-readable label (e.g. "Weekdays 9am"). Click it to open the schedule editor with presets and next-run preview.', icon: 'Clock' },
          { label: 'Running indicator', detail: 'Pulsing amber dot when the pipeline is actively polling.' },
          { label: 'Error display', detail: 'Red block with error message if the last run failed.' },
          { label: 'Repo pipelines', detail: 'Pipelines from .colony/pipelines/ in tracked repos appear here (disabled by default).' },
        ],
      },
      {
        name: 'Pipeline Detail',
        position: 'Expanded card',
        items: [
          { label: 'YAML definition', detail: 'Trigger (when), conditions (if), and actions (then). Edit the file directly.' },
          { label: 'Cron expression', detail: 'e.g., "0 9-17 * * 1-5" for hourly during work hours on weekdays.' },
          { label: 'Session routing', detail: 'route-to-session finds existing sessions by branch, repo, PR, or name. Falls back to launching new.' },
          { label: 'Content-hash dedup', detail: 'Tracks Git SHA — only re-fires when matched file content actually changes.' },
          { label: 'Poll Now', detail: 'Run a full poll cycle immediately. Evaluates conditions and fires actions if matched. Use Preview first to check before committing.', icon: 'Play' },
          { label: 'Preview', detail: 'Dry-run the pipeline — evaluates trigger and conditions without firing any actions. Shows which PRs/contexts would match, resolved template variables, and whether dedup would suppress the fire.', icon: 'Eye' },
        ],
      },
      {
        name: 'Pipeline Resources',
        position: 'Tabs within expanded card',
        items: [
          { label: 'Memory', detail: 'Per-pipeline memory file. Sessions are told to append learnings here.' },
          { label: 'Outputs', detail: 'Configurable output directory for pipeline-generated files.' },
          { label: 'Docs', detail: 'Companion readme if <name>.readme.md exists alongside the pipeline.' },
        ],
      },
    ],
  },

  environments: {
    title: 'Environments',
    description: 'Template-based dev environments with managed services, automatic port allocation, and git worktree checkout. Each environment is an isolated workspace.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar with tabs',
        items: [
          { label: 'Instances tab', detail: 'Shows running and stopped environments. Click to expand and manage services.' },
          { label: 'Templates tab', detail: 'Browse and manage environment templates. Create new environments from templates.' },
          { label: 'Refresh button', detail: 'Re-fetches bare repos and re-scans for .colony/ templates (Templates tab only).', icon: 'RefreshCw' },
          { label: 'Import button', detail: 'Import a template from a JSON file.', icon: 'Upload' },
        ],
      },
      {
        name: 'Environment Cards',
        position: 'Main area — Instances tab',
        items: [
          { label: 'Status dot', detail: 'Green = all services running. Yellow = partial. Red = crashed. Gray = stopped.' },
          { label: 'Service dots', detail: 'Small colored dots for each service\'s individual status.' },
          { label: 'Start', detail: 'Launch all services in the environment.', icon: 'Play' },
          { label: 'Stop', detail: 'Halt all running services.', icon: 'Square' },
          { label: 'Terminal', detail: 'Open a Claude session in the environment directory.', icon: 'Terminal' },
          { label: 'Open Folder', detail: 'Open the environment directory in Finder.', icon: 'FolderOpen' },
          { label: 'Diagnose', detail: 'Launch Claude to diagnose and fix environment issues.', icon: 'Stethoscope' },
        ],
      },
      {
        name: 'Expanded Environment',
        position: 'Below card when expanded',
        items: [
          { label: 'Service list', detail: 'Each service row shows status, uptime, port, restart count, and start/stop/restart controls.' },
          { label: 'URLs section', detail: 'Clickable URLs for accessible service endpoints.' },
          { label: 'Auto-restart toggle', detail: 'When enabled, any crashed service in this environment is automatically restarted after 5 seconds. Off by default.' },
          { label: 'Ports section', detail: 'Allocated ports per service — unique across environments to avoid conflicts.' },
          { label: 'Paths section', detail: 'Root path, backend path, frontend path, etc. for the environment.' },
        ],
      },
      {
        name: 'Template Cards',
        position: 'Main area — Templates tab',
        items: [
          { label: 'Template info', detail: 'Name, description, project type, repo list, and service definitions.' },
          { label: 'Source badge', detail: 'Shows whether the template is user-defined or from a repo\'s .colony/ directory.' },
          { label: '+ New Environment', detail: 'Click to provision a new environment from this template. Repos are checked out as git worktrees.', icon: 'Plus' },
          { label: 'Edit', detail: 'Modify template in an AI-assisted editor session.', icon: 'Pencil' },
          { label: 'Delete', detail: 'Remove this template.', icon: 'Trash2' },
        ],
      },
    ],
  },

  settings: {
    title: 'Settings',
    description: 'Configure Colony\'s behavior, CLI defaults, and manage the background PTY daemon that owns all terminal sessions.',
    zones: [
      {
        name: 'CLI Section',
        position: 'Top section',
        items: [
          { label: 'Default arguments', detail: 'CLI args applied to every new session (e.g., --model claude-sonnet-4-5-20250514, --max-turns 10).' },
          { label: 'Default CLI backend', detail: 'Choose between Claude CLI or Cursor Agent as the default for new sessions.' },
          { label: 'Slash command sync', detail: 'Sync Claude CLI slash commands for use within Colony.' },
        ],
      },
      {
        name: 'Shell Section',
        position: 'Middle section',
        items: [
          { label: 'Shell profile', detail: 'Which shell to load PATH and environment from. Affects resolution of claude, gh, node, etc.' },
          { label: 'Available shells', detail: 'Reads from /etc/shells. Restart daemon after changing.' },
        ],
      },
      {
        name: 'Preferences Section',
        position: 'Middle section',
        items: [
          { label: 'Global hotkey', detail: 'Keyboard shortcut to summon Colony from any app (default: Ctrl+Shift+Space).' },
          { label: 'Sound on finish', detail: 'Play a sound when Claude finishes processing and the app isn\'t focused.' },
          { label: 'Auto-cleanup', detail: 'Remove stopped sessions after N minutes. Set to 0 to keep them forever.' },
        ],
      },
      {
        name: 'Daemon Section',
        position: 'Lower section',
        items: [
          { label: 'Version display', detail: 'Shows running daemon version vs expected. "Outdated" badge if mismatched.' },
          { label: 'Restart daemon', detail: 'Kills all running sessions and starts a fresh daemon. Required after shell changes.', icon: 'RotateCcw' },
        ],
      },
      {
        name: 'Logs Section',
        position: 'Bottom section',
        items: [
          { label: 'App logs', detail: 'View recent application log output for debugging.' },
          { label: 'Daemon logs', detail: 'View PTY daemon log output.' },
        ],
      },
    ],
  },

  personas: {
    title: 'Personas',
    description: 'Long-lived AI agents with identity, goals, and memory. Personas run periodically, assess the state of your workspace, and take autonomous action.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'New button', detail: 'Create a new persona from a blank template with a name.', icon: 'Plus' },
        ],
      },
      {
        name: 'Ask Bar',
        position: 'Below header',
        items: [
          { label: 'Persona Assistant', detail: 'Describe a persona and the assistant will create or modify the .md file for you. It knows the file format, section conventions, and permission scopes.', icon: 'MessageSquare' },
          { label: 'View button', detail: 'Focus the running Persona Assistant session to continue the conversation.' },
        ],
      },
      {
        name: 'Persona Cards',
        position: 'Main area',
        items: [
          { label: 'Status dot', detail: 'Green pulsing = running a session. Gray = idle. Dimmed = disabled.' },
          { label: 'Schedule', detail: 'Shows when the persona runs automatically as a human-readable label (e.g. "Every 2 hours"). Click to open the schedule editor with presets and next-run times.', icon: 'Clock' },
          { label: 'Run count', detail: 'How many sessions this persona has completed.' },
          { label: 'Run button', detail: 'Manually trigger a persona session now.', icon: 'Play' },
          { label: 'Stop button', detail: 'Stop the currently running persona session.', icon: 'Square' },
          { label: 'Enable/Disable', detail: 'Toggle scheduled runs on or off without deleting the persona.' },
          { label: 'Delete', detail: 'Remove the persona file.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Expanded Card',
        position: 'Below card when expanded',
        items: [
          { label: 'Role section', detail: 'The persona\'s identity and instructions (set by you, read-only to the persona).' },
          { label: 'Objectives', detail: 'What the persona is trying to achieve. You set these, the persona works toward them.' },
          { label: 'Active Situations', detail: 'Dynamic state managed by the persona — things it\'s tracking across sessions.' },
          { label: 'Learnings', detail: 'Facts and patterns the persona has discovered. It adds and prunes these itself.' },
          { label: 'Session Log', detail: 'Recent session summaries. Auto-pruned to the last 20 entries.' },
          { label: 'Permissions', detail: 'What the persona can and cannot do: push code, merge PRs, create sessions.' },
        ],
      },
    ],
  },

  // Per-session tabs
  sessionTab: {
    title: 'Session (Claude Terminal)',
    description: 'The main Claude CLI terminal. This is where you interact with Claude — type prompts, review responses, and watch it work in real time.',
    zones: [
      {
        name: 'Tab Bar',
        position: 'Top of terminal area',
        items: [
          { label: 'Session tab', detail: 'The Claude CLI terminal (this tab). Shows activity dot when Claude is processing.' },
          { label: 'Files tab', detail: 'Browse the working directory with file tree and content search.' },
          { label: 'Terminal tab', detail: 'A raw shell in the same directory for running commands alongside Claude.' },
          { label: 'Services tab', detail: 'Appears when an environment is attached. Manage services.' },
          { label: 'Logs tab', detail: 'Appears when an environment is attached. Stream service logs.' },
        ],
      },
      {
        name: 'Header Info',
        position: 'Right side of tab bar',
        items: [
          { label: 'Git branch badge', detail: 'Shows the current git branch and repo name.', icon: 'GitBranch' },
          { label: 'Info button', detail: 'Opens a popover with launch command, PID, working directory, MCP servers, token usage, and child processes.', icon: 'Info' },
          { label: 'Reset terminal', detail: 'Destroy the terminal and create a fresh one. On the Session tab, clears and re-replays the buffer. On the Shell tab, kills the shell and spawns a new one.', icon: 'RotateCcw' },
          { label: 'Spawn child', detail: 'Create a child session that reports back via a handoff document when done.', icon: 'GitFork' },
        ],
      },
      {
        name: 'Terminal',
        position: 'Main area',
        items: [
          { label: 'Full terminal', detail: 'xterm.js terminal rendering Claude CLI output. Supports search, zoom, and scroll preservation.' },
          { label: 'Drag & drop', detail: 'Drop files onto the terminal to paste their path.' },
          { label: 'Scroll behavior', detail: 'Reading history while output streams won\'t jump you to the bottom.' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+F', action: 'Search in terminal' },
      { keys: 'Cmd+=', action: 'Zoom in' },
      { keys: 'Cmd+-', action: 'Zoom out' },
      { keys: 'Cmd+0', action: 'Reset zoom' },
    ],
  },

  filesTab: {
    title: 'Files',
    description: 'Browse the session\'s working directory. Click files to paste their path into the Claude terminal, or preview them with syntax highlighting.',
    zones: [
      {
        name: 'Toolbar',
        position: 'Top of files area',
        items: [
          { label: 'Name filter', detail: 'Type to filter the file tree by name. Matching directories auto-expand.' },
          { label: 'Search icon', detail: 'Switch to content search mode — grep across all files in the project.', icon: 'Search' },
          { label: 'Open in Finder', detail: 'Open the working directory in macOS Finder.', icon: 'FolderOpen' },
          { label: 'Ignore rules', detail: 'Configure patterns to exclude from search (node_modules, .git, etc.).', icon: 'Settings' },
        ],
      },
      {
        name: 'File Tree',
        position: 'Left pane',
        items: [
          { label: 'Directory tree', detail: 'Lazy-loading tree with expand/collapse. Click a directory to expand it.' },
          { label: 'File click', detail: 'Clicking a file pastes its path into the terminal input.' },
          { label: 'File preview', detail: 'Files also appear in the right-side preview pane with line numbers.' },
        ],
      },
      {
        name: 'Preview Pane',
        position: 'Right pane',
        items: [
          { label: 'File content', detail: 'Shows file contents with line numbers. Supports Cmd+F to search within the file.' },
          { label: 'Search results', detail: 'When using content search, results appear grouped by directory. Click a match to preview.' },
        ],
      },
    ],
  },

  terminalTab: {
    title: 'Terminal (Shell)',
    description: 'A raw shell terminal in the session\'s working directory. Use it to run git commands, install packages, run tests, or any command-line task alongside Claude.',
    zones: [
      {
        name: 'Shell',
        position: 'Full area',
        items: [
          { label: 'Independent process', detail: 'This is a separate shell (bash/zsh), not the Claude CLI. It doesn\'t share state with the Claude session.' },
          { label: 'Same directory', detail: 'Opens in the same working directory as the Claude session.' },
          { label: 'Persistent', detail: 'The shell stays alive as long as the session exists. Switch tabs freely.' },
        ],
      },
    ],
  },

  servicesTab: {
    title: 'Services',
    description: 'Manage the environment\'s services attached to this session. Each service is an independent process (e.g., Django backend, React frontend, Redis).',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Environment name', detail: 'Shows which environment is attached and its overall status.' },
          { label: 'Start All', detail: 'Launch all services at once.', icon: 'Play' },
          { label: 'Stop All', detail: 'Halt all running services.', icon: 'Square' },
          { label: 'Open Folder', detail: 'Open the environment directory in Finder.', icon: 'FolderOpen' },
          { label: 'Fix/Diagnose', detail: 'Dropdown with options: auto-fix runs Claude to diagnose and fix issues, or manually diagnose in a new session.', icon: 'Stethoscope' },
        ],
      },
      {
        name: 'Service List',
        position: 'Main area',
        items: [
          { label: 'Service rows', detail: 'Each row shows: status dot, service name, uptime, restart count, and allocated port.' },
          { label: 'Start/Stop/Restart', detail: 'Per-service action buttons on the right side of each row.' },
          { label: 'URL badges', detail: 'Clickable URL badges at the top for services with accessible endpoints.' },
        ],
      },
      {
        name: 'Details',
        position: 'Below service list',
        items: [
          { label: 'Ports section', detail: 'All allocated ports listed by service name.' },
          { label: 'Paths section', detail: 'File system paths for each component (root, backend, frontend, etc.).' },
        ],
      },
    ],
  },

  logsTab: {
    title: 'Logs',
    description: 'Real-time streaming logs from all services in the attached environment. Useful for debugging service issues without switching to individual terminals.',
    zones: [
      {
        name: 'Filter Bar',
        position: 'Top bar',
        items: [
          { label: 'All button', detail: 'Show logs from all services (default).' },
          { label: 'Service buttons', detail: 'Click a service name to filter logs to just that service. Color dot shows service status.' },
          { label: 'Clear button', detail: 'Clears the log buffer.', icon: 'Trash2' },
          { label: 'Auto-scroll toggle', detail: 'Toggles auto-scroll. Scrolling up pauses it, scrolling to bottom resumes.', icon: 'ChevronDown' },
        ],
      },
      {
        name: 'Log Output',
        position: 'Main area',
        items: [
          { label: 'Log lines', detail: 'Each line shows the service name (left column) and the log text. Color-coded by service.' },
          { label: 'Buffer limit', detail: 'Keeps the last 2,000 lines to prevent memory issues.' },
          { label: 'Live streaming', detail: 'New output appears in real time as services write to stdout/stderr.' },
        ],
      },
    ],
  },
}
