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
          { label: '+ New Session', detail: 'Opens a dialog to create a Claude CLI session. Set a name, color, working directory, and optional CLI args. Keyboard shortcut: Cmd+N.', icon: 'Plus' },
          { label: 'Restore banner', detail: 'After app restart, shows a button to restore sessions that were running when you last quit.', icon: 'RotateCcw' },
        ],
      },
      {
        name: 'Session List',
        position: 'Main area',
        items: [
          { label: 'Active sessions', detail: 'Pulsing dot = Claude is working. Solid dot = waiting for input. Click to open.' },
          { label: 'Stopped sessions', detail: 'Dimmed with exit code. Auto-cleaned after 5 minutes (configurable in Settings). "Clear all" appears on the Stopped divider when 2+ sessions are stopped.' },
          { label: 'Pin to top', detail: 'Right-click a session to pin it. Pinned sessions stay at the top and are restored on launch.', icon: 'Pin' },
          { label: 'Export Handoff Doc', detail: 'Generates a markdown snapshot of the session — git commits, terminal output, metadata — ready to paste into a new session to restore context. Click "✨ Generate Summary" inside the dialog to replace the raw terminal snapshot with an AI-generated 3–5 sentence summary.', icon: 'FileDown' },
          { label: 'Session Templates', detail: 'Save and reuse session configurations. Right-click a session → Save as Template to save the name, working directory, and role. The New Session button shows a template picker when templates exist. Manage templates in Settings → Session Templates.', icon: 'BookTemplate' },
          { label: 'Context budget badge', detail: 'Amber "ctx" badge when a session has generated significant output (context building up). Red when near the limit. Click to open the Handoff Doc export to capture a snapshot before the session reaches its context limit.' },
          { label: 'Cost badge', detail: 'Running API cost estimate (e.g. "$0.12") parsed from Claude CLI output. Appears once cost exceeds $0.001. Hover for the exact figure to 4 decimal places.' },
          { label: 'Role badge', detail: 'Purple tag (Orchestrator, Planner, Coder, Tester, Reviewer, Researcher) set via right-click. Helps coordinate multi-agent workflows at a glance.' },
          { label: 'Split indicator', detail: 'A columns icon appears on sessions that have a split partner.', icon: 'Columns2' },
          { label: 'Shortcut numbers', detail: 'Numbers 1-9 shown next to sessions for quick Cmd+N jumping.' },
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
        name: 'Footer',
        position: 'Bottom of sidebar',
        items: [
          { label: 'Help icon', detail: 'Opens this help popover.', icon: 'HelpCircle' },
          { label: 'Activity bell', detail: 'Shows recent automation events from personas, pipelines, and environments. Persona completion events include outcome stats: duration, commits made, and files changed. Turns amber when pipeline actions are waiting for approval.', icon: 'Bell' },
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
          { label: 'Needs Your Attention', detail: 'Pinned section showing PRs where your review is requested, you are assigned, or your PR has failing CI. Click a row to jump to that PR.', icon: 'AlertCircle' },
          { label: 'PR row', detail: 'Shows title, author, branch, labels, and review status (approved/changes requested/pending). Age badge (Xd) turns amber after 4 days, red after 7.' },
          { label: 'Ready / Blocked badges', detail: '"Ready" (green) means approved + all checks passed. "Blocked" (red) means changes were requested.' },
          { label: 'Review Requested', detail: 'Amber badge appears when your review is requested on a PR.', icon: 'Eye' },
          { label: 'Feedback badge', detail: 'Shows Colony Feedback status: amber = feedback pending, green = new commits since review (ready for re-review).', icon: 'MessageSquare' },
          { label: 'CI badges', detail: 'Green/red/yellow dots for GitHub Actions check status. Click to see details and fetch failure logs.' },
          { label: 'Dispatch button', detail: 'Send this PR as a note to a persona. Pick a persona and add optional context — the note appears in the persona\'s ## Notes section on its next run.', icon: 'UserPlus' },
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
          { label: 'File drag & drop', detail: 'Drag files from Finder onto the ask bar to append their absolute paths to your message. The bar highlights with a dashed border on hover.' },
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
          { label: 'Parallel Fan-Out stage', detail: 'Add type: parallel with a stages: list to dispatch multiple sub-actions simultaneously. All sub-stages run concurrently (Promise.all). Set fail_fast: false to run all stages regardless of failures (default: true, abort on first failure). Cost = sum of all sub-stage costs. The History tab shows parallel groups as indented sub-stage rows. Nested parallel stages are not supported.' },
          { label: 'Plan stage', detail: 'Add type: plan to require an agent to produce an implementation plan before the pipeline proceeds. The planning session writes its plan to a file, then an approval gate appears ("Approve plan to proceed?"). Approve to continue (plan is injected into the next stage via handoffInputs), Reject to stop the run. Set require_approval: false for fully automated pipelines — plan is logged but pipeline continues without a gate. Override the completion keyword with plan_keyword (default: PLAN_READY). The plan is saved as an artifact in ~/.claude-colony/artifacts/ for next stages to consume.', icon: 'FileText' },
          { label: 'Wait for Session stage', detail: 'Add type: wait_for_session with session_name: "My Session" to block the pipeline until a named session exits. Polls every 5s. Tolerate "not found" for 30s after the stage starts (session may not have launched yet). Set timeout_minutes (default: 30) to control the max wait. Transient daemon disconnects are ignored. Set artifact_output: name to write the session exit reason to ~/.claude-colony/artifacts/<name>.txt — useful for feeding results into subsequent stages via handoffInputs.', icon: 'Hourglass' },
          { label: 'Per-run cost budget', detail: 'Add budget: { max_cost_usd: 0.50, warn_at: 0.38 } to a pipeline YAML. Colony notifies at warn_at and stops the run at max_cost_usd, marking the card with an amber Budget badge.' },
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
          { label: 'Memory', detail: 'Per-pipeline memory file. Sessions are told to append learnings here.' },
          { label: 'Outputs', detail: 'Configurable output directory for pipeline-generated files.' },
          { label: 'History', detail: 'Ring buffer of the last 20 poll runs: timestamp, trigger type, whether an action fired, success/failure, duration, and cost (shown as a muted $X.XX badge when non-zero). Click rows with a chevron (▶) to expand per-stage details — stage type, session name, reviewer response snippet (diff_review stages), individual duration, and a △ badge on any stage whose status changed from the prior run.', icon: 'Clock' },
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
    shortcuts: [
      { keys: 'Cmd+Shift+F', action: 'Fire the first enabled pipeline from anywhere' },
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
          { label: 'List/card toggle', detail: 'Switch between compact list rows and card view (Instances tab). Preference is saved per device.', icon: 'LayoutList' },
          { label: 'Refresh button', detail: 'Re-fetches bare repos and re-scans for .colony/ templates (Templates tab only).', icon: 'RefreshCw' },
          { label: 'Import button', detail: 'Import a template from a JSON file.', icon: 'Upload' },
        ],
      },
      {
        name: 'Environment Cards',
        position: 'Main area — Instances tab',
        items: [
          { label: 'Status dot', detail: 'Green = all services running. Yellow = partial. Red = crashed. Gray = stopped.' },
          { label: 'Service dots', detail: 'Colored dot + status label (running/stopped/crashed) for each service in the environment.' },
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
          { label: 'Commit Attribution', detail: 'Links git commits to the Colony session that made them. When any session exits, Colony scans the working directory for commits made since the session started and records them in ~/.claude-colony/commit-attribution.json. Shows hash, message, session name, and API cost.', icon: 'GitCommit' },
          { label: 'Clear button', detail: 'Delete all attribution records. The log is automatically capped at 200 entries.' },
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
        name: 'Webhook & API Section',
        position: 'Below Commit Attribution',
        items: [
          { label: 'Enable webhook server', detail: 'Starts an HTTP server on 127.0.0.1:<port> (default 7474). Required for both webhook pipeline triggers and the REST API.', icon: 'Globe' },
          { label: 'Port', detail: 'Port to listen on. Requires app restart to take effect. Default: 7474.' },
          { label: 'API URL', detail: 'Base URL for the Colony REST API (http://127.0.0.1:7474/api/). Click the copy button to copy it. Use GET /api/sessions, GET /api/pipelines, POST /api/sessions/:id/steer, POST /api/pipelines/:name/trigger, or GET /api/events (SSE stream). Protect with an API token via the apiToken setting.' },
          { label: 'GET /api/sessions', detail: 'Returns a list of all sessions: id, name, status, cost, uptime (ms). Filter by status client-side.' },
          { label: 'POST /api/pipelines/:name/trigger', detail: 'Trigger a named pipeline run immediately — same as clicking the Run button in the Pipelines panel. Name must match the pipeline file slug.' },
          { label: 'GET /api/events', detail: 'SSE stream of all Colony broadcast events (session updates, pipeline fires, activity). Connect with EventSource. Max 5 concurrent clients. Each message is JSON: { channel, data }.' },
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
          { label: 'List view toggle', detail: 'Switch between card view (expanded cards with session previews) and list view (compact one-row-per-persona table showing schedule, last run, and model at a glance). Preference is persisted.', icon: 'LayoutList' },
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
          { label: 'Weekly cost badge', detail: 'Small muted "$X.XX" badge shows the total Claude API cost for this persona\'s sessions in the last 7 days. Only appears when spend exceeds $0.01. The expanded card also shows "This week: $X.XX" in the status section.' },
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
          { label: 'History tab', detail: 'Switch to the History tab in an expanded card to see a timeline of past runs — timestamp, duration, cost, and success status. A 7-bar sparkline shows the cost trend for the most recent runs.', icon: 'Clock' },
          { label: 'Edit persona settings', detail: 'Click the Pencil icon (list view) to open a quick-edit modal for schedule, model, max sessions, and enabled state — without touching the raw markdown.', icon: 'Pencil' },
          { label: 'View File', detail: 'Open a read-only preview of the persona\'s raw markdown file.', icon: 'FileText' },
          { label: 'Edit File', detail: 'Open the persona\'s markdown file in a text editor. Edit any section and save — useful for updating Role, Objectives, or manually fixing the Active Situations block.', icon: 'Pencil' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+Shift+P', action: 'Run the first enabled idle persona from anywhere' },
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
          { label: 'Tab navigation', detail: 'Cmd+Shift+{ / Cmd+Shift+} cycles between Session, Terminal, Files, Replay, Changes tabs (and Services/Logs when an environment is attached).' },
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
          { label: 'Arena chip', detail: 'Shown in both split pane headers when Arena mode is active — confirms that the shared input bar below is routing to this session.' },
        ],
      },
      {
        name: 'Arena Mode',
        position: 'Split divider + bottom bar (split view only)',
        items: [
          { label: 'Arena toggle', detail: 'The "A" button on the split divider enables Arena mode. Hover the divider to reveal it. Click again to disable.' },
          { label: 'Blind Mode', detail: 'EyeOff button on the divider (visible when Arena mode is on) hides both session names — panes become "Pane A" and "Pane B". Vote buttons replace the trophy button. After voting, names are revealed and blind mode clears. Resets each time you send a new Arena prompt.', icon: 'EyeOff' },
          { label: 'Shared input bar', detail: 'When Arena mode is on, a shared textarea appears below both panes. Type a prompt and press Enter (or "Send to both") to send identical input to both sessions simultaneously. Shift+Enter adds a newline.' },
          { label: 'Pick winner', detail: 'Trophy button in each pane header — click to mark that session as the winner of the current round. Both buttons disable until the next prompt is sent. Win/loss totals are persisted across sessions.', icon: 'Trophy' },
          { label: 'Stats', detail: 'BarChart3 button in the Arena toolbar — shows win rates per session sorted by win percentage (e.g. "Colony QA: 5W / 2L (71%)").', icon: 'BarChart3' },
          { label: 'Use case', detail: 'Compare two models or personas on the same task — evaluate quality, speed, and approach side-by-side without typing twice.' },
        ],
      },
      {
        name: 'Status Strip',
        position: 'Below tab bar (running sessions only)',
        items: [
          { label: 'Activity dot', detail: 'Pulsing green = Running, amber = Waiting for input.' },
          { label: 'Model', detail: 'The Claude model in use (e.g. sonnet-4-6). Parsed from launch args.' },
          { label: 'Uptime', detail: 'Time since the session was created.' },
          { label: 'Cost', detail: 'Cumulative cost in USD. Green < $0.10, amber < $1.00, red ≥ $1.00.' },
          { label: 'Ctx indicator', detail: 'Amber = context ≥ 250 KB output, red ≥ 600 KB. Consider checkpointing.' },
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

  tasksBoard: {
    title: 'Shared Task Board',
    description: 'A shared coordination board backed by ~/.claude-colony/colony-tasks.json. All Colony personas and sessions can read and write tasks, making it a lightweight shared primitive for multi-agent workflows.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Active count', detail: 'Badge showing the number of tasks not yet Done.' },
          { label: 'Refresh', detail: 'Re-read the task board from disk.', icon: 'RefreshCw' },
          { label: 'Add task', detail: 'Open the new-task form. Fill in title, status, assignee, and optional tags/notes, then click Save.', icon: 'Plus' },
        ],
      },
      {
        name: 'Columns',
        position: 'Main area',
        items: [
          { label: 'To Do', detail: 'Tasks not yet started.' },
          { label: 'In Progress', detail: 'Tasks currently being worked on.' },
          { label: 'Blocked', detail: 'Tasks that are stuck and waiting on something.' },
          { label: 'Done', detail: 'Completed tasks. Only shown when at least one task is done.' },
          { label: 'Task card', detail: 'Click a card to expand it. Expanded cards show notes, last-updated time, and quick status-change buttons.' },
          { label: 'Edit task', detail: 'Pencil icon (hover to reveal) opens an inline edit form to change title, status, assignee, tags, or notes.', icon: 'Pencil' },
          { label: 'Delete task', detail: 'Trash icon (hover to reveal) deletes the task after confirmation.', icon: 'Trash2' },
        ],
      },
      {
        name: 'File Format',
        position: 'Background',
        items: [
          { label: 'colony-tasks.json', detail: 'Stored at ~/.claude-colony/colony-tasks.json. Can be written by any persona or external script. Supports an array of task objects or { tasks: [...] }.' },
          { label: 'Live updates', detail: 'The board watches the file for external changes and refreshes automatically when another agent writes to it.' },
        ],
      },
    ],
  },

  replayTab: {
    title: 'Replay (Tool Call Log)',
    description: 'Read-only audit trail of tool calls made during this session. Each entry shows the tool name, input arguments, and output summary. Useful for reviewing what Claude did step by step.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Refresh', detail: 'Reload the replay log from disk.', icon: 'RefreshCw' },
          { label: 'Auto-refresh', detail: 'While a session is running, the log auto-refreshes every 5 seconds to show the latest tool calls without manual intervention.' },
        ],
      },
      {
        name: 'Event List',
        position: 'Main area',
        items: [
          { label: 'Tool badge', detail: 'Blue badge showing the tool name (e.g. Read, Edit, Bash). Parsed from Claude CLI output.' },
          { label: 'Input summary', detail: 'Truncated summary of the tool\'s input arguments (up to 200 chars).' },
          { label: 'Timestamp', detail: 'Relative time since the tool call was made. Hover for the exact ISO timestamp.' },
          { label: 'Expand row', detail: 'Click any row to expand it and see the full input summary, output summary, and exact timestamp.' },
          { label: 'Output summary', detail: 'Truncated summary of the tool\'s output (up to 200 chars). Visible when the row is expanded.' },
          { label: 'Empty state', detail: 'Shows "No tool calls recorded yet" when Claude has not made any tool calls in this session, or when the session is brand new.' },
          { label: 'Event cap', detail: 'The log keeps at most 200 events per session. Older events are dropped once the cap is reached.' },
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
          { label: 'Markdown rendering', detail: 'Files ending in .md are rendered as formatted markdown. Other files (JSON, YAML, plain text) are shown as monospace raw text.' },
          { label: 'Size limit', detail: 'Files larger than 32KB are truncated with a notice at the end.' },
        ],
      },
    ],
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
          { label: 'File path', detail: 'Relative path of the changed file within the working directory.' },
          { label: '+/- counts', detail: 'Number of inserted lines (green) and deleted lines (red) in the diff.' },
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
  analytics: {
    title: 'Analytics Dashboard',
    description: 'ROI metrics, cost trends, and performance data for the last 7 days. Tracks session count, total spend, AI-attributed commits, and pipeline success rate across all personas and pipeline runs.',
    zones: [
      {
        name: 'Summary Tiles',
        position: 'Top section (4 tiles)',
        items: [
          { label: 'Sessions', detail: 'Total Claude sessions run (exited only). Compares against the 7 days prior to show trend.' },
          { label: 'Total Cost', detail: 'Sum of tokenUsage.cost from all exited sessions in the last 7 days. Shows delta from the previous 7-day period.' },
          { label: 'AI Commits', detail: 'Number of commits recorded in ~/.claude-colony/commit-attribution.json over the last 7 days. Shows percentage of total commits if available.' },
          { label: 'Pipeline Success', detail: 'Percentage of pipeline runs that completed successfully (status=success) in the last 7 days.' },
        ],
      },
      {
        name: 'Daily Cost Chart',
        position: 'Bar chart (7 bars)',
        items: [
          { label: 'Cost trend', detail: 'Visual representation of daily costs (oldest to newest). Height represents spending for that day. Hover for exact amount.' },
          { label: 'Day labels', detail: 'Shows "Today" for current day, then "1d", "2d", etc. for prior days.' },
        ],
      },
      {
        name: 'Top Spenders Table',
        position: 'Bottom section',
        items: [
          { label: 'Session/Persona name', detail: 'Name of the session or persona that consumed the most tokens.' },
          { label: 'Cost', detail: 'Total spend for that entity in the last 7 days. Up to top 5 spenders shown.' },
        ],
      },
    ],
  },
}
