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

export interface HelpEmptyState {
  /** Hook copy shown below the title (≤2 lines) */
  hook: string
  /** Aspirational keyboard badge (not functional) */
  keyCap?: string
  /** CTA label for the empty state action button */
  ctaLabel?: string
}

export interface HelpEntry {
  title: string
  description: string
  /** Flat items (legacy, used if no zones) */
  items?: HelpItem[]
  /** Zone-structured content — groups of items by visual region */
  zones?: HelpZone[]
  shortcuts?: Array<{ keys: string; action: string }>
  /** Empty state copy for the panel's zero-content view */
  emptyState?: HelpEmptyState
}

export const helpContent: Record<string, HelpEntry> = {
  overview: {
    title: 'Colony Overview',
    description: 'A command-center view of your colony — running sessions, active personas, pipeline status, pending items, and recent activity. Appears when no session is selected.',
    zones: [
      {
        name: 'Stats Bar',
        position: 'Top of panel',
        items: [
          { label: 'Running Sessions', detail: 'Count of live sessions. Click to jump to the sessions list.' },
          { label: 'Active Personas', detail: 'Personas currently executing a scheduled or manual run.' },
          { label: 'Pipelines Enabled', detail: 'Number of pipelines with automation turned on.' },
          { label: 'Session Cost', detail: 'Total cost across all current sessions.' },
        ],
      },
      {
        name: 'Needs Attention',
        position: 'Below stats (when applicable)',
        items: [
          { label: 'Pending approvals', detail: 'Pipeline approval gates waiting for your decision. Click to go to Pipelines.', icon: 'Zap' },
          { label: 'Pipeline errors', detail: 'Pipelines that encountered an error on their last run.', icon: 'AlertCircle' },
          { label: 'Blocked tasks', detail: 'Task board items marked as blocked.', icon: 'Circle' },
        ],
      },
      {
        name: 'Running Sessions',
        position: 'Middle',
        items: [
          { label: 'Session tile', detail: 'Click any session to focus it. Shows name, activity status (busy/idle), role tag, and cost.', icon: 'Play' },
        ],
      },
      {
        name: 'Recent Activity',
        position: 'Below running sessions',
        items: [
          { label: 'Source filter chips', detail: 'Filter events by source: All, Persona, Pipeline, or Env. Chips are toggles — click to select one.' },
          { label: 'Level filter chips', detail: 'Filter by severity: All, Info, Warn, or Error. Warn and Error chips show badge counts when events exist. Filters combine with source filter (AND).' },
          { label: 'Show more', detail: 'Expands from 20 events (default) to 50. The activity manager stores up to 100 events total.' },
          { label: 'Live updates', detail: 'New events from personas, pipelines, and environments appear at the top in real-time, respecting active filters.' },
        ],
      },
      {
        name: 'Quick Actions',
        position: 'Bottom',
        items: [
          { label: 'New Session', detail: 'Open the new session dialog.', icon: 'Plus' },
          { label: 'Run Persona', detail: 'Jump to the Personas panel.', icon: 'Users' },
          { label: 'Pipelines', detail: 'Jump to the Pipelines panel.', icon: 'Zap' },
          { label: 'Environments', detail: 'Jump to the Environments panel.', icon: 'FolderOpen' },
        ],
      },
      {
        name: 'Timeline Tab',
        position: 'Tab bar — "Timeline"',
        items: [
          { label: 'Session Timeline', detail: 'Gantt-style horizontal chart showing when sessions ran during the selected day. Each bar spans start → end, colored by session color. SVG bezier arrows connect parent→child sessions in trigger chains.' },
          { label: 'Dependency arrows', detail: 'Curved arrows connect parent sessions to child sessions they triggered. Hover any bar in a chain to highlight the entire chain and dim unrelated sessions.' },
          { label: 'Day navigation', detail: 'Use ← / → arrows to browse past days. "Today" button jumps back to the current day.' },
          { label: 'Summary strip', detail: 'Shows total sessions, compute time, cost, and commit count for the selected day.' },
          { label: '"Now" line', detail: 'Red dashed vertical line marking the current time (today only).' },
          { label: 'Running sessions', detail: 'Bars for running sessions pulse and extend to the current time, updating every 30 seconds.' },
          { label: 'Click to focus', detail: 'Click any session bar to focus that session in the sidebar (if still alive).' },
        ],
      },
    ],
  },
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
          { label: '+ New Session', detail: 'Opens a dialog to create a Claude CLI session. Set a name, color, working directory, and optional CLI args. Keyboard shortcut: Cmd+N.', icon: 'Plus' },
          { label: 'Plan first', detail: 'When a first prompt is set, toggle "Plan first" to make Claude outline its approach (files to modify, steps, risks) and wait for your approval before taking any action. Useful for complex tasks where you want to review the strategy before committing tokens. Works with both the dialog and session templates.', icon: 'ListChecks' },
          { label: 'Prompt history', detail: 'When the "First prompt" field is visible, a History button appears next to the label. Click it to see your last 20 session prompts with timestamps. Click an entry to fill the textarea. History is saved automatically on session creation and stored in localStorage.', icon: 'Clock' },
          { label: 'Restore banner', detail: 'After app restart, shows a button to restore sessions that were running when you last quit.', icon: 'RotateCcw' },
        ],
      },
      {
        name: 'Empty State',
        position: 'Main panel when no sessions exist',
        items: [
          { label: 'Starter prompt cards', detail: 'New to Colony? The empty Sessions panel shows 4 starter cards — click one to launch a session with a seed prompt pre-filled against your current working directory. Cards: Explore (codebase tour), Propose a refactor (low-risk diff), Fix a small bug (PR from recent history), Start blank (opens a blank New Session dialog).', icon: 'Search' },
          { label: 'Working directory chip', detail: 'The header shows the folder the card will open Claude in. Click "Change directory" to pick a different folder before launching. If no directory is set, the cards are disabled and the page shows a "Choose folder…" CTA — pick a folder once and the cards light up.', icon: 'FolderOpen' },
          { label: 'First prompt editor', detail: 'Clicking a card opens the New Session dialog with a "First prompt" textarea pre-filled with the card\'s seed text. Edit it if you want, then press Create — the prompt runs automatically the moment the session is ready.' },
          { label: 'Blank start', detail: 'The "Start blank" card opens the dialog with an empty prompt field if you just want a fresh session without a seed task.', icon: 'TerminalSquare' },
        ],
      },
      {
        name: 'Session List',
        position: 'Main area',
        items: [
          { label: 'Active sessions', detail: 'Pulsing dot = Claude is working. Solid dot = waiting for input. Click to open.' },
          { label: 'Sort & filter', detail: 'Below the search bar: sort by Recent (default), Most Messages, or Name A-Z. Filter by project to narrow to a specific repo. Active project filter shows in the History header. Filter state persists across restarts.' },
          { label: 'Stopped sessions', detail: 'Dimmed with exit code. Auto-cleaned after 5 minutes (configurable in Settings). "Clear all" appears on the Stopped divider when 2+ sessions are stopped.' },
          { label: 'Session notes', detail: 'Right-click a session → Add Note to annotate it with freeform text (e.g., "waiting for CI", "investigating auth bug"). Notes appear as an italic subtitle under the session name. Edit or clear via the same menu. Max 500 characters.' },
          { label: 'Pin to top', detail: 'Right-click a session to pin it. Pinned sessions stay at the top and are restored on launch.', icon: 'Pin' },
          { label: 'Export Handoff Doc', detail: 'Generates a markdown snapshot of the session — git commits, terminal output, metadata — ready to paste into a new session to restore context. Click "✨ Generate Summary" inside the dialog to replace the raw terminal snapshot with an AI-generated 3–5 sentence summary.', icon: 'FileDown' },
          { label: 'Clone session', detail: 'Right-click a session → Clone to create a new session pre-filled with the same name, working directory, color, CLI backend, permission mode, MCP servers, and extra args. The name gets a "(2)" suffix. Useful for re-running a task with tweaks or retrying a failed approach.', icon: 'Copy' },
          { label: 'Export to Markdown', detail: 'Right-click a session → Export Markdown copies a structured markdown summary to clipboard (name, date, duration, cost, branch, prompt, commits, and per-file diffs). Hold Shift+click to save as a .md file instead. Works for both running and completed sessions.', icon: 'FileDown' },
          { label: 'Session Templates', detail: 'Save and reuse session configurations. Right-click a session → Save as Template to save the name, working directory, and role. The New Session button shows a template picker when templates exist. Manage templates in Settings → Session Templates.', icon: 'BookTemplate' },
          { label: 'Context budget badge', detail: 'Amber "ctx" badge when a session has generated significant output (context building up). Red when near the limit. Click to open the Handoff Doc export to capture a snapshot before the session reaches its context limit.' },
          { label: 'File conflict badge', detail: 'Amber warning badge with file count appears when another running session in the same directory and branch has uncommitted changes to the same file(s). Hover to see which files overlap and which sessions they conflict with. Checked every 30 seconds. Disappears when the overlap resolves (session exits or files are committed).', icon: 'AlertTriangle' },
          { label: 'Role badge', detail: 'Purple/gold tag (Orchestrator, Planner, Coder, Tester, Reviewer, Researcher, Coordinator, Worker) set via right-click. Coordinator shows a gold Crown icon 👑. Helps coordinate multi-agent workflows at a glance. Coordinator sessions display a Team tab showing all active Worker sessions.' },
          { label: 'Split/Grid indicator', detail: 'A columns icon appears on sessions in a split view or grid view. In grid mode, all assigned panes show the indicator.', icon: 'Columns2' },
          { label: 'Group by', detail: 'When 3+ sessions exist, a grouping selector appears above the list. Group by Persona, Project (working directory), or Status. Groups are collapsible and the mode persists across sessions.', icon: 'Layers' },
          { label: 'Multi-select', detail: 'Click the checkbox icon (next to group-by) or Cmd+click any session to enter select mode. A floating action bar appears for bulk Stop, Restart, or Remove. Cmd+A selects all visible sessions; Escape exits. Remove only affects stopped sessions.', icon: 'CheckSquare' },
          { label: 'Permission mode', detail: 'Choose Autonomous (default — full permissions) or Supervised (Claude asks before risky actions) when creating a session. Supervised sessions show a shield icon in the sidebar.', icon: 'Shield' },
          { label: 'Global Search', detail: 'Search across all sessions\' terminal output. Find which session produced an error or output. Opens a side panel with results grouped by session.', shortcut: '\u2318\u21e7F', icon: 'Search' },
          { label: 'Shortcut numbers', detail: 'Numbers 1-9 shown next to sessions for quick Cmd+N jumping.' },
          { label: 'Trigger chain', detail: 'Click the info icon on a session that has a parent or children to see its full trigger chain — the tree of sessions that spawned from the same root. Click any node to navigate to that session. Useful for tracing persona orchestration chains.', icon: 'Info' },
          { label: 'Repo Memory', detail: 'Place a `.colony/memory.md` file in a repo to automatically inject its conventions, architecture decisions, and team notes into every Colony session started in that directory. Same pattern as AGENTS.md — no UI needed.' },
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
        name: 'Fork Groups',
        position: 'Above session list (when active forks exist)',
        items: [
          { label: 'Fork button', detail: 'Click the GitFork button in the session header (or right-click a session tile and choose "Fork session…") to open the Fork modal. Creates parallel git worktrees, each with its own Claude session exploring a different approach.', icon: 'GitFork' },
          { label: 'Fork modal', detail: 'Set a group label, edit the task summary (pre-populated from terminal output), then configure up to 3 forks — each with a label and directive sent to Claude. Click "Launch Forks" to create the worktrees and sessions.' },
          { label: 'Pick Winner action', detail: 'When a fork produces the best result, click "Pick" (trophy icon). Losing worktrees are removed, context files are cleaned up, and the parent session receives a whisper to continue.', icon: 'Trophy' },
          { label: 'Discard action', detail: 'Remove an individual fork (e.g. if it crashes or goes off-track) without affecting the rest of the group.', icon: 'Trash2' },
          { label: 'Auto-close', detail: 'When all forks in a group are resolved or discarded, the group is automatically removed from the sidebar.' },
        ],
      },
      {
        name: 'Context Window',
        position: 'Session status strip (top of session view when running)',
        items: [
          { label: 'Context meter', detail: 'Shows estimated token usage as a percentage of your model\'s context window (e.g., "42%"). Green when below 80%, amber 80–95%, red above 95%.' },
          { label: 'Tooltip', detail: 'Hover the meter to see a breakdown: total tokens, system prompt, conversation history, handoff artifacts, and other tracked data.' },
          { label: 'Token estimate', detail: 'Uses a fast approximation (1 token ≈ 4 characters) for performance. Real token counts via Claude API are more accurate but expensive. This estimate is a guide, not a contract.' },
          { label: 'When to take action', detail: 'At 80% (amber), consider exporting a handoff doc or starting a fresh session to avoid context truncation. At 95% (red), the model is operating near its limit — quality may degrade.' },
          { label: 'Token tracking', detail: 'System prompt is fixed at session create. History grows with each message. Artifacts (handoff outputs) also accumulate. Reload the page or start a fresh session to reset.' },
        ],
      },
      {
        name: 'Footer',
        position: 'Bottom of sidebar',
        items: [
          { label: 'Help icon', detail: 'Opens this help popover.', icon: 'HelpCircle' },
          { label: 'Activity bell', detail: 'Shows recent automation events from personas, pipelines, and environments. Persona completion events include outcome stats: duration, commits made, and files changed. Turns amber when pipeline actions are waiting for approval.', icon: 'Bell' },
          { label: 'Notification history', detail: 'Persistent log of all desktop notifications — what happened while you were away. Grouped by Today/Yesterday/Older. Click an entry to navigate to its source (pipeline, persona, session). Red badge shows unread count. Persists across app restarts.', icon: 'BellRing' },
          { label: 'Workspace presets', detail: 'Save and restore workspace layouts (sidebar view, layout mode, sidebar width). Ships with 3 built-in presets: Monitor, Review, Compare. Cmd+Shift+1-5 for quick-switch.', icon: 'LayoutGrid' },
          { label: 'Settings gear', detail: 'Opens the Settings panel for CLI defaults, shell profile, daemon management, and more.', icon: 'Settings' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+N', action: 'Open New Session dialog from anywhere' },
      { keys: 'Cmd+T', action: 'New session' },
      { keys: 'Cmd+W', action: 'Kill/remove active session' },
      { keys: 'Cmd+1–9', action: 'Jump to session by position' },
      { keys: 'Alt+Tab', action: 'Cycle through sessions' },
      { keys: 'Cmd+\\', action: 'Toggle split view' },
      { keys: 'Cmd+Shift+F', action: 'Global Search — search across all sessions\' terminal output' },
      { keys: 'Cmd+K', action: 'Command palette — switch sessions, run personas, launch agents, navigate panels, search session history' },
      { keys: 'Cmd+Shift+↵', action: 'Quick Prompt — launch a new session with a prompt pre-filled; ↑↓ to cycle history' },
      { keys: 'Cmd+Shift+1–5', action: 'Load workspace preset by position' },
      { keys: 'Cmd+Click', action: 'Enter multi-select mode and toggle session' },
      { keys: 'Cmd+A', action: 'Select all visible sessions (in select mode)' },
      { keys: 'Escape', action: 'Exit multi-select mode' },
      { keys: 'Cmd+/', action: 'Show all keyboard shortcuts' },
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
    emptyState: {
      hook: 'No agents yet. They encapsulate a specific task with its own instructions.',
      keyCap: 'A',
      ctaLabel: 'Create Agent',
    },
  },

  github: {
    title: 'GitHub',
    description: 'Monitor and act on open PRs and issues across your GitHub repositories. Requires the gh CLI to be installed and authenticated.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Back arrow', detail: 'Return to the Sessions view.', icon: 'ArrowLeft' },
          { label: 'Pull Requests / Issues tabs', detail: 'Switch between Pull Requests and Issues views.' },
          { label: 'Memory button', detail: 'Open the PR Memory file — a persistent knowledge base that Claude sessions read and write to across conversations. (PRs tab only)', icon: 'Brain' },
          { label: 'Context button', detail: 'View the auto-generated PR context file that CLI sessions reference. (PRs tab only)', icon: 'FileText' },
          { label: 'Prompts button', detail: 'Edit quick-action templates (Review, Summarize, etc.) and global prompt questions. (PRs tab only)', icon: 'Pencil' },
          { label: 'New Issue button', detail: 'Create a new issue on a tracked repository with title, description, and labels. (Issues tab only)', icon: 'Plus' },
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
          { label: 'Needs Your Attention', detail: 'Pinned section showing PRs where your review is requested, you are assigned, or your PR has failing CI. Click a row to jump to that PR. Quick action chips below let you summarize status, fix failing CI, or draft review notes in one click.', icon: 'AlertCircle' },
          { label: 'PR row', detail: 'Shows title, author, branch, labels, and review status (approved/changes requested/pending). Age badge (Xd) turns amber after 4 days, red after 7.' },
          { label: 'Ready / Blocked badges', detail: '"Ready" (green) means approved + all checks passed. "Blocked" (red) means changes were requested.' },
          { label: 'Review Requested', detail: 'Amber badge appears when your review is requested on a PR.', icon: 'Eye' },
          { label: 'Feedback badge', detail: 'Shows Colony Feedback status: amber = feedback pending, green = new commits since review (ready for re-review).', icon: 'MessageSquare' },
          { label: 'CI badges', detail: 'Green/red/yellow dots for GitHub Actions check status. Click to see details and fetch failure logs.' },
          { label: 'Dispatch button', detail: 'Send this PR as a note to a persona. Pick a persona and add optional context — the note appears in the persona\'s ## Notes section on its next run.', icon: 'UserPlus' },
          { label: 'Colony Review', detail: 'Launches a Claude session that reviews the code and pushes structured feedback to the colony-feedback branch.', icon: 'Play' },
          { label: 'Quick actions', detail: 'Buttons (Review, Summarize, Checkout & Test). Click any button to open the environment selector modal.', icon: 'Play' },
          { label: 'Comments', detail: 'Click to view all PR comments (general + file-level) in a split modal with markdown rendering.', icon: 'MessageSquare' },
        ],
      },
      {
        name: 'Prompt Actions',
        position: 'Environment selector modal',
        items: [
          { label: 'Create new environment', detail: 'Set up a fresh instance with all dependencies. Takes 30–60s to initialize. Default option.' },
          { label: 'Reuse existing', detail: 'Send the prompt to an already-running instance. Shows instance name, status, age, and cost. Choose this if you\'re testing multiple PRs in the same environment.' },
          { label: 'Instance dropdown', detail: 'Lists running instances only. Each entry shows the session name, status, how long it\'s been running, and its current cost (if available).' },
          { label: 'Cancel', detail: 'Close the modal without launching anything.' },
          { label: 'Next', detail: 'Proceed with your selection. For new environments, the session starts in a "building" state. For reuse, the prompt is queued immediately.' },
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
        position: 'Bottom of panel (PRs tab)',
        items: [
          { label: 'Natural language questions', detail: 'Ask about your PRs (e.g., "Which PRs need my review?"). Launches a persistent PR Assistant session.' },
          { label: 'Global prompts', detail: 'Pre-built questions: My PRs, Needs Review, Stale PRs.' },
          { label: 'File drag & drop', detail: 'Drag files from Finder onto the ask bar to append their absolute paths to your message. The bar highlights with a dashed border on hover.' },
        ],
      },
      {
        name: 'Issues',
        position: 'Issues tab — expandable repo sections',
        items: [
          { label: 'Issue list', detail: 'Shows open issues per repo with title, author, assignees, comment count, and age badge. Click to expand and see the full description.' },
          { label: 'Label badges', detail: 'Priority labels (P0, P1) appear in red. Persona labels (persona:*) appear in green. Other labels use the default style.' },
          { label: 'Search & filter', detail: 'Text search across titles and bodies. Label chip filters narrow by label.', icon: 'Search' },
          { label: 'New Issue', detail: 'Create an issue from the header button. Pick a repo, set title/description/labels, and submit directly.', icon: 'Plus' },
          { label: 'Open in GitHub', detail: 'Click the link in the expanded issue detail to view the full issue on GitHub.', icon: 'ExternalLink' },
        ],
      },
    ],
    emptyState: {
      hook: 'No repos connected. Track pull requests and issues from your GitHub repositories.',
      keyCap: 'G',
      ctaLabel: 'Add Repository',
    },
  },

  tasks: {
    title: 'Task Queues',
    description: 'Define batches of prompts as YAML files and run them in a single Claude session. Use for code generation, analysis, or any repeatable multi-step workflow.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'List/card toggle', detail: 'Switch between compact list rows and card view. Preference is saved per device.', icon: 'LayoutList' },
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
          { label: 'File drag & drop', detail: 'Drag files from Finder onto the ask bar to append their absolute paths to your message.' },
        ],
      },
      {
        name: 'Batch Execution',
        position: 'Batch tab (if enabled)',
        items: [
          { label: 'Batch Mode', detail: 'Toggle batch execution ON/OFF. When enabled, tasks from your queue are executed on schedule automatically. Default: OFF.' },
          { label: 'Schedule', detail: 'Cron expression for when to run the batch (e.g. "0 2 * * *" = every night at 2am). Uses standard 5-field cron format.' },
          { label: 'Concurrency', detail: 'Number of tasks to run in parallel: 1 (sequential, default) to 5 (max parallel). Higher concurrency runs more tasks at once but may use more resources.' },
          { label: 'Timeout per task', detail: 'Maximum time (in minutes) to wait for each task before killing it and moving to the next. Default: 30 minutes.' },
          { label: 'On Completion', detail: 'Action after all tasks finish: nothing (silent), report (email summary), or commit (git add + commit if all succeeded).' },
          { label: 'Report Recipients', detail: 'Email addresses (comma-separated) to send the batch completion report to. Only used if "on completion" action is set to "report".' },
          { label: 'Run Now', detail: 'Trigger the batch immediately without waiting for the schedule. Useful for testing or emergency runs.' },
          { label: 'History tab', detail: 'View past batch runs with summary (# completed, # failed, total cost, duration). Click on a run to see detailed task breakdown and logs.' },
        ],
      },
    ],
    emptyState: {
      hook: 'No task queues yet. Batch work for a persona to process. (beta)',
      keyCap: 'K',
      ctaLabel: 'New Queue',
    },
  },

  pipelines: {
    title: 'Pipelines',
    description: 'Reactive automation: define trigger → condition → action patterns. Pipelines poll on intervals and launch Claude sessions when conditions are met.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'New Automation', detail: 'Open a 3-step wizard to create an automation without writing YAML. Pick a trigger (GitHub PR opened/merged, cron, or git push), configure an action (launch a session with a prompt), review the generated YAML, and confirm. The pipeline file is written to ~/.claude-colony/pipelines/ and picked up within 15s.', icon: 'Wand2' },
          { label: 'AI Generate', detail: 'Describe what you want the pipeline to do in plain English (e.g. "Run every night: check npm outdated and write a summary"). Claude Haiku generates a complete pipeline YAML with trigger, condition, and action stages pre-configured. Review and edit before saving.', icon: 'Sparkles' },
          { label: 'List/card toggle', detail: 'Switch between compact list rows and card view. Preference is saved per device.', icon: 'LayoutList' },
          { label: 'Reload button', detail: 'Re-read all pipeline YAML files from disk.', icon: 'RefreshCw' },
          { label: 'Audit button', detail: 'Run an AI audit of all pipelines. Claude reviews each pipeline\'s YAML, error history, and configuration and returns a list of HIGH/MEDIUM/LOW findings. Each finding with a clear fix has a Fix button that opens the editor or applies the fix directly. Badge shows issue count from the last audit.', icon: 'ShieldCheck' },
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
          { label: 'Approval gate', detail: 'Add requireApproval: true to a pipeline YAML to require human approval before it fires. Matched actions queue in the Activity bell — you approve or dismiss from there. Approvals auto-expire after 24h by default; set approvalTtl (hours) in the pipeline YAML to override.' },
          { label: 'Stage Handoff', detail: 'Inject structured context from a prior pipeline stage. Add handoffInputs: [name] to a pipeline action and list artifact names (from ~/.claude-colony/artifacts/<name>.txt). The content is wrapped in a framing block instructing the agent to respect prior decisions and focus constraints. Injected before artifactInputs so context precedes raw data.' },
          { label: 'Diff Review stage', detail: 'Add type: diff_review to a pipeline action to automatically review a git diff before proceeding. Runs git diff <diff_base> (default: HEAD~1) in workingDirectory, injects the diff into the prompt, and dispatches to a reviewer session. Replies containing APPROVED or LGTM pass immediately; otherwise an approval gate is created with the review text. Set auto_fix: true to launch a fixer session on failure and retry (up to autoFixMaxIterations, default 2). Diffs larger than 8KB are truncated.' },
          { label: 'Parallel Fan-Out stage', detail: 'Add type: parallel with a stages: list to dispatch multiple sub-actions simultaneously. All sub-stages run concurrently (Promise.all). Set fail_fast: false to run all stages regardless of failures (default: true, abort on first failure). The History tab shows parallel groups as indented sub-stage rows. Nested parallel stages are not supported.' },
          { label: 'Plan stage', detail: 'Add type: plan to require an agent to produce an implementation plan before the pipeline proceeds. The planning session writes its plan to a file, then an approval gate appears ("Approve plan to proceed?"). Approve to continue (plan is injected into the next stage via handoffInputs), Reject to stop the run. Set require_approval: false for fully automated pipelines — plan is logged but pipeline continues without a gate. Override the completion keyword with plan_keyword (default: PLAN_READY). The plan is saved as an artifact in ~/.claude-colony/artifacts/ for next stages to consume.', icon: 'FileText' },
          { label: 'Wait for Session stage', detail: 'Add type: wait_for_session with session_name: "My Session" to block the pipeline until a named session exits. Polls every 5s. Tolerate "not found" for 30s after the stage starts (session may not have launched yet). Set timeout_minutes (default: 30) to control the max wait. Transient daemon disconnects are ignored. Set artifact_output: name to write the session exit reason to ~/.claude-colony/artifacts/<name>.txt — useful for feeding results into subsequent stages via handoffInputs.', icon: 'Hourglass' },
          { label: 'Best-of-N stage', detail: 'Add type: best-of-n to spawn N sessions in separate worktrees with the same prompt, then auto-judge which output is best. Set n (2-8, default 3), repo: {owner, name}, branch (default main), and judge: {type: command|llm, cmd or prompt}. Command judge runs a shell command (e.g. npm test) in each worktree — winner is the first clean exit. LLM judge launches a session that evaluates all outputs and responds with WINNER: <slot>. Optional models: array for per-slot model overrides. Winner worktree is preserved (keep_winner: true by default); losers cleaned up. Results recorded in arena-stats.json for the Arena Leaderboard.', icon: 'Trophy' },
          { label: 'Stage model override', detail: 'Add model: claude-opus-4-6 (or claude-sonnet-4-6 / claude-haiku-4-5) to any stage to run that step on a specific model tier. Frontier reasoning for planning → opus; cheap + fast boilerplate → haiku. The model tag (· haiku) appears in the History tab. Blank/missing model uses the CLI default.' },
          { label: 'Webhook trigger', detail: 'Add trigger: {type: webhook, source: github|generic, secret: mytoken} to fire the pipeline when a POST arrives at /webhook/<slug>. The slug is the pipeline name lowercased with spaces replaced by hyphens. Colony validates the signature before firing.', icon: 'Globe' },
          { label: 'GitHub webhooks', detail: 'Set up a GitHub webhook pointing to http://localhost:7474/webhook/<slug> with the same secret as in the YAML. Colony verifies the X-Hub-Signature-256 header (HMAC-SHA256 of the request body). External tools like ngrok can expose the local server.' },
          { label: 'Webhook template variables', detail: '{{pr_title}}, {{pr_url}}, {{pr_number}}, {{sender}} are extracted from GitHub webhook payloads. {{webhook_payload}} contains the full JSON payload. These can be used in the action prompt.' },
        ],
      },
      {
        name: 'Pipeline Resources',
        position: 'Tabs within expanded card',
        items: [
          { label: 'Flow', detail: 'SVG node graph of the pipeline structure. Shows trigger → action → sub-stages as connected nodes. Parallel actions fork and rejoin via diamond nodes. Nodes are color-coded by last-run status: green (success), red (failure), gray (no data). Active stages pulse when the pipeline is running.', icon: 'GitBranch' },
          { label: 'Memory', detail: 'Per-pipeline memory file. Sessions are told to append learnings here.' },
          { label: 'Outputs', detail: 'Configurable output directory for pipeline-generated files.' },
          { label: 'History', detail: 'Ring buffer of the last 20 poll runs: timestamp, trigger type, whether an action fired, success/failure, and duration. Click rows with a chevron (▶) to expand per-stage details — stage type, session name, reviewer response snippet (diff_review stages), individual duration, and a △ badge on any stage whose status changed from the prior run.', icon: 'Clock' },
          { label: 'Docs', detail: 'Companion readme if <name>.readme.md exists alongside the pipeline.' },
        ],
      },
      {
        name: 'Ask Bar',
        position: 'Below description',
        items: [
          { label: 'Pipeline Assistant', detail: 'Ask Claude to create or modify a pipeline YAML. Describe the trigger and action in plain English.', icon: 'MessageSquare' },
          { label: 'File drag & drop', detail: 'Drag files from Finder onto the ask bar to append their absolute paths to your message.' },
        ],
      },
    ],
    shortcuts: [],
    emptyState: {
      hook: 'No pipelines yet. Automate recurring work with triggers and handoffs.',
      keyCap: 'L',
      ctaLabel: 'New Pipeline',
    },
  },

  environments: {
    title: 'Environments',
    description: 'Template-based dev environments with managed services, automatic port allocation, and git worktree checkout. Each environment is an isolated workspace.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar with tabs',
        items: [
          { label: 'Environments tab', detail: 'Shows running and stopped environments. Click a card to expand and manage services.' },
          { label: 'Templates tab', detail: 'Browse and manage environment templates. Create new environments from templates.' },
          { label: 'Tab navigation', detail: 'Cmd+Shift+{ / Cmd+Shift+} cycles between the Environments and Templates tabs without touching the mouse.' },
          { label: 'Refresh button', detail: 'Re-fetches bare repos and re-scans for .colony/ templates (Templates tab only).', icon: 'RefreshCw' },
          { label: 'Import button', detail: 'Import a template from a JSON file.', icon: 'Upload' },
        ],
      },
      {
        name: 'Health Summary',
        position: 'Top of Environments tab',
        items: [
          { label: 'Status badges', detail: 'Running, stopped, partial counts plus total services. Crashed badge appears when any service is down.' },
          { label: 'Port conflict warning', detail: 'Amber badge when two environments claim the same port. Hover to see which environments and services conflict.', icon: 'AlertTriangle' },
          { label: 'Compact grid', detail: 'Each tile is one environment — status dot, name, and service health dots. Click to expand that environment. Active tile highlighted in blue.' },
          { label: 'Purpose filters', detail: 'Filter environments by tag: interactive, background, or nightly. Click again to clear.' },
        ],
      },
      {
        name: 'Environment Cards',
        position: 'Main area — Environments tab',
        items: [
          { label: 'Status dot', detail: 'Green = all services running. Yellow = partial. Red = crashed. Gray = stopped.' },
          { label: 'Service dots', detail: 'Colored dot + service name for each service. Dot color shows status: green = running, red = crashed, gray = stopped. Hover for port and restart info.' },
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
          { label: 'Purpose tag', detail: 'Tag an environment as interactive (sprint work), background (parallel tasks), or nightly (overnight batch jobs). Shows as a colored badge on the card. Optional — helps you filter and understand at a glance what each environment is for.' },
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
          { label: 'Launch', detail: 'Provision a new environment from this template. Repos are checked out as git worktrees.', icon: 'Play' },
          { label: 'Edit', detail: 'Modify template in an AI-assisted editor session.', icon: 'Pencil' },
          { label: 'Delete', detail: 'Remove this template.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Launch Gate',
        position: 'Shown after clicking + New Environment — progress view before session opens',
        items: [
          { label: 'Ready gate', detail: 'Colony waits until ALL required services transition to running before spawning the Claude session. You won\'t see errors from a half-initialized env.' },
          { label: 'Live service rows', detail: 'Each row shows a service name and live status (starting / running / crashed / stopped). Updates every 2 seconds while the env boots.' },
          { label: 'Auto-heal on crash', detail: 'If any required service crashes during startup, Colony still opens the session — but prefixes the first message with the failed service name, last 50 log lines, and a directive to investigate. The Claude session lands pre-briefed to fix the env.' },
          { label: 'Timeout fallback', detail: 'If nothing resolves within 5 minutes, Colony spawns the session anyway so you\'re not stuck waiting. The timed-out env may still need manual intervention.' },
          { label: 'Cancel button', detail: 'Drops the pending launch. Does NOT tear down the environment — it keeps running in the background. You can re-launch a session from the Environments tab once services are up.' },
          { label: 'Optional services', detail: 'mcp-server crashes do not trigger auto-heal — it\'s treated as optional to match the env-daemon tolerance.' },
        ],
      },
      {
        name: 'Hook Prompts',
        position: 'Modal — shown during environment setup when a hook needs user input',
        items: [
          { label: 'File prompts', detail: 'If a default file path exists and is valid, press Enter or click "Use this file" to accept it. Click "Browse…" to pick a different file. Press Escape or click "Skip" to cancel.' },
          { label: 'Select prompts', detail: 'Choose from a list of options generated by the hook\'s optionsCommand. Click an option to select it, or "Skip" to cancel.' },
          { label: 'Hook execution order', detail: 'Hooks run in the exact order they appear in the template YAML/JSON — not alphabetically. Use an array (dash-list) in YAML to guarantee ordering.' },
        ],
      },
    ],
    emptyState: {
      hook: 'No environments yet. A sandboxed stack — backend + frontend + workers.',
      keyCap: 'E',
      ctaLabel: 'New Environment',
    },
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
        name: 'General Section',
        position: 'Below Shell section',
        items: [
          { label: 'Keep running in tray when closed', detail: 'Colony continues running pipelines and persona schedules when the window is closed. Access via the menu bar icon. Disable to quit on window close.' },
        ],
      },
      {
        name: 'Preferences Section',
        position: 'Middle section',
        items: [
          { label: 'Global hotkey', detail: 'Keyboard shortcut to summon Colony from any app (default: Ctrl+Shift+Space).' },
          { label: 'Desktop notifications', detail: 'Show system notifications for pipeline fires, approval gates, and persona run start/complete events.' },
          { label: 'Sound on finish', detail: 'Play a sound when Claude finishes processing and the app isn\'t focused.' },
          { label: 'Auto-cleanup', detail: 'Remove stopped sessions after N minutes. Set to 0 to keep them forever.' },
        ],
      },
      {
        name: 'MCP Catalog Section',
        position: 'Lower-middle section',
        items: [
          { label: 'MCP Server Catalog', detail: 'Define named MCP servers (stdio command or SSE URL). Reference them by name in pipeline YAML (mcpServers: ["name"]) or when creating sessions. Colony writes a --mcp-config temp file and passes it to the Claude CLI.', icon: 'Network' },
          { label: 'Add Server', detail: 'Choose command (stdio) or SSE type. For command servers, enter the executable and arguments. Arguments support quoted strings with spaces (e.g. "-y @mcp/fs \"/path with spaces\"") and environment variables (e.g. "$HOME", "${VAR}"). Example: npx -y @modelcontextprotocol/server-filesystem $HOME/data', icon: 'Plus' },
          { label: 'Environment Variables', detail: 'Set custom environment variables (KEY=value pairs) that will be available when the MCP server runs. Variables are merged with system environment; custom values take precedence. Example: API_KEY=secret, PORT=3000. Variables can be referenced in args using $VAR or ${VAR} syntax.', icon: 'Box' },
        ],
      },
      {
        name: 'MCP Audit Section',
        position: 'Below MCP Catalog',
        items: [
          { label: 'MCP Audit', detail: 'Persistent log of MCP tool call approval events. Shows the last 100 entries with timestamp, session name, MCP server, tool name, and outcome (approved / denied / auto). Stored in ~/.claude-colony/mcp-audit.json.', icon: 'ClipboardList' },
          { label: 'Clear button', detail: 'Delete all entries from the audit log. The log is automatically trimmed to the last 500 entries to prevent unbounded growth.' },
        ],
      },
      {
        name: 'Commit Attribution Section',
        position: 'Below MCP Audit',
        items: [
          { label: 'Commit Attribution', detail: 'Links git commits to the Colony session that made them. When any session exits, Colony scans the working directory for commits made since the session started and records them in ~/.claude-colony/commit-attribution.json. Shows hash, message, and session name.', icon: 'GitCommit' },
          { label: 'Clear button', detail: 'Delete all attribution records. The log is automatically capped at 200 entries.' },
        ],
      },
      {
        name: 'Daemon Section',
        position: 'Lower section',
        items: [
          { label: 'Version display', detail: 'Shows running daemon version vs expected. "Outdated" badge if mismatched.' },
          { label: 'Restart daemon', detail: 'Kills all running sessions and starts a fresh daemon. Required after shell changes.', icon: 'RotateCcw' },
          { label: 'Connection failed banner', detail: 'A red banner appears if the daemon fails to connect after 3 retry attempts. Click Retry to re-attempt the connection, or Dismiss to hide the banner. Sessions and environments are unavailable until the daemon connects.' },
        ],
      },
      {
        name: 'Updates',
        position: 'Below Approval Rules / above Batch Execution',
        items: [
          { label: 'Updates section', detail: 'Colony checks GitHub releases for new versions once a day (and once 10 seconds after app start). Packaged builds only — development builds skip update checks entirely.', icon: 'DownloadCloud' },
          { label: 'Current Version', detail: 'The app version you are running right now. Same value shown in the About dialog.' },
          { label: 'Last Checked', detail: 'Relative timestamp of the most recent successful update check. Persisted across app restarts.' },
          { label: 'Status', detail: 'Live state: "Up to date" (green), "Update available" (blue), "Downloading…" with %, "Update ready" (green), or an error (red). Errors from missing releases are treated as "up to date" so fresh repos do not flap.' },
          { label: 'Automatically check for updates daily', detail: 'Toggle the daily check on or off. Disabling stops the timer; you can still use "Check for updates now" to run a manual check whenever you want.' },
          { label: 'Check for updates now', detail: 'Force an immediate check. Useful if you want to pick up a release before the next daily tick.', icon: 'RefreshCw' },
          { label: 'Download Update', detail: 'Appears when an update is available. Downloads the release in the background without interrupting your session.' },
          { label: 'Install & Restart', detail: 'Appears when a downloaded update is ready. Confirms before killing any running sessions (they are restored on next launch). Restarts into the new version.' },
          { label: 'Release notes', detail: 'Shown inline when an update is available or ready. Pulled from the GitHub release description.' },
          { label: 'Signed builds required', detail: 'macOS requires the downloaded .dmg/.zip to be signed with the same certificate as the running app. Unsigned builds will fail to install silently — watch for errors in the status line.' },
        ],
      },
      {
        name: 'Webhook & API Section',
        position: 'Below Commit Attribution',
        items: [
          { label: 'Enable webhook server', detail: 'Starts an HTTP server on 127.0.0.1:<port> (default 7474). Required for both webhook pipeline triggers and the REST API.', icon: 'Globe' },
          { label: 'Port', detail: 'Port to listen on. Requires app restart to take effect. Default: 7474.' },
          { label: 'API URL', detail: 'Base URL for the Colony REST API (http://127.0.0.1:7474/api/). Click the copy button to copy it. Use GET /api/sessions, GET /api/pipelines, POST /api/sessions/:id/steer, POST /api/pipelines/:name/trigger, or GET /api/events (SSE stream). Protect with an API token via the apiToken setting.' },
          { label: 'GET /api/sessions', detail: 'Returns a list of all sessions: id, name, status, uptime (ms). Filter by status client-side.' },
          { label: 'POST /api/pipelines/:name/trigger', detail: 'Trigger a named pipeline run immediately — same as clicking the Run button in the Pipelines panel. Name must match the pipeline file slug.' },
          { label: 'GET /api/events', detail: 'SSE stream of all Colony broadcast events (session updates, pipeline fires, activity). Connect with EventSource. Max 5 concurrent clients. Each message is JSON: { channel, data }.' },
        ],
      },
      {
        name: 'Approval Rules Section',
        position: 'Above Logs section',
        items: [
          { label: 'Approval Rules', detail: 'Define rules that auto-approve, require approval, or escalate actions based on file patterns, cost, or risk level. Rules enable safe delegation of agent workflows without manual sign-off on every low-risk action.', icon: 'Shield' },
          { label: 'file_pattern rule', detail: 'Glob patterns (e.g. *.md,*.txt) matched against files changed by the action. Useful for auto-approving documentation-only changes. First matching rule wins.' },
          { label: 'cost_threshold rule', detail: 'Compares estimated action cost against a threshold (e.g. < 0.10). Low-cost formatting or validation runs auto-approve; expensive operations require approval.' },
          { label: 'risk_level rule', detail: 'Infers risk from action type (plan/wait → low, diff_review/session → medium). Match with pipe-separated levels (e.g. low|medium) to auto-approve safe actions.' },
          { label: 'Rule precedence', detail: 'Rules are evaluated in order — first match wins. Disabled rules are skipped.' },
          { label: 'Auto-approve audit trail', detail: 'Auto-approved actions are logged for compliance (autoApproved: true).' },
        ],
      },
      {
        name: 'Onboarding Section',
        position: 'Above Scheduler Log',
        items: [
          { label: 'Replay welcome screen', detail: 'Re-opens the first-run welcome modal with the feature tour and prerequisite checks. Also available via the command palette ("Show Welcome").', icon: 'RotateCcw' },
          { label: 'Activation checklist', detail: 'Read-only progress tracker showing which key actions you\'ve completed: created a session, ran a prompt, created a persona, connected GitHub, ran a pipeline.' },
          { label: 'Reset all onboarding state', detail: 'Clears the activation checklist and re-shows the welcome screen. Useful for QA testing or if you want a fresh start.', icon: 'Trash2' },
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
          { label: 'List / Schedule / Triggers tabs', detail: 'List shows persona cards. Schedule shows a 24-hour heatmap of when each persona fires. Triggers shows a directed graph of cross-persona trigger chains.', icon: 'CalendarClock' },
        ],
      },
      {
        name: 'Ask Bar',
        position: 'Below header',
        items: [
          { label: 'Ask about personas', detail: 'Type a question about what your personas have been doing — e.g. "what did Colony Developer ship yesterday?" Reads all persona session logs and briefs, then answers inline via Claude Haiku. Clears when you click ✕.', icon: 'ArrowRight' },
          { label: 'Persona Assistant', detail: 'Describe a persona and the assistant will create or modify the .md file for you. It knows the file format, section conventions, and permission scopes.', icon: 'MessageSquare' },
          { label: 'View button', detail: 'Focus the running Persona Assistant session to continue the conversation.' },
          { label: 'File drag & drop', detail: 'Drag files from Finder onto the assistant bar to append their absolute paths to your message.' },
        ],
      },
      {
        name: 'Persona Cards',
        position: 'Main area',
        items: [
          { label: 'Status dot', detail: 'Green pulsing = running a session. Gray = idle. Dimmed = disabled.' },
          { label: 'Queued badge', detail: 'Amber "queued" badge appears when another persona has dispatched a trigger for this one — it will launch on its next scheduled run or when manually triggered. Hover for the triggering persona name and context note.' },
          { label: 'Schedule', detail: 'Shows when the persona runs automatically as a human-readable label (e.g. "Every 2 hours"). Click to open the schedule editor with presets and next-run times.', icon: 'Clock' },
          { label: 'Run count', detail: 'How many sessions this persona has completed.' },
          { label: 'Trigger label', detail: '"→ colony-qa" (accent color) — set via on_complete_run; those personas auto-launch when this session ends. Muted "→ x" — set via can_invoke; personas this one may trigger dynamically via a trigger file, but never fires automatically.' },
          { label: 'Run button', detail: 'Manually trigger a persona session now.', icon: 'Play' },
          { label: 'Stop button', detail: 'Stop the currently running persona session.', icon: 'Square' },
          { label: 'Notes button', detail: 'Queue a note for the persona\'s next session. Notes are injected into the planning prompt, then removed after use.', icon: 'StickyNote' },
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
          { label: 'Permissions', detail: 'What the persona can and cannot do: push code, merge PRs, create sessions. conflict_group serializes two can_push personas so they never run simultaneously (same group = one at a time; different groups = concurrent). run_condition: new_commits skips a run if no new commits have landed since the last run.' },
          { label: 'Outputs tab', detail: 'Switch to the Outputs tab in an expanded card to browse files the persona wrote to ~/.claude-colony/outputs/<persona>/. Click any file to open a read-only viewer. Session Brief is always listed first.', icon: 'FolderOpen' },
          { label: 'History tab', detail: 'Switch to the History tab in an expanded card to see a timeline of past runs — timestamp, duration, and success status.', icon: 'Clock' },
          { label: 'Analytics tab', detail: 'Switch to the Analytics tab to see aggregate stats: total runs, success rate, average duration, total cost, 7-day cost. Includes a run-duration sparkline (green=success, red=fail), daily cost bar chart, and a table of the last 10 runs with per-run cost.', icon: 'BarChart3' },
          { label: 'Sort dropdown', detail: 'Sort the persona list by Name, Last Run, Runs, Cost, or Success Rate. In the panel header, next to the help icon.', icon: 'ArrowUpDown' },
          { label: 'Stat chips', detail: 'Inline success rate and 7-day cost chips on each persona card row. Color-coded: green ≥80%, amber ≥50%, red <50%.' },
          { label: 'Edit persona settings', detail: 'Click the Pencil icon (list view) to open a quick-edit modal for schedule, model, max sessions, and enabled state — without touching the raw markdown.', icon: 'Pencil' },
          { label: 'View File', detail: 'Open a read-only preview of the persona\'s raw markdown file.', icon: 'FileText' },
          { label: 'Edit File', detail: 'Open the persona\'s markdown file in a text editor. Edit any section and save — useful for updating Role, Objectives, or manually fixing the Active Situations block.', icon: 'Pencil' },
        ],
      },
      {
        name: 'Schedule Heatmap',
        position: 'Schedule tab',
        items: [
          { label: 'Timeline grid', detail: '24-hour timeline (00–23) with one row per enabled persona that has a cron schedule. Thin bars show when each persona is scheduled to fire.' },
          { label: 'Day selector', detail: 'Navigate between days with arrow buttons. "Today" button returns to current day. Only past days have actual run data.', icon: 'ChevronLeft' },
          { label: 'Overlap bands', detail: 'Red-tinted vertical bands highlight minutes where 3+ personas fire simultaneously. Hover for count and time.' },
          { label: 'Run dots', detail: 'Green dots = actual runs that fired on time. Amber dots = runs that fired >2 minutes late vs the closest scheduled time.' },
          { label: 'Disabled personas', detail: 'Shown as dimmed rows so you can see the full schedule picture even when some personas are toggled off.' },
        ],
      },
      {
        name: 'Trigger Map',
        position: 'Triggers tab',
        items: [
          { label: 'Directed graph', detail: 'SVG visualization of cross-persona trigger relationships. Personas are nodes arranged in layers by dependency depth.', icon: 'GitBranch' },
          { label: 'Solid arrows', detail: 'on_complete_run edges — these always fire when the source persona finishes. Labeled "always".' },
          { label: 'Dashed arrows', detail: 'can_invoke edges — the source persona may trigger the target dynamically via a trigger file. Labeled "may trigger".' },
          { label: 'Cycle detection', detail: 'If on_complete_run chains form a cycle (A→B→C→A), those edges are highlighted in red with a warning banner.' },
          { label: 'Color dots', detail: 'Each node shows the persona color. Green pulsing dot = running. Dimmed node = disabled persona.' },
          { label: 'Click to navigate', detail: 'Click any node to switch to the List tab and expand that persona card.' },
          { label: 'Zoom', detail: 'Cmd+scroll (or Ctrl+scroll) to zoom in/out (50%–300%). Use the +/− buttons in the top-right corner. Zoom level persists across sessions.' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+Shift+P', action: 'Run the first enabled idle persona from anywhere' },
    ],
    emptyState: {
      hook: 'No personas yet. They shape how your agents think and schedule.',
      keyCap: 'P',
      ctaLabel: 'Create Persona',
    },
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
          { label: 'Artifacts tab', detail: 'Auto-generated proof-of-work bundle: commits, changed files, duration, cost. Collected on session exit.' },
          { label: 'Tab navigation', detail: 'Cmd+Shift+{ / Cmd+Shift+} cycles through the visible tabs (Session, Terminal, Files, Changes, Artifacts, plus Services/Logs when an environment is attached and Team/Metrics for Coordinator sessions). Works even when focus is inside a terminal or input — the Cmd+Shift combo never conflicts with typing `{`/`}`. Same shortcut works in Environments (Environments ↔ Templates).' },
        ],
      },
      {
        name: 'Header Info',
        position: 'Right side of tab bar',
        items: [
          { label: 'Git branch badge', detail: 'Shows the current git branch and repo name.', icon: 'GitBranch' },
          { label: 'Info button', detail: 'Opens a popover with launch command, PID, working directory, MCP servers, token usage, and child processes.', icon: 'Info' },
          { label: 'Steer session', detail: 'Send a mid-run redirect message without stopping the session. If idle, the message is delivered immediately. If busy, it is queued and delivered the moment the session next becomes idle. Prefixed with [Operator steering]: so the agent recognises it as a course correction.', icon: 'Navigation' },
          { label: 'Reset terminal', detail: 'Destroy the terminal and create a fresh one. On the Session tab, clears and re-replays the buffer. On the Shell tab, kills the shell and spawns a new one.', icon: 'RotateCcw' },
          { label: 'Spawn child', detail: 'Create a child session that reports back via a handoff document when done.', icon: 'GitFork' },
          { label: 'Split View', detail: 'Opens a second session side-by-side (2-up). Shortcut: Cmd+\\. In 2-up mode, a "Grid" button appears to expand to 4-up (2×2 grid) for monitoring multiple sessions at once.', icon: 'Columns2' },
          { label: 'Grid View', detail: 'Expand to a 2×2 grid showing up to 4 sessions. Click empty panes to assign sessions. Click "Single" to return to single view. The focused pane has a highlighted border.', icon: 'LayoutGrid' },
          { label: 'Arena chip', detail: 'Shown in pane headers when Arena mode is active — confirms that the shared input bar is routing to this session. Works in both 2-up split and 4-up grid.' },
        ],
      },
      {
        name: 'Arena Mode',
        position: 'Split divider (2-up) or bottom bar (4-up grid)',
        items: [
          { label: 'Arena toggle', detail: 'In 2-up split: the swords button on the split divider. In 4-up grid: the "Arena" button in the controls bar between the grid and input area. Click to enable/disable Arena mode.' },
          { label: 'Blind Mode', detail: 'EyeOff button hides all session names — panes become "Pane 1", "Pane 2", etc. Vote buttons replace the trophy button. After voting, names are revealed and blind mode clears. Resets each time you send a new Arena prompt.', icon: 'EyeOff' },
          { label: 'Shared input bar', detail: 'When Arena mode is on, a shared textarea appears below all panes. Type a prompt and press Enter (or click Send) to broadcast identical input to all sessions in the arena. Shift+Enter adds a newline.' },
          { label: 'N-way comparison', detail: 'Arena works in both 2-up split (2 sessions) and 4-up grid (up to 4 sessions). In grid mode, voting picks one winner — all other sessions are recorded as losers.' },
          { label: 'Pick winner', detail: 'Trophy button in each pane header — click to mark that session as the winner of the current round. All buttons disable until the next prompt is sent. Win/loss totals are persisted across sessions.', icon: 'Trophy' },
          { label: 'Stats', detail: 'BarChart3 button in the Arena toolbar — shows win rates per session sorted by win percentage (e.g. "Colony QA: 5W / 2L (71%)").', icon: 'BarChart3' },
          { label: 'Launch Arena', detail: 'Rocket button in the grid controls bar. Opens a dialog to create N isolated worktrees from a repo+branch and spawn one session per pane — fully automated arena setup. Supports 2-4 agents, optional shared prompt, and per-agent model overrides.', icon: 'Rocket' },
          { label: 'Leaderboard', detail: 'Trophy button in the grid controls bar. Shows cumulative win/loss stats across all arena sessions, persisted in localStorage. Sorted by win rate.', icon: 'Trophy' },
          { label: 'Auto-Judge', detail: 'Gavel button — automatically pick a winner by running a shell command (e.g. "npm test") in each session\'s working directory. The first session whose command exits with code 0 wins. Stats are recorded automatically. Human can still override by clicking vote buttons.', icon: 'Gavel' },
          { label: 'Arena cleanup', detail: 'When exiting grid mode after an arena launch, you are prompted to remove the temporary worktrees. Declining keeps them for manual inspection.' },
          { label: 'Use case', detail: 'Compare models, personas, or approaches on the same task — evaluate quality, speed, and style side-by-side. 4-up grid enables N-way comparison that neither Cursor nor Windsurf offers. Launch Arena automates the entire setup.' },
        ],
      },
      {
        name: 'Status Strip',
        position: 'Below tab bar (running sessions only)',
        items: [
          { label: 'Activity dot', detail: 'Pulsing green = Running, amber = Waiting for input.' },
          { label: 'Model', detail: 'The Claude model in use (e.g. sonnet-4-6). Parsed from launch args.' },
          { label: 'Uptime', detail: 'Time since the session was created.' },
          { label: 'Ctx indicator', detail: 'Amber = context ≥ 250 KB output, red ≥ 600 KB. Consider checkpointing.' },
        ],
      },
      {
        name: 'Tool Deferred Banner',
        position: 'Above terminal (exited sessions only)',
        items: [
          { label: 'Tool deferred', detail: 'Appears when Claude Code exits because a hook deferred a tool call. The session is paused, waiting for human approval.', icon: 'AlertTriangle' },
          { label: 'Approve', detail: 'Restart the session with --resume, re-evaluating the deferred tool. The hook will run again.', icon: 'Play' },
          { label: 'Deny', detail: 'Dismiss the banner without restarting. The session stays exited — you can resume it manually later.' },
          { label: 'Sidebar badge', detail: 'An amber "Defer" badge appears on the session tile when a tool is deferred.' },
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
          { label: 'Refresh', detail: 'Reload the file tree from disk.', icon: 'RefreshCw' },
          { label: 'Sort toggle', detail: 'Toggle between Name and Modified sort order for the file tree.', icon: 'ArrowUpDown' },
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
        name: 'Quick Commands',
        position: 'Top bar (once shell is initialized)',
        items: [
          { label: 'Quick commands bar', detail: 'One-click shortcuts for common commands: git status, git log, ls -la, npm test. Click a chip to run it.' },
          { label: 'Toggle', detail: 'Click "Quick ›/‹" to collapse or expand the commands bar.' },
        ],
      },
      {
        name: 'Shell',
        position: 'Full area',
        items: [
          { label: 'Independent process', detail: 'This is a separate shell (bash/zsh), not the Claude CLI. It doesn\'t share state with the Claude session.' },
          { label: 'Same directory', detail: 'Opens in the same working directory as the Claude session.' },
          { label: 'Persistent', detail: 'The shell stays alive as long as the session exists. Switch tabs freely.' },
          { label: 'Search', detail: 'Cmd+F opens a search bar to find text in the shell output. Same search as the Session tab.' },
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
          { label: 'Level filter', detail: 'Second row: filter by log level — All levels, Error (ERROR/FATAL/FAIL), or Warn. Combines with the service filter.' },
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

  browserTab: {
    title: 'Browser',
    description: 'Embedded web preview of environment services. View your running frontend, backend, or any service with an HTTP endpoint — without leaving the session.',
    zones: [
      {
        name: 'Service Tabs',
        position: 'Top bar',
        items: [
          { label: 'Service pills', detail: 'One button per service URL. Click to switch the embedded browser to that service.' },
          { label: 'Navigation', detail: 'Back, forward, and reload buttons for standard browser navigation.' },
          { label: 'URL bar', detail: 'Editable URL bar — type or paste any URL and press Enter to navigate. Updates automatically when you click links.' },
          { label: 'Open External', detail: 'Opens the current page in your system browser.', icon: 'ExternalLink' },
          { label: 'DevTools', detail: 'Opens Chromium Developer Tools for the embedded browser — inspect elements, debug JavaScript, monitor network requests.', icon: 'Bug' },
        ],
      },
      {
        name: 'Webview',
        position: 'Main area',
        items: [
          { label: 'Embedded browser', detail: 'Full web browser rendering the selected service. Cookies and sessions are isolated per environment.' },
          { label: 'Error state', detail: 'If a service fails to load (e.g., not yet started), shows an error with a Retry button.' },
        ],
      },
    ],
  },

  tasksBoard: {
    title: 'Task Board',
    description: 'A shared coordination board backed by ~/.claude-colony/colony-tasks.json. All Colony personas and sessions can read and write tasks, making it a lightweight shared primitive for multi-agent workflows.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Active count', detail: 'Badge showing the number of tasks not yet Done.' },
          { label: 'Refresh', detail: 'Re-read the task board from disk.', icon: 'RefreshCw' },
          { label: 'New task', detail: 'Open the new-task form. Fill in title, status, priority, assignee, and optional tags/description.', icon: 'Plus' },
        ],
      },
      {
        name: 'Filter bar',
        position: 'Below header',
        items: [
          { label: 'Search', detail: 'Filter tasks by title or description text.', icon: 'Search' },
          { label: 'Priority filter', detail: 'Show only tasks of a specific priority (Critical, High, Medium, Low).' },
          { label: 'Assignee filter', detail: 'Show only tasks assigned to a specific person. Populated from existing task assignees.' },
          { label: 'Source filter', detail: 'Filter by who created the task — User or a specific persona (e.g. colony-product). Green badge on cards.' },
          { label: 'Clear filters', detail: 'Remove all active filters and show all tasks.' },
        ],
      },
      {
        name: 'Board columns',
        position: 'Main area',
        items: [
          { label: 'To Do / In Progress / Blocked / Done', detail: 'All four columns are always visible, even when empty. Each shows a task count in the header.' },
          { label: 'Quick add (+)', detail: 'Click the + icon in a column header to quickly add a task directly to that column.', icon: 'Plus' },
          { label: 'Priority sorting', detail: 'Tasks within each column are sorted by priority (Critical first) then by most recently updated.' },
          { label: 'Task card', detail: 'Shows priority dot, title (1 line), assignee badge, description preview (2 lines), relative timestamp, tags, source badge (green), and project badge. Click to open the detail panel.' },
        ],
      },
      {
        name: 'Detail panel',
        position: 'Right sidebar',
        items: [
          { label: 'Task details', detail: 'Click a card to open the detail panel showing full title, priority, status, assignee, tags, description, and timestamps.' },
          { label: 'Edit task', detail: 'Click the pencil icon to edit all task fields including priority and a larger description area.', icon: 'Pencil' },
          { label: 'Move to', detail: 'Quick status-change buttons to move the task between columns.' },
          { label: 'Delete task', detail: 'Trash icon deletes the task after confirmation.', icon: 'Trash2' },
        ],
      },
      {
        name: 'File format',
        position: 'Background',
        items: [
          { label: 'colony-tasks.json', detail: 'Stored at ~/.claude-colony/colony-tasks.json. Can be written by any persona or external script. The priority field is optional (defaults to medium).' },
          { label: 'Live updates', detail: 'The board watches the file for external changes and refreshes automatically when another agent writes to it.' },
        ],
      },
    ],
  },

  outputs: {
    title: 'Outputs Browser',
    description: 'Browse all artifacts generated by Colony — persona briefs, pipeline outputs, and session handoffs. Files are read directly from ~/.claude-colony/outputs/ and ~/.claude-colony/personas/*.brief.md.',
    zones: [
      {
        name: 'File List',
        position: 'Left column',
        items: [
          { label: 'Browse artifacts', detail: 'All output files sorted newest-first. Click any row to view contents in the right pane.', icon: 'FolderOpen' },
          { label: 'Filter by type', detail: 'Use the All / Briefs / Artifacts chips to narrow the list. Briefs are persona session summaries; Artifacts are pipeline and task outputs.', icon: 'Filter' },
          { label: 'Search', detail: 'Type to filter by file name or agent ID. Results update 200ms after you stop typing.' },
          { label: 'Refresh', detail: 'Reload the file list from disk. Useful after a persona or pipeline run completes.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Viewer',
        position: 'Right pane',
        items: [
          { label: 'Markdown rendering', detail: 'Files ending in .md are rendered with rich formatting: syntax-highlighted code blocks (Python, JS/TS, Bash, JSON, YAML, and more), copy-to-clipboard on code blocks, task list checkboxes, alternating table row colors, and styled headings with borders.' },
          { label: 'Size limit', detail: 'Files larger than 32KB are truncated with a notice at the end.' },
        ],
      },
    ],
    emptyState: {
      hook: 'Nothing here yet. Run a persona or pipeline to generate an artifact.',
    },
  },
  changesTab: {
    title: 'Changes (Git Diff)',
    description: 'Shows uncommitted file changes in the session\'s working directory (`git diff HEAD`). Each file can be reverted individually or all at once. Review agents can annotate specific lines via COLONY_COMMENT sentinels — annotations appear inline below the file they reference.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Refresh', detail: 'Reload the change list from git.', icon: 'RefreshCw' },
          { label: 'Stage & Commit', detail: 'Open a commit dialog to stage selected files and commit (or commit & push) directly from the UI. Shows branch info, file checklist with select/deselect, insertion/deletion stats. Ctrl+Enter (Cmd+Enter on Mac) submits. Push button only appears when a remote is configured.', icon: 'GitCommit' },
          { label: 'Score Output', detail: 'Run an LLM-as-Judge assessment on the current diff. Returns a 1–5 confidence score, scope creep warning, test coverage indicator, and 2-3 sentence summary. Powered by claude-haiku.', icon: 'Sparkles' },
          { label: 'Revert All', detail: 'Revert every changed file to HEAD. A confirmation dialog appears first — this cannot be undone.', icon: 'Undo2' },
          { label: 'Auto-refresh', detail: 'The change list refreshes automatically every 10 seconds while this tab is open.' },
        ],
      },
      {
        name: 'File List',
        position: 'Main area',
        items: [
          { label: 'Status letter', detail: 'M = modified, A = added, D = deleted, R = renamed. Color-coded: amber for M, green for A, red for D.' },
          { label: 'File path', detail: 'Relative path of the changed file within the working directory. Click to expand inline diff.' },
          { label: '+/- counts', detail: 'Number of inserted lines (green) and deleted lines (red) in the diff.' },
          { label: 'Inline diff', detail: 'Click any file row to expand a color-coded unified diff below it. Green for additions, red for deletions, with line numbers and syntax highlighting (language auto-detected from file extension). Diffs are fetched lazily and cached. Large diffs (500+ lines) are truncated with a "Show full diff" button. Binary files show a placeholder.' },
          { label: 'Revert button', detail: 'Reverts that single file to HEAD via `git checkout HEAD -- <file>`. Confirmation required.', icon: 'Undo2' },
          { label: 'Empty state', detail: 'Shows "No uncommitted changes" when the working tree is clean.' },
        ],
      },
      {
        name: 'Inline Annotations',
        position: 'Below each file entry',
        items: [
          { label: 'COLONY_COMMENT sentinel', detail: 'Review agents emit `COLONY_COMMENT:<file>:<line>:<severity>:<message>` lines. The daemon strips these from terminal output and stores them. Polled every 3 seconds while the session is running.' },
          { label: 'Severity chips', detail: 'ERROR (red), WARN (amber), INFO (blue) — color-coded left border and label next to the line number.' },
          { label: 'Line number', detail: 'L<N> shows which source line the comment refers to.' },
        ],
      },
    ],
  },
  artifactsTab: {
    title: 'Session Artifacts',
    description: 'Auto-generated proof-of-work bundles collected when a session exits. Shows commits made, files changed, duration, cost, and branch info. Artifacts are stored persistently (up to 200) and can also be collected manually for running sessions.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Refresh', detail: 'Reload the artifact for this session.', icon: 'RefreshCw' },
          { label: 'Collect Now', detail: 'Manually collect an artifact snapshot for a running session. Only appears when no artifact exists yet.', icon: 'Sparkles' },
        ],
      },
      {
        name: 'Summary Card',
        position: 'Top of content area',
        items: [
          { label: 'Session name', detail: 'The name of the session that produced this artifact.' },
          { label: 'Persona badge', detail: 'Shows the persona name if this was a persona-driven session.' },
          { label: 'Pipeline badge', detail: 'Appears when the artifact was produced by a pipeline run.' },
          { label: 'Exit code', detail: 'Green for exit 0 (success), red for non-zero.' },
          { label: 'Branch / Duration / Cost', detail: 'Git branch, session duration in minutes, and API cost in USD.' },
          { label: '+/- totals', detail: 'Total insertions (green) and deletions (red) across all changed files.' },
        ],
      },
      {
        name: 'Commits',
        position: 'Below summary',
        items: [
          { label: 'Commit hash', detail: 'Short (7-char) commit hash in accent color.' },
          { label: 'Commit message', detail: 'First line of the commit message.' },
        ],
      },
      {
        name: 'Changed Files',
        position: 'Below commits',
        items: [
          { label: 'Status letter', detail: 'M = modified, A = added, D = deleted, R = renamed.' },
          { label: 'File path', detail: 'Relative path of the changed file.' },
          { label: '+/- counts', detail: 'Per-file insertion and deletion counts.' },
        ],
      },
    ],
  },
  teamTab: {
    title: 'Team (Coordinator)',
    description: 'Available only when a session has the Coordinator role. Shows all active Worker sessions that this coordinator is managing. Displays each worker\'s status, activity, and accumulated cost for real-time visibility into multi-agent workflows.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Refresh', detail: 'Reload the worker list from the daemon.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Worker List',
        position: 'Main area',
        items: [
          { label: 'Worker name', detail: 'Session name of the worker agent.' },
          { label: 'Status badge', detail: 'Green "running" or gray "exited". Updated in real-time as workers start and stop.' },
          { label: 'Activity badge', detail: 'Shows "busy" (amber) when Claude is processing, "waiting" (green) when ready for input.' },
          { label: 'Cost', detail: 'Accumulated token cost ($USD) for that worker session.' },
          { label: 'Empty state', detail: 'Shows "No worker sessions active" when the coordinator has no assigned workers.' },
        ],
      },
      {
        name: 'Future Coordinator Features',
        position: 'Planned',
        items: [
          { label: 'Worker context injection', detail: 'Handoff documents will include a list of active workers + their recent outputs.' },
          { label: '@worker-name messaging', detail: 'Use @worker-name mentions in the whisper bar to send targeted instructions to individual workers.' },
          { label: 'Coordinator audit log', detail: 'Track which workers were assigned which tasks and when.' },
        ],
      },
    ],
  },
  review: {
    title: 'Review Dashboard',
    description: 'Cross-session diff review — see uncommitted changes across all running and stopped sessions in one view. Expands inline to show per-file diffs with insertion/deletion stats.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Filter toggle', detail: 'Switch between "Changed" (only sessions with uncommitted changes) and "All" (every session with a working directory).', icon: 'Filter' },
          { label: 'Refresh', detail: 'Manually re-fetch git changes for all sessions. Also auto-refreshes every 30 seconds.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Summary Bar',
        position: 'Below header',
        items: [
          { label: 'Change totals', detail: 'Total files changed, sessions with changes, and aggregate insertions/deletions across all sessions.' },
        ],
      },
      {
        name: 'Session Cards',
        position: 'Main area',
        items: [
          { label: 'Session name', detail: 'Color-coded dot + session name. Click to expand and see per-file changes.' },
          { label: 'Status badge', detail: 'Shows whether the session is running or exited.' },
          { label: 'File count + stats', detail: 'Number of changed files with total insertions (green) and deletions (red).' },
          { label: 'Branch name', detail: 'Git branch the session is working on, if available.' },
          { label: 'Open in terminal', detail: 'Jump to this session in the Sessions view.', icon: 'Terminal' },
          { label: 'Copy branch', detail: 'Copy the branch name to clipboard.', icon: 'Copy' },
        ],
      },
      {
        name: 'Expanded File List',
        position: 'Below card when expanded',
        items: [
          { label: 'File status', detail: 'A = Added (green), M = Modified (yellow), D = Deleted (red), R = Renamed, ? = Untracked.' },
          { label: 'File path', detail: 'Full path of the changed file in monospace font. Click to expand inline diff.' },
          { label: 'Inline diff', detail: 'Click any file row to expand a line-level unified diff. Color-coded additions/deletions with gutter line numbers and syntax highlighting (auto-detected from file extension). Lazy-loaded and cached per session.' },
          { label: 'Insertions / Deletions', detail: 'Per-file line counts: green for additions, red for removals.' },
        ],
      },
    ],
  },

  teamMetrics: {
    title: 'Team Metrics Dashboard',
    description: 'Real-time performance analytics for multi-worker teams. Track team-level success rates, duration trends, and per-worker efficiency metrics across 7-day or 30-day windows. Accessible in Coordinator sessions (Metrics tab) or as a standalone panel.',
    zones: [
      {
        name: 'Time Window',
        position: 'Top controls',
        items: [
          { label: '7d / 30d toggle', detail: 'Switch between 7-day and 30-day rolling windows for metrics aggregation.' },
          { label: 'Export as CSV', detail: 'Download the current worker metrics table as a CSV file for analysis in spreadsheet tools.', icon: 'Download' },
        ],
      },
      {
        name: 'Summary Cards',
        position: 'Below controls',
        items: [
          { label: 'Success Rate', detail: 'Percentage of worker sessions that completed successfully (exitCode === 0).' },
          { label: 'Avg Duration', detail: 'Mean session duration across all workers in the selected window.' },
          { label: 'Team Cost (YTD)', detail: 'Total USD cost for all workers since the start of the year (not limited by window).' },
          { label: 'Active Workers', detail: 'Count of distinct workers with at least one run in the selected window.' },
        ],
      },
      {
        name: 'Runs per Worker Chart',
        position: 'Middle section',
        items: [
          { label: 'Bar chart', detail: 'One bar per worker showing run count in the selected window, sorted highest-first. Hover any bar to see the worker name and exact count.' },
        ],
      },
      {
        name: 'Worker Performance Table',
        position: 'Bottom section',
        items: [
          { label: 'Worker ID', detail: 'Name of the worker session (extracted from "Worker: <name>" pattern).' },
          { label: 'Runs', detail: 'Number of completed sessions for this worker in the selected window.' },
          { label: 'Success Rate (%)', detail: 'Percentage of successful runs (0–100).' },
          { label: 'Avg Duration (s)', detail: 'Mean session duration in seconds.' },
          { label: 'Total Cost (USD)', detail: 'Cumulative cost for all runs of this worker in the selected window.' },
          { label: 'Last Run', detail: 'When this worker last completed a session (relative time: e.g., "2h ago").' },
        ],
      },
      {
        name: 'Interpretation Guide',
        position: 'Reference',
        items: [
          { label: 'Bottlenecks', detail: 'High run count + low success rate = debugging needed; high duration = slow; high cost = expensive operations.' },
          { label: 'Optimization target', detail: 'Sort table by any column to find workers worth optimizing (highest cost, longest duration, lowest success).' },
          { label: 'Trend analysis', detail: 'Compare 7d vs 30d metrics to identify recent improvements or regressions.' },
        ],
      },
    ],
  },
}
