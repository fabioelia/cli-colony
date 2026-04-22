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
  /** Optional keyboard shortcut hint (e.g. "⌘⇧F") */
  shortcut?: string
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
  navigation: {
    title: 'Navigation',
    description: 'The top bar shows up to 4 customizable tabs plus a More menu. Right-click any tab to move it to More, or right-click an item in More to pin it to the nav bar. Your layout is saved automatically.',
    zones: [
      {
        name: 'Primary Tabs',
        position: 'Top of sidebar',
        items: [
          { label: 'Home', detail: 'Colony overview — sessions, personas, pipelines, cost at a glance.', icon: 'Home' },
          { label: 'Sessions', detail: 'All Claude CLI sessions. Badge shows total count.', icon: 'TerminalSquare' },
          { label: 'Activity', detail: 'Live automation events. Badge shows unread count.', icon: 'Bell' },
          { label: 'Personas', detail: 'Autonomous AI agents with identity, goals, and memory.', icon: 'User' },
          { label: 'Customize', detail: 'Right-click any primary tab to move it to the More menu. Right-click any More item to pin it to the nav bar (replaces the last slot if full). At least one primary tab must remain. Layout persists in localStorage.' },
        ],
      },
      {
        name: 'More Menu',
        position: 'Popover from the ⋯ button',
        items: [
          { label: 'PRs', detail: 'GitHub pull requests, reviews, and comments.', icon: 'GitPullRequest' },
          { label: 'Review', detail: 'Cross-session diff review dashboard.', icon: 'GitCompare' },
          { label: 'Agents', detail: 'Browse and create agent definitions.', icon: 'Bot' },
          { label: 'Pipelines', detail: 'Automated triggers and actions.', icon: 'Zap' },
          { label: 'Tasks', detail: 'Task queues and batch execution.', icon: 'ListChecks' },
          { label: 'Environments', detail: 'Dev environment management.', icon: 'Server' },
          { label: 'Outputs', detail: 'Browse artifacts, briefs, and pipeline outputs.', icon: 'FolderOpen' },
          { label: 'History', detail: 'Past session artifacts — commits, changes, and costs.', icon: 'Archive' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Cmd+K', action: 'Open palette to navigate to any panel' },
    ],
  },
  activity: {
    title: 'Activity Feed',
    description: 'A live stream of automation events from personas, pipelines, environments, and sessions. Filter by source, level, or text to find specific events. Click session names to jump to the originating session.',
    zones: [
      {
        name: 'Filters',
        position: 'Top of panel',
        items: [
          { label: 'Source chips', detail: 'Toggle visibility of events by source: Persona, Pipeline, Environment, or Session. At least one must be active.' },
          { label: 'Level chips', detail: 'Toggle by severity: Info (normal), Warn (attention needed), Error (failures). Badges show counts.' },
          { label: 'Project chips', detail: 'When events span 2+ projects, a Project filter row appears. Click a chip to show only events from that project. Old events without project data appear under "unknown".' },
          { label: 'Search', detail: 'Free-text filter — matches against event name and summary.' },
          { label: 'Clear all', detail: 'Remove all activity events and reset the feed. Requires confirmation.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Pending Approvals',
        position: 'Below filters (when applicable)',
        items: [
          { label: 'Approval card', detail: 'Pipeline approval gates waiting for your decision. Shows pipeline name, summary, and plan preview.' },
          { label: 'Approve / Dismiss', detail: 'Accept or reject the pending action. Dismissed actions are skipped without firing.' },
          { label: 'Inline diff', detail: 'Expand a pending approval card to review the PR diff inline before approving.' },
        ],
      },
      {
        name: 'Event List',
        position: 'Main area',
        items: [
          { label: 'Event row', detail: 'Source badge (color-coded), name, relative timestamp, and summary. Click any event to navigate to its source — sessions open directly, pipeline/persona/environment events jump to the relevant panel.' },
          { label: 'Outcome stats', detail: 'For session completions: duration, commit count, and files changed.' },
        ],
      },
    ],
  },
  overview: {
    title: 'Colony Overview',
    description: 'A command-center view of your colony — running sessions, active personas, pipeline status, pending items, and recent activity. Appears when no session is selected.',
    zones: [
      {
        name: 'Stats Bar',
        position: 'Top of panel',
        items: [
          { label: 'Running Sessions', detail: 'Count of live sessions. Click to jump to the sessions list. When 2+ sessions are running, a model breakdown subtitle appears (e.g., "3 opus · 2 sonnet") for cost and rate-limit awareness.' },
          { label: 'Active Personas', detail: 'Personas currently executing a scheduled or manual run.' },
          { label: 'Pipelines Enabled', detail: 'Number of pipelines with automation turned on. A muted subtitle shows how long ago the most recent pipeline fired (e.g. "last 4m ago"). Hidden until at least one pipeline has fired.' },
          { label: 'Environments', detail: 'Running vs. total environment count. Amber when any environment is in partial/creating state, red when any is in error state. Click to navigate to the Environments panel.', icon: 'FolderOpen' },
          { label: 'Colony Health', detail: 'Composite health score (0–100%). Weighted: persona last-run success (35%), pipeline error-free (25%), session health (25%), environment health (15%). Green ≥80%, amber 50–79%, red <50%. Click to expand an inline breakdown showing each category with a progress bar and status dot. Click any row to navigate to that panel. Click the card again to collapse.' },
          { label: 'Session Cost', detail: 'Total cost across all current sessions.' },
          { label: 'Daily Cost (7d)', detail: 'A 7-day bar chart showing total cost across all persona runs per day. Hover a bar to see the exact date and amount. When a daily cost budget is set, a dashed line shows the threshold and any day exceeding 75% turns amber, exceeding 100% turns red.', icon: 'Activity' },
          { label: 'Top Spenders (7d)', detail: 'Ranked list of personas by 7-day cost. Shows persona name, percentage of total, a proportional bar, and dollar amount. Top 10 shown. Click any row to navigate to the Personas panel. Hidden when no persona has cost data.', icon: 'BarChart3' },
        ],
      },
      {
        name: 'Context Pressure',
        position: 'Above Needs Attention (when applicable)',
        items: [
          { label: 'Context Pressure section', detail: 'Shows running sessions approaching their context window limit (≥60% used). Color-coded: green (60–79%), amber (80–94%), red (≥95%). Sorted by percentage descending — most pressed first. Each row shows session name, percentage badge, and token count. Click a row to focus that session. Polls every 10 seconds. Hidden when no session exceeds 60%.', icon: 'Gauge' },
        ],
      },
      {
        name: 'Needs Attention',
        position: 'Below stats (when applicable)',
        items: [
          { label: 'Pending approvals', detail: 'Pipeline approval gates waiting for your decision. Approve or dismiss inline, or click the pipeline name to navigate.', icon: 'Zap' },
          { label: 'Pipeline errors', detail: 'Pipelines that encountered an error on their last run. The first line of the error message is shown inline as a muted subtitle below the pipeline name (truncated at 80 chars). Hover for the full error text. Inline Retry button triggers the pipeline immediately.', icon: 'AlertCircle' },
          { label: 'Blocked tasks', detail: 'Task board items marked as blocked. No inline action — unblocking requires manual judgment.', icon: 'Circle' },
          { label: 'Stale sessions', detail: 'Sessions that are marked "busy" but have produced no output for 15+ minutes. May indicate a stuck process or hung PTY. Inline Stop button kills the session. Click to navigate to the session terminal.', icon: 'Clock' },
          { label: 'Unhealthy environments', detail: 'Environments in error or partial state. Inline Restart button retries setup for error state or restarts services for partial state.', icon: 'AlertCircle' },
          { label: 'Failed persona runs', detail: 'Enabled personas whose last run failed. When available, shows the failure reason inline (e.g., "budget exceeded", "timed out", "stopped manually"). Inline Run Now button triggers a new run immediately. Click to navigate to the Personas panel. Capped at 5 entries.', icon: 'Users' },
          { label: 'Overdue personas', detail: "Enabled personas with a cron schedule whose last run timestamp is more than 2× their expected interval ago. For example, a persona scheduled every 15 minutes that hasn't run in 30+ minutes appears here. Shows \"No run for Xm (expected every Ym)\". Inline Run Now button triggers a one-off run immediately. Personas in cooldown (minIntervalMinutes > 0) are excluded if still within the cooldown window.", icon: 'Clock' },
          { label: 'Rate limit warning', detail: 'Appears when API rate limit utilization reaches 30% or higher. Amber at 70–89%, red at 90%+ or when paused. Shows utilization percentage, limit type, reset countdown, and burn-rate projection (~Nm to limit) when approaching the limit. Pulses when limit is projected within 30 minutes. Click to navigate to sessions. Colony-wide — reflects the shared API quota across all sessions.', icon: 'AlertCircle' },
          { label: 'Priority ordering', detail: 'Items are ordered by urgency: Rate limit (top, affects all sessions) → Errors (pipeline failures, unhealthy envs, failed personas) → Overdue personas → Pending approvals → Blocked tasks → Stale sessions (bottom, usually harmless). When 2+ categories are present, subtle group headers appear (e.g. "3 Errors", "2 Pending") so you can scan at a glance.' },
        ],
      },
      {
        name: 'Running Sessions',
        position: 'Middle',
        items: [
          { label: 'Session tile', detail: 'Click any session to focus it. Right-click for a context menu with Focus, Whisper (send a follow-up message), Stop, and Pin/Unpin actions. Shows name, activity status (busy/quiet/stale), role tag, model badge (e.g., "4.7", "sonnet", "haiku"), elapsed running time (e.g., "23m", "2h 15m"), and cost. Hover the model badge to see the full model ID. Hover the elapsed time to see the exact start timestamp. Quiet badge (amber, 5+ min no output) and stale badge (red, 15+ min) appear for busy sessions with no recent output. Files badge ("N files") appears on running sessions when there are uncommitted changes in the working directory — turns blue with a pulse when the count has grown since the last poll (every 30 s). Diff stats badge ("+X -Y" in green/red monospace) shows line-level insertions and deletions for uncommitted changes. Inline Stop button (square icon) halts the session directly from the overview — red hover indicates it\'s destructive.', icon: 'Play' },
          { label: 'Broadcast button', detail: 'Send the same message to all running sessions at once. Click "Broadcast" in the Running Sessions header, type your message, and click Send. Confirmation shows how many sessions received the message. Use this to redirect all agents when a priority changes or a rate limit is hit.', icon: 'MessageSquare' },
          { label: 'Waiting for Input section', detail: 'Sessions with activity "waiting" (finished processing, idle, waiting for user input) appear in a separate "Waiting for Input" section below Running Sessions. Each tile shows an inline message button (MessageSquare icon) — click it to send a message without navigating away. The stat card shows "N waiting" subtitle when any sessions are waiting.', icon: 'MessageSquare' },
        ],
      },
      {
        name: "Today's Output",
        position: 'Between Running Sessions and Active Personas',
        items: [
          { label: "Today's Output section", detail: "Aggregates all session artifacts from today: total commits, insertions/deletions, and number of sessions that produced output. Shows up to 8 most recent commits (hash + message + session name), newest first. Click any commit row to focus the originating session if it's still loaded. Refreshes every 30 seconds. Hidden when no artifacts have been collected today.", icon: 'GitCommit' },
          { label: 'Copy digest button', detail: 'Copy button on Today\'s Output copies a formatted markdown digest to clipboard — paste into Slack, standups, or status updates. Includes commit count, insertions/deletions, and the 8 most recent commits with session names.', icon: 'ClipboardCopy' },
        ],
      },
      {
        name: 'Active Personas',
        position: 'Between Today\'s Output and Just Finished',
        items: [
          { label: 'Persona row', detail: 'Each active persona shows name, model, elapsed time, and cost from its running session. Click to focus the session terminal directly. Stop button (square icon) halts the persona run.', icon: 'Users' },
        ],
      },
      {
        name: 'Just Finished',
        position: 'Between Running Sessions and Coming Up',
        items: [
          { label: 'Recently exited sessions', detail: 'Up to 5 most recently started sessions that have exited, sorted newest first. Each row shows success (green check) or failure (red X) status, session name, first 60 chars of exit summary, time since start, and cost if over $0.01. Source badges show how the session was launched: pipeline name (purple), "batch" (amber) for batch task sessions, or "child" for child sessions. Click any row to focus that session. Hidden when no exited sessions exist.', icon: 'CheckCircle2' },
          { label: 'Restart button', detail: 'Play button on each Just Finished row restarts the session (launches a new session in the same working directory). Shows a checkmark for 2 seconds after triggering. Does not navigate — row click still focuses the session.', icon: 'Play' },
          { label: 'Remove button', detail: 'Trash icon removes the session from the sidebar entirely. Shows a checkmark for 2 seconds after triggering. Does not navigate.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Environments',
        position: 'Between Active Personas and Running Batch',
        items: [
          { label: 'Environment row', detail: 'Shows each non-stopped environment with a status dot (green = running, amber = partial/creating, red = error), name, status badge, and running service count (e.g. "4/6 services"). Unhealthy environments sort to the top. Click any row to navigate to the Environments panel. Hidden when all environments are stopped.', icon: 'Server' },
        ],
      },
      {
        name: 'Running Batch',
        position: 'Between Environments and Just Finished',
        items: [
          { label: 'Running Batch section', detail: 'Appears when a task queue is executing. Shows progress (N/M tasks) and a live progress bar. Click to navigate to the Task Queues panel. Disappears automatically when the batch completes.', icon: 'Layers' },
        ],
      },
      {
        name: 'Coming Up',
        position: 'Below Active Personas',
        items: [
          { label: 'Upcoming runs', detail: 'Next 8 scheduled fires across enabled personas and pipelines, sorted by fire time ascending. Each row shows an icon (person = persona, zap = pipeline), name, countdown ("in 5m", "in 1h 30m"), model badge for personas, and estimated cost (~$X.XX) based on the 7-day average per run when available. Click any row to navigate to the respective panel. Play button triggers a persona or pipeline run immediately without waiting for the schedule. Refreshes every 60 seconds. Hidden when no scheduled items exist.', icon: 'Clock' },
          { label: 'Cluster warning badge', detail: 'Amber "N at once" badge appears next to the Coming Up heading when 3 or more runs are scheduled within the same 5-minute window. Hover for a tooltip explaining the rate-limit risk. Consider staggering schedules (e.g. */15, 1/15, 2/15) to spread load.', icon: 'AlertCircle' },
        ],
      },
      {
        name: 'Persona Briefs',
        position: 'Above Recent Activity',
        items: [
          { label: 'Persona Briefs section', detail: 'Collapsible section showing the most recent brief for each persona that has one. Each card shows persona name, color dot, last-updated time, and a 200-char preview. Click a card to expand the full brief (rendered as markdown). Enabled personas appear first sorted by last-updated time; disabled personas appear grayed out at the bottom. Polls every 60 seconds.', icon: 'FileText' },
          { label: 'Enable/disable toggle', detail: 'Toggle switch on the right side of each brief card header. Flips the persona enabled/disabled state immediately — same as the toggle in the Personas panel. Disabled cards appear grayed out.', icon: 'Play' },
          { label: 'Run Now button', detail: 'Play button next to the toggle. Launches a one-off run of the persona immediately. Only shown for enabled personas. Same as Run Now in the Personas panel.', icon: 'Play' },
        ],
      },
      {
        name: 'Recent Activity',
        position: 'Below running sessions',
        items: [
          { label: 'Date navigation', detail: 'Browse activity history day by day. Use ← / → arrows to move between days, or click "Today" to jump back. Activity events are persisted to daily log files and kept for 30 days.', icon: 'ChevronLeft' },
          { label: 'Summary line', detail: 'Shows total event count, error count, and warning count for the selected day at a glance.' },
          { label: 'Text search', detail: 'Free-text search across event names and summaries. Case-insensitive substring match. Combines with source and level filters (AND logic). Shows "No matching events" when results are empty.', icon: 'Search' },
          { label: 'Source filter chips', detail: 'Filter events by source: All, Persona, Pipeline, or Env. Chips are toggles — click to select one.' },
          { label: 'Level filter chips', detail: 'Filter by severity: All, Info, Warn, or Error. Warn and Error chips show badge counts when events exist. Filters combine with source filter (AND).' },
          { label: 'Project filter chips', detail: 'When activity events span 2 or more projects (e.g., newton, claude-electron), a project filter row appears. Click a chip to show only events from that project. Old events without project data appear under "unknown".' },
          { label: 'Show more', detail: 'Expands from 20 events (default) to 50. For today, the live ring buffer holds up to 100 events. Historical days load from daily log files with no cap.' },
          { label: 'Source icons', detail: 'Each activity item shows a source-specific icon: person icon for persona events, lightning for pipelines, terminal for sessions, server for environments. Icons use level-based coloring (default for info, amber for warn, red for error).', icon: 'Activity' },
          { label: 'Click to navigate', detail: 'Click any activity item to jump to its source — session events focus the session, persona/pipeline/env events navigate to the corresponding panel.' },
          { label: 'Export button', detail: 'Download icon in the activity section header exports the currently filtered events as a JSON file (colony-activity-YYYY-MM-DD.json). Disabled when no events match the current filter.', icon: 'Download' },
          { label: 'Live updates', detail: 'New events from personas, pipelines, and environments appear at the top in real-time, respecting active filters. Live updates only appear when viewing today.' },
          { label: 'Session outcome badges', detail: 'Session completion events show inline badges after the summary: clock icon + duration, commit icon + commit count (only when >0), and green cost badge (only when >$0). Lets you scan run results at a glance without opening persona analytics.', icon: 'Clock' },
        ],
      },
      {
        name: 'Knowledge',
        position: 'Below Recent Activity',
        items: [
          { label: 'Knowledge section', detail: 'Collapsible section showing all entries from the Colony Knowledge Base (~/.claude-colony/KNOWLEDGE.md). Personas write cross-cutting learnings here automatically. The entry count badge in the header shows the total number of entries. Click the section header to expand/collapse.', icon: 'BookOpen' },
          { label: 'Entry rows', detail: 'Each entry shows the date, persona source (e.g. "Colony Developer"), and the knowledge text. Hover a row to reveal the delete button (×). Deleted entries are permanently removed from KNOWLEDGE.md.' },
          { label: 'Add Entry', detail: 'Text input at the top of the section. Type a fact or observation and press Enter (or the send button) to append it. New entries are tagged with today\'s date and "User" as the source — e.g. "[2026-04-22 | User] fact here". Added immediately to the list.' },
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
        name: 'Board Tab',
        position: 'Tab bar — "Board"',
        items: [
          { label: 'Session Board View', detail: 'Kanban-style board showing all sessions organized into three columns: Running (actively executing), Waiting (idle, awaiting input), and Stopped (exited). Each column header shows the session count. Board tab preference is remembered across reloads.', icon: 'LayoutGrid' },
          { label: 'Session card', detail: 'Each card shows: a colored dot (session color), session name, model badge (e.g. "sonnet", "4.7"), cost badge, and elapsed time or time since exit. Running persona sessions also show the current working status one-liner when available. Click any card to focus that session. Right-click for the same context menu as the sidebar (Focus, Whisper, Stop, Pin/Unpin).' },
          { label: 'Attention borders', detail: 'Stale sessions (busy but no output for 15+ min) get an amber left border. Sessions that exited with a non-zero exit code get a red left border — making errors easy to spot at a glance.' },
          { label: 'Stopped column', detail: 'The Stopped column is capped at 20 most recent sessions. A "Show all N stopped sessions" button expands the list when there are more than 20.' },
        ],
      },
      {
        name: 'Timeline Tab',
        position: 'Tab bar — "Timeline"',
        items: [
          { label: 'Session Timeline', detail: 'Gantt-style horizontal chart showing when sessions ran during the selected day. Each bar spans start → end, colored by session color. SVG bezier arrows connect parent→child sessions in trigger chains. Copy button (clipboard icon) in the nav bar exports all visible bars as a markdown table (session name, persona, start/end times, duration, cost, commits, files) — paste into Slack, PRs, or status updates.' },
          { label: 'Dependency arrows', detail: 'Curved arrows connect parent sessions to child sessions they triggered. Hover any bar in a chain to highlight the entire chain and dim unrelated sessions.' },
          { label: 'Day navigation', detail: 'Use ← / → arrows to browse past days. "Today" button jumps back to the current day.' },
          { label: 'Summary strip', detail: 'Shows total sessions, compute time, cost, and commit count for the selected day.' },
          { label: '"Now" line', detail: 'Red dashed vertical line marking the current time (today only).' },
          { label: 'Running sessions', detail: 'Bars for running sessions pulse and extend to the current time, updating every 30 seconds.' },
          { label: 'Click to focus', detail: 'Click any session bar to focus that session in the sidebar (if still alive).' },
        ],
      },
      {
        name: 'Changes Tab',
        position: 'Tab bar — "Changes"',
        items: [
          { label: 'Cross-session diff view', detail: 'Aggregates all file changes committed by sessions within the selected timeframe. Lets you see what Colony actually changed across all sessions without clicking into each one individually.', icon: 'GitCompareArrows' },
          { label: 'Timeframe selector', detail: 'Filter by last 4h, 12h, 24h, or 7d. Default is 24h. Artifacts are filtered by their collection timestamp.', icon: 'Clock' },
          { label: 'Summary bar', detail: 'Shows total files changed, number of contributing sessions, and aggregate +additions / -deletions across the selected timeframe.' },
          { label: 'File rows', detail: 'Each row shows the file path, net +additions/-deletions, and attribution chips for the sessions that touched it. Click to expand and see the inline diff.' },
          { label: 'Multi-touch badge', detail: 'Files touched by more than one session show an amber "N sessions" badge. Useful for spotting coordination or conflicts.', icon: 'Users' },
          { label: 'Inline diff', detail: 'Expanding a file row fetches and renders the actual git diff for that file across the contributing commits. Uses the same DiffViewer as the Review and Changes panels — supports unified/split view toggle.' },
          { label: 'Project grouping', detail: 'When sessions span multiple projects (different working directories), files are grouped by project with a subtle header.' },
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
          { label: '+ New Session', detail: 'Opens a dialog to create a Claude CLI session. Set a name, working directory, color, model, agent, CLI backend, permission mode, optional CLI args, MCP servers, and custom environment variables. Includes a collapsible "First prompt" field to seed the session with a task. Keyboard shortcut: Cmd+N.', icon: 'Plus' },
          { label: 'Model picker', detail: 'Dedicated dropdown to select the Claude model (Opus, Sonnet, Haiku) instead of typing --model in CLI args. When cloning a session, the model is extracted from args and pre-selected.' },
          { label: 'Environment Variables', detail: 'Set custom environment variables (API keys, debug flags) for a session. Expand the collapsible section, add KEY=value rows. Variables are merged on top of your shell environment so session-specific overrides work without polluting your profile.' },
          { label: 'Plan first', detail: 'When a first prompt is set, toggle "Plan first" to make Claude outline its approach (files to modify, steps, risks) and wait for your approval before taking any action. Useful for complex tasks where you want to review the strategy before committing tokens. Works with both the dialog and session templates.', icon: 'ListChecks' },
          { label: 'First prompt', detail: 'Collapsible textarea for seeding a session with a task. Click the "First prompt" toggle to expand. When cloning a session or launching from a starter card, it opens automatically. The prompt runs as soon as the session is ready; leave blank to start idle.', icon: 'ChevronRight' },
          { label: 'Prompt history', detail: 'When the "First prompt" field is expanded, a History button appears next to the label. Click it to see your last 20 session prompts with timestamps. Click an entry to fill the textarea. History is saved automatically on session creation and stored in localStorage.', icon: 'Clock' },
          { label: 'Attach JIRA Ticket', detail: 'Attach a JIRA ticket by key (e.g. NP-7663) and its title + description will be prepended to your prompt. Type the key and press Enter or leave the field — the ticket is fetched and a preview shown. Click "My Tickets" to open a picker of your open assigned tickets (sorted by recently updated) — select one to auto-fill the key. Clicking an environment chip whose branch contains a ticket key (e.g. NP-7663/feature-name) auto-fills the key too. Requires Jira credentials in Settings → Integrations.', icon: 'Link' },
          { label: 'Restore banner', detail: 'After app restart, shows a button to restore sessions from your last run. Opens a dialog where you can search by name or directory, see how long each session was running, and select which to restore. Select All toggles only the visible (filtered) sessions.', icon: 'RotateCcw' },
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
          { label: 'Clear project filter', detail: 'Remove the active project filter and show sessions from all repositories. Appears as an X button next to the project filter dropdown.', icon: 'X' },
          { label: 'Stopped sessions', detail: 'Dimmed with exit code. Auto-cleaned after 5 minutes (configurable in Settings). "Clear all" appears on the Stopped divider when 2+ sessions are stopped.' },
          { label: 'Session notes', detail: 'Right-click a session → Add Note to annotate it with freeform text (e.g., "waiting for CI", "investigating auth bug"). Notes appear as an italic subtitle under the session name. Edit or clear via the same menu. Max 500 characters.' },
          { label: 'Pin to top', detail: 'Right-click a session to pin it. Pinned sessions stay at the top and are restored on launch.', icon: 'Pin' },
          { label: 'Export Handoff Doc', detail: 'Generates a markdown snapshot of the session — git commits, terminal output, and metadata including cost, duration, token usage, model, role, and permission mode. Edit the content before copying or launching. Click "Launch New Session" to create a new session pre-filled with the handoff document and the same working directory. Click "✨ Generate Summary" to replace the raw terminal snapshot with an AI-generated summary.', icon: 'FileDown' },
          { label: 'Clone session', detail: 'Right-click a session → Clone to create a new session pre-filled with the same name, working directory, color, CLI backend, permission mode, MCP servers, agent, and extra args. The name gets a "(2)" suffix. Useful for re-running a task with tweaks or retrying a failed approach.', icon: 'Copy' },
          { label: 'Review with...', detail: 'Right-click any session with a working directory → Review with... to launch a second-opinion review session using a different model (Opus 4, Sonnet 4.6, or Haiku 4.5 — the session\'s own model is excluded). The review session receives the current git diff as context and a focused review prompt, runs non-interactively, and is linked to the original via a parent badge in the sidebar.', icon: 'Cpu' },
          { label: 'Export to Markdown', detail: 'Right-click a session → Export Markdown copies a structured markdown summary to clipboard (name, date, duration, cost, branch, prompt, commits, and per-file diffs). Hold Shift+click to save as a .md file instead. Works for both running and completed sessions.', icon: 'FileDown' },
          { label: 'Session Templates', detail: 'Save and reuse full session configurations. Right-click a session → Save as Template to capture name, working directory, role, model, color, CLI backend, MCP servers, and agent. Edit templates in Settings to change any field including color, MCP servers, agent, and environment variables.', icon: 'BookTemplate' },
          { label: 'Save as Pipeline', detail: 'Right-click a stopped session → Save as Pipeline to generate a disabled pipeline YAML from the session\'s prompt, model, and working directory. Colony navigates to the Pipelines panel automatically so you can edit the cron schedule and enable it. The pipeline is created in disabled state so it won\'t fire immediately.', icon: 'Zap' },
          { label: 'Context budget badge', detail: 'Amber "ctx" badge when a session has generated significant output (context building up). Red when near the limit. Click to open the Handoff Doc export to capture a snapshot before the session reaches its context limit.' },
          { label: 'File conflict badge', detail: 'Amber warning badge with file count appears when another running session in the same directory and branch has uncommitted changes to the same file(s). Hover to see which files overlap and which sessions they conflict with. Checked every 30 seconds. Disappears when the overlap resolves (session exits or files are committed).', icon: 'AlertTriangle' },
          { label: 'Role badge', detail: 'Purple/gold tag (Orchestrator, Planner, Coder, Tester, Reviewer, Researcher, Coordinator, Worker) set via right-click. Coordinator shows a gold Crown icon 👑. Helps coordinate multi-agent workflows at a glance. Coordinator sessions display a Team tab showing all active Worker sessions.' },
          { label: 'Split/Grid indicator', detail: 'A columns icon appears on sessions in a split view or grid view. In grid mode, all assigned panes show the indicator.', icon: 'Columns2' },
          { label: 'Group by', detail: 'A grouping selector appears above the session history list. Group by Persona, Project (working directory), Status, or Pipeline. Pipeline grouping shows sessions under their pipeline run with an aggregate status dot (green = all done, blue = running, red = failed). Non-pipeline sessions appear under "Manual Sessions". Groups are collapsible and the mode persists across sessions.', icon: 'Layers' },
          { label: 'Collapse/Expand All', detail: 'Toggle all session group headers collapsed or expanded at once. Appears when sessions are grouped by persona, project, status, or pipeline.', icon: 'ChevronsUp' },
          { label: 'Cost badge', detail: 'Green badge showing the session\'s API cost (e.g. "$0.42"). Only appears when cost exceeds $0.001. Hover for full precision.' },
          { label: 'Group cost badge', detail: 'Group headers show a green cost badge (e.g. "$4.23") next to the session count when the group total exceeds $0.01. Hover for exact total. Works for all group modes.' },
          { label: 'Group quick actions', detail: 'Hover a group header and click the ⋯ icon (or right-click the header) to open a menu of group-scoped actions: Stop All (halts all running sessions — asks confirmation if >3), Remove Stopped (removes all non-running sessions), Send Prompt… (broadcasts a message to all running sessions), and Collapse Others (collapses all other groups). Send Prompt opens an inline textarea — Enter to send, Shift+Enter for newline, Esc to cancel. Right-clicking the History tab group headers collapses all other groups instantly.', icon: 'MoreHorizontal' },
          { label: 'Drag to reorder', detail: 'Drag sessions to rearrange them in the sidebar. Custom order persists across restarts. Only available when group-by is set to "none". A reset button appears to return to the default sort (pinned → running → stopped).' },
          { label: 'Sort sessions', detail: 'The sort button (ArrowUpDown icon) cycles through sort modes: Recent (default, creation order), Name (alphabetical), Cost (highest first), Duration (longest running first). Sort applies within each group (pinned / running / stopped). Preference persists across restarts. Hidden when custom drag order is active.', icon: 'ArrowUpDown' },
          { label: 'Hover preview', detail: 'Hover over a sidebar session tile for 500ms to see a floating card showing the last 10 lines of terminal output. Card disappears on mouse leave. Useful for checking session status without switching context.' },
          { label: 'Filter chips', detail: 'Below the group-by controls (when 3+ sessions exist), chip buttons let you filter the visible session list. "Running" / "Stopped" chips toggle status filters (multiple can be active at once). A persona dropdown filters to sessions from a specific persona. Pinned sessions always show regardless of filters. When filters are active, a count badge ("3 of 12") and a "Clear" button appear. Filter state persists across restarts.' },
          { label: 'Multi-select', detail: 'Click the checkbox icon (next to group-by) or Cmd+click any session to enter select mode. Shift+click to select a contiguous range from the last-clicked session. A floating action bar appears for bulk Send Prompt, Stop, Restart, or Remove. Send Prompt opens an inline textarea to broadcast a message to all selected running sessions. Cmd+A selects all visible sessions; Escape exits. Remove only affects stopped sessions.', icon: 'CheckSquare' },
          { label: 'Permission mode', detail: 'Choose Autonomous (full permissions, default), Auto (AI classifier auto-approves safe actions while gating dangerous ones — research preview), or Supervised (Claude asks before every risky action) when creating a session. Supervised sessions show a shield icon in the sidebar.', icon: 'Shield' },
          { label: 'Global Search', detail: 'Search across all sessions\' terminal output. Find which session produced an error or output. Opens a side panel with results grouped by session. Use ↑↓ to navigate results, Enter to jump to the matching session. Hover a match to reveal a copy button for the matched text.', shortcut: '\u2318\u21e7F', icon: 'Search' },
          { label: 'Shortcut numbers', detail: 'Numbers 1-9 shown next to sessions for quick Cmd+N jumping.' },
          { label: 'Trigger chain', detail: 'Click the info icon on a session that has a parent or children to see its full trigger chain — the tree of sessions that spawned from the same root. Click any node to navigate to that session. Useful for tracing persona orchestration chains.', icon: 'Info' },
          { label: 'Parent/child navigation', detail: 'Click the ↳ arrow on child sessions to jump to the parent, or click "N children" on parent sessions to jump to the first child.' },
          { label: 'Repo Memory', detail: 'Place a `.colony/memory.md` file in a repo to automatically inject its conventions, architecture decisions, and team notes into every Colony session started in that directory. Same pattern as AGENTS.md — no UI needed.' },
          { label: 'Send Message', detail: 'Right-click a waiting session to send a prompt to it without switching views. Useful for orchestrating multiple parallel sessions.', icon: 'Send' },
          { label: 'Model badge', detail: 'Shows which Claude model a session is using (4.7, 4.6, sonnet, haiku). Only appears when --model is explicitly set. Hover to see the full model string. Hidden when using your default model.' },
          { label: 'Quiet / Stale detection', detail: 'Sessions marked "busy" that produce no output for 5+ minutes show an amber "quiet" badge. After 15+ minutes with no output, the badge turns red and says "stale". Stale sessions also appear in the Overview\'s Needs Attention section. Only applies to busy sessions — waiting sessions are excluded. Hover the badge to see exact idle duration. Desktop notification fires when a session has no output for 15 minutes (stuck detection); a second fires at 30 minutes.' },
          { label: 'Exit duration', detail: 'Exited sessions show how long they ran (e.g., "45m", "2h 15m") next to the exit status. Hidden for sessions with no artifact data.' },
          { label: 'Jira ticket badge', detail: 'Sessions started with a Jira ticket attached show a blue NP-XXXX badge on the sidebar tile. Hover to see the ticket summary. Click the badge to open the ticket in your browser. Hidden when no ticket is attached.' },
          { label: 'Pipeline source badge', detail: 'Amber Zap badge showing which pipeline spawned this session. Only appears on pipeline-automated sessions. Hover for the full pipeline name. Helps distinguish automated from manual sessions, especially when not grouped by pipeline.', icon: 'Zap' },
          { label: 'Triggered-by badge', detail: 'Purple arrow + persona name badge on sessions launched by one persona triggering another (via on_complete_run or can_invoke chains). Click the badge to filter the sidebar to show sessions from the triggering persona, making it easy to trace multi-persona execution chains.', icon: 'ArrowLeft' },
          { label: 'Branch badge', detail: 'Session tiles show an inline GitBranch badge when the session\'s working directory is on a non-default branch (anything except main, master, develop). Badge is in monospace, truncated at 20 chars. Click to copy the full branch name to clipboard. Useful when working across multiple feature branches or worktrees at once.', icon: 'GitBranch' },
          { label: 'Output Alert badge', detail: 'Sessions with active output alerts show an AlertCircle badge with the number of active alerts. Right-click a session → Add Output Alert… to configure a pattern (plain text or regex) that triggers a desktop notification when matched in the session\'s output. One-shot alerts fire once and are removed; persistent alerts stay active until the session exits.', icon: 'AlertCircle' },
          { label: 'Add Output Alert', detail: 'Right-click any session → "Add Output Alert…" to define a pattern. Use Quick Presets (Build Success, Test Failure, Error, Deploy Complete) to fill common patterns instantly, or type your own. Choose Regex mode for advanced matching (case-insensitive). Enable One-shot to receive a single notification and auto-remove the alert. Multiple alerts can be active on the same session simultaneously.', icon: 'AlertCircle' },
        ],
      },
      {
        name: 'Sidebar Tabs',
        position: 'Below session list',
        items: [
          { label: 'Active tab', detail: 'Shows running sessions. This is the default view.' },
          { label: 'History tab', detail: 'Browse past Claude CLI conversations from ~/.claude/. Click to resume — detects already-running sessions.' },
          { label: 'External tab', detail: 'Detects Claude CLI processes running outside Colony (VS Code, terminal). Preview messages and take over.' },
          { label: 'Tags', detail: 'Right-click a session to add tags. Filter by tag using the Tags dropdown. Tags are color-coded and stored locally.', icon: 'Tag' },
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
          { label: 'Trigger chain breadcrumb', detail: 'When a session was triggered by another persona (e.g., Colony Product → Colony Developer), a compact breadcrumb appears on the right side of the status strip showing the full chain. Ancestor names are clickable buttons — click to navigate to that session. Child sessions (sessions this one triggered) appear after the current session\'s name with → arrows. Hover the breadcrumb for the full tooltip. Depth limit is 10 to prevent circular trigger loops.', icon: 'ArrowRight' },
        ],
      },
      {
        name: 'Footer',
        position: 'Bottom of sidebar',
        items: [
          { label: 'Help icon', detail: 'Opens this help popover.', icon: 'HelpCircle' },
          { label: 'Activity bell', detail: 'Shows recent automation events from personas, pipelines, environments, and sessions. Persona completion events include outcome stats: duration, commits made, and files changed. Turns amber when pipeline actions are waiting for approval.', icon: 'Bell' },
          { label: 'Notification history', detail: 'Persistent log of all desktop notifications — what happened while you were away. Grouped by Today/Yesterday/Older. Filter by source type (Pipeline, Persona, Session, Approval, Budget, Environment, System) using the chip bar. Click an entry to navigate to its source. Red badge shows unread count. Persists across app restarts.', icon: 'BellRing' },
          { label: 'Rate-limit chip', detail: 'Shows current API rate-limit utilization when ≥30% (from probe data). Amber at 70%, red at 90%. Format: "RL 58% · 32m" — percentage plus minutes until reset window. Click to open Overview. Hidden when Colony is paused (banner takes over).', icon: 'Activity' },
          { label: 'Usage meter', detail: 'Shows today\'s persona cost vs daily budget. Green (<75%), amber (75-99%), red (≥100%). When no budget is set, shows just the dollar amount. Pulses red when rate-limited. Click to open Overview for the full cost chart. Updates hourly.', icon: 'DollarSign' },
          { label: 'Workspace presets', detail: 'Save and restore workspace layouts (sidebar view, layout mode, sidebar width). Ships with 3 built-in presets: Monitor, Review, Compare. Cmd+Shift+1-5 for quick-switch.', icon: 'LayoutGrid' },
          { label: 'Settings gear', detail: 'Opens the Settings panel for CLI defaults, shell profile, daemon management, and more.', icon: 'Settings' },
          { label: 'Focus mode', detail: 'Cmd+B hides the sidebar for a distraction-free view. The main content expands to full width. Press Cmd+B, Esc, or hover the top-left button to restore.', icon: 'PanelLeft' },
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
      { keys: 'Cmd+K', action: 'Command palette — switch sessions, run personas, launch agents, launch templates, navigate panels, search session history. When a session is active, a "Current Session" section appears with export, clone, fork, pin/unpin, rename, and open-in-Finder actions. Shows shortcut hints inline and recent commands at the top' },
      { keys: 'Cmd+P', action: 'File quick-open — fuzzy search across all env repos (type characters in order, gaps allowed — VS Code style). [alias] badge on sibling roots. ↑↓ to navigate, Enter to open, ESC to dismiss' },
      { keys: 'Cmd+Shift+↵', action: 'Quick Prompt — launch a new session with a prompt pre-filled; ↑↓ to cycle history; save frequently-used prompts as named snippets; filter snippets by name; edit existing snippets in-place; drag files onto the prompt textarea to embed their content as code blocks (50KB limit, sensitive paths rejected)' },
      { keys: 'Cmd+Shift+1–5', action: 'Load workspace preset by position' },
      { keys: 'Cmd+Click', action: 'Enter multi-select mode and toggle session' },
      { keys: 'Shift+Click', action: 'Select range of sessions from last-clicked (in select mode)' },
      { keys: 'Cmd+A', action: 'Select all visible sessions (in select mode)' },
      { keys: 'Escape', action: 'Exit multi-select mode' },
      { keys: 'Cmd+Alt+←/→', action: 'Focus history — navigate back/forward through recently viewed sessions (like browser back/forward)' },
      { keys: 'Cmd+/', action: 'Show all keyboard shortcuts' },
      { keys: 'Cmd+B', action: 'Toggle focus mode — hide the sidebar for a distraction-free view. Press Cmd+B or Esc to restore' },
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
          { label: 'Search', detail: 'Filter agents by name or description. Searches across personal and all project agent groups.', icon: 'Search' },
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
          { label: 'Duplicate button', detail: 'Clone the agent file with "(copy)" appended to the name. Opens the copy in the editor for customization.', icon: 'Copy' },
          { label: 'Delete button', detail: 'Permanently deletes the agent definition file after confirmation. Cannot be undone.', icon: 'Trash2' },
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
          { label: 'Merge button', detail: 'Appears next to the "Ready" badge when a PR is approved and CI passes. Click to choose a merge method (Squash, Merge commit, or Rebase). The PR list refreshes automatically after a successful merge.', icon: 'GitMerge' },
          { label: 'Batch merge', detail: 'Select multiple non-draft PRs using the checkboxes on each row. When 2 or more are selected, a batch bar appears with a "Merge N PRs" button. Click it to open the batch merge dialog — pick a merge method, then merge all selected PRs in sequence. Each PR shows a live pending/success/error status. Failed PRs are skipped without blocking others. A select-all checkbox appears above the list when a repo has multiple merge-ready PRs.' },
          { label: 'Review Requested', detail: 'Amber badge appears when your review is requested on a PR.', icon: 'Eye' },
          { label: 'Feedback badge', detail: 'Shows Colony Feedback status: amber = feedback pending, green = new commits since review (ready for re-review).', icon: 'MessageSquare' },
          { label: 'Jira ticket chip', detail: 'When a PR title contains a Jira ticket key (e.g. NP-1234), a blue chip appears below the title showing the key and summary. Click the chip to open the ticket in your browser. Requires Jira credentials in Settings → Integrations. Customize the key pattern with the jiraTicketKeyPattern setting.' },
          { label: 'CI badges', detail: 'Green/red/yellow CI badge shows GitHub Actions check status. Click any CI badge to toggle an inline check panel below the PR row — shows each check name, status icon, and conclusion. For failed checks, click "View logs" to fetch and display failure annotations inline in a scrollable log block. Use the refresh icon to re-fetch or × to close. No need to open the full PR description.', icon: 'CheckCircle' },
          { label: 'Dispatch button', detail: 'Send this PR as a note to a persona. Pick a persona and add optional context — the note appears in the persona\'s ## Notes section on its next run.', icon: 'UserPlus' },
          { label: 'Colony Review', detail: 'Launches a Claude session that reviews the code and pushes structured feedback to the colony-feedback branch.', icon: 'Play' },
          { label: 'Quick actions', detail: 'Buttons (Review, Summarize, Checkout & Test). Click any button to open the environment selector modal.', icon: 'Play' },
          { label: 'File diffs', detail: 'Click "Files changed" to fetch and display per-file diffs with syntax highlighting. A toolbar shows file summary (3A 7M 2D), search input to filter by filename, status filter chips (A/M/D/R), and Expand All / Collapse All buttons. PR review comments appear inline at the relevant line position in both unified and split diff modes. Comment count badge shown on file headers.', icon: 'FileDiff' },
          { label: 'Inline comment (+)', detail: 'Hover any diff line to reveal a "+" button in the gutter. Click it to open a textarea directly below that line. Type your review comment and click Comment to post it via the GitHub API. The comment appears immediately inline. Cancel with the Cancel button or press Escape.', icon: 'Plus' },
          { label: 'Reply to comment', detail: 'Each inline comment thread shows a Reply link below the last comment. Click it to open a compact textarea and post a reply directly in the same thread.', icon: 'MessageSquare' },
          { label: 'Comments', detail: 'Click to view all PR comments (general + file-level) in a split modal with markdown rendering. The modal includes a reply input at the bottom to post responses directly.', icon: 'MessageSquare' },
          { label: 'Post comment', detail: 'Type in the comment box on an expanded PR and click Comment to post a general PR comment via the GitHub API. Uses your authenticated gh CLI identity.', icon: 'Send' },
          { label: 'Submit review', detail: 'Approve or request changes on a PR directly from the app. Approve sends immediately; Request Changes opens a textarea for your review body (required). Review status updates in-place after submission.', icon: 'ShieldCheck' },
          { label: 'Ready for Review', detail: 'Draft PRs you authored show a green "Ready for Review" button. Clicking it calls the GitHub API to convert the draft to a full PR — the draft badge disappears immediately. Only your own draft PRs show this button.', icon: 'Eye' },
          { label: 'Request reviewer', detail: 'Click the UserPlus icon (visible on hover) to open a reviewer picker. The list shows known collaborators from other PRs. Already-assigned reviewers are excluded. Selecting a reviewer calls the GitHub API immediately and refreshes the PR list.', icon: 'UserPlus' },
          { label: 'Close PR', detail: 'Click the X icon (visible on hover) to close a PR without merging. A confirmation popover appears with an optional "Also delete branch" checkbox. Closed PRs are removed from the list on next refresh.', icon: 'X' },
          { label: 'Edit PR title', detail: 'Click the PR title text to enter inline edit mode. Type to change the title and press Enter to save, or Escape to cancel. Changes are saved via the GitHub API immediately.', icon: 'Pencil' },
          { label: 'Edit description', detail: 'In the expanded PR card, click "Edit description" below the PR body to enter a textarea editor. Click Save to update via the GitHub API, or Cancel to discard changes.', icon: 'Pencil' },
          { label: 'Test in Environment', detail: 'Launch a new environment pre-filled with the PR\'s branch. Opens the New Environment dialog with the branch field populated.', icon: 'GitBranch' },
          { label: 'Colony review notes', detail: 'When a Colony persona reviews a PR, their analysis is saved locally. If notes exist for a PR, they appear as a collapsible section in the expanded PR card. Click the header to collapse/expand.', icon: 'Brain' },
        ],
      },
      {
        name: 'Prompt Actions',
        position: 'Environment selector modal',
        items: [
          { label: 'Swap worktree in running env', detail: 'Fastest option (~5s). Creates a worktree from the PR branch and hot-swaps it into a running environment. Services restart automatically. Requires at least one running environment.', icon: 'GitBranch' },
          { label: 'Create new environment', detail: 'Set up a fresh instance with all dependencies. Takes 30–60s to initialize. Launches a full environment from scratch.' },
          { label: 'Continue in existing session', detail: 'Send the prompt to an already-running session (instant). Shows session name, status, age, and cost. Choose this if you\'re testing multiple PRs in the same context.' },
          { label: 'Environment dropdown', detail: 'When swapping worktrees, lists running environments with branch info and service counts. Only running environments can accept hot-swaps.' },
          { label: 'Session dropdown', detail: 'When continuing in an existing session, lists running sessions. Each entry shows the session name, status, how long it\'s been running, and its current cost.' },
          { label: 'Time estimates', detail: 'Each option shows estimated setup time: ~5s for worktree swap, ~60s for new environment, instant for session reuse.' },
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
          { label: 'Health view', detail: 'Toggle a compact health dashboard showing all pipelines in one table — name, enabled status, last fired, fire count, consecutive failures, success rate (last 10 runs), and last error. Sorted by failures first. Click a row to jump to that pipeline. Problems (consecutive failures > 0) appear at the top in red.', icon: 'Activity' },
          { label: 'Topology map', detail: 'Toggle a visual DAG of pipeline→pipeline trigger chains. Nodes are connected pipelines; edges show which pipeline triggers which via trigger_pipeline actions. Cycle detection highlights circular chains in red. Click any node to jump to that pipeline. Zoom with Cmd+scroll or the ± buttons. Hidden when no trigger_pipeline connections exist.', icon: 'Network' },
          { label: 'Schedule heatmap', detail: 'Toggle a 24-hour heatmap showing when each cron-scheduled pipeline fires. Vertical bars are scheduled fire times; filled circles are actual runs (green = on time, amber = late >2min, red = failed). Navigate days with ← / → arrows. Overlap bands highlight minutes where 3+ pipelines fire simultaneously — useful for identifying rate-limit pressure. Git-poll and file-poll pipelines are excluded. Mutually exclusive with health view and topology map.', icon: 'CalendarDays' },
          { label: 'List/card toggle', detail: 'Switch between compact list rows and card view. Hidden when health view is active. Preference is saved per device.', icon: 'LayoutList' },
          { label: 'Search', detail: 'Filter pipelines by name. Applies to both list/card view and health table. Clear the field to show all.', icon: 'Search' },
          { label: 'Sort', detail: 'Reorder pipelines by name, last fired time, fire count, enabled status, or success rate (problem pipelines first). Hidden when health view is active. Your choice is saved.', icon: 'ArrowUpDown' },
          { label: 'Export', detail: 'Download all pipeline YAML files (and companion memory/readme files) as a zip archive.', icon: 'Download' },
          { label: 'Import', detail: 'Import pipeline YAML files from a zip archive. Runtime state files are excluded.', icon: 'Upload' },
          { label: 'Paste YAML', detail: 'Paste raw YAML text to import a pipeline directly — no file needed. Click the paste icon in the header, paste your YAML, and click Import. The pipeline name is read from the "name:" field in the YAML. Useful for sharing pipelines via chat or documentation.', icon: 'ClipboardPaste' },
          { label: 'Reload button', detail: 'Re-read all pipeline YAML files from disk. Icon spins and label shows "Reloading…" during the scan, then flashes green "Reloaded" for ~1s on success.', icon: 'RefreshCw' },
          { label: 'Rules button', detail: 'Opens the learned review rules panel — a list of quality patterns discovered automatically from approved maker-checker runs. Each rule shows its severity (error/warning/info), the pattern text, the repo scope, and where it came from. Rules are injected into maker and checker prompts on every run so review quality improves over time. Click the X on any rule to remove it. Rules are stored in ~/.claude-colony/review-rules.json.', icon: 'BookOpen' },
          { label: 'Audit button', detail: 'Run an AI audit of all pipelines. Claude reviews each pipeline\'s YAML, error history, and configuration and returns a list of HIGH/MEDIUM/LOW findings. Each finding with a clear fix has a Fix button that opens the editor or applies the fix directly. Badge shows issue count from the last audit.', icon: 'ShieldCheck' },
          { label: 'Pause All / Resume All', detail: 'Globally pause or resume all cron-triggered pipelines and persona schedules. When paused, an amber banner appears at the top of the app and all cron next-run countdowns show "Paused (manual)". Git-poll and file-poll pipelines are not affected. Independent from the automatic rate-limit pause.', icon: 'PauseCircle' },
          { label: 'Select (bulk actions)', detail: 'Enter selection mode to bulk-manage pipelines. Click the checkbox icon in the header, or shift-click any pipeline card. Once 1+ pipelines are selected, a bulk action bar appears above the list with Enable, Disable, Run Now, and Delete buttons. "Select All" / "Deselect All" toggles the full visible set. Press Escape to exit selection mode.', icon: 'CheckSquare' },
        ],
      },
      {
        name: 'Schedule Timeline',
        position: 'Below description',
        items: [
          { label: 'Schedule — 24h overview', detail: 'Collapsible 24-hour timeline strip showing when all enabled cron pipelines fire today. Dots are color-coded per pipeline — hover for pipeline name and exact fire time. High-frequency pipelines (fires every hour or more) render as semi-transparent bands. The vertical accent line marks the current time. Git-poll and file-poll pipelines appear below as dashed badges showing their poll interval. Collapsed/expanded state is saved per device.', icon: 'Clock' },
        ],
      },
      {
        name: 'Pipeline List',
        position: 'Main area — expandable cards',
        items: [
          { label: 'Pipeline card', detail: 'Shows name, trigger type (git-poll/cron/file-poll), and enabled/disabled toggle.' },
          { label: 'Action type chip', detail: 'Shows the pipeline action type (e.g. "Parallel", "Maker-Checker") on the card header. Simple session pipelines omit the chip to reduce noise.' },
          { label: 'Schedule badge', detail: 'Shows the current cron schedule as a human-readable label (e.g. "Weekdays 9am"). Click it to open the schedule editor with presets and next-run preview.', icon: 'Clock' },
          { label: 'Running indicator', detail: 'Pulsing amber dot when the pipeline is actively polling.' },
          { label: 'Error display', detail: 'Red block with error message if the last run failed.' },
          { label: 'Failure badge', detail: 'Amber warning showing consecutive failure count (e.g. 2/3). Pipelines auto-pause after 3 consecutive failures — this badge surfaces the count before it happens.', icon: 'AlertTriangle' },
          { label: 'Budget badge', detail: 'Shows the configured cost cap per run (e.g. "$5"). Turns into "$ Cap" after a run hits the budget limit. Hover for warning threshold. Pipelines without a budget configured show no badge.' },
          { label: 'Success rate badge', detail: 'Shows N/M ✓ (card) or XX% (list) — successes over the last 10 runs. Green ≥80%, amber 50–79%, red <50%. Hidden until a pipeline has ≥3 runs. Hover for full counts. Sort by "Success Rate" to surface unreliable pipelines first. Click the badge (when rate < 100%) to auto-expand, jump to the History tab, and pre-filter to failures only.' },
          { label: 'Run strip', detail: 'Thin horizontal sparkline of up to 20 recent runs next to the success badge. Green cells = success, red = failed, gray = ran but took no action (condition gate). Newest runs on the right. Hover any cell for its timestamp, outcome, and first error. Visible once a pipeline has ≥5 runs — answers "when did the failure wave start?" at a glance.' },
          { label: 'Cumulative cost badge', detail: 'Shows total spend across all recorded runs of this pipeline (e.g. "$3.47"). Appears once cumulative cost exceeds $0.01. Hover for run count. Useful for identifying which pipelines cost the most over time.' },
          { label: 'Repo pipelines', detail: 'Pipelines from .colony/pipelines/ in tracked repos appear here (disabled by default).' },
          { label: 'Duration trend sparkline', detail: 'SVG bar chart (≈80×20px) inline with the next-run countdown. Shows the last 10 run durations as proportional bars — green for success, red for failure. Only appears when a pipeline has ≥3 runs. Hover any bar for timestamp, outcome, and duration. Lets you spot slowdowns at a glance without opening the history tab.' },
          { label: 'Next-run countdown', detail: 'For cron-triggered pipelines, shows when the next fire will happen. Updates every 60 seconds. Shows "Paused" when the pipeline is disabled.', icon: 'Timer' },
          { label: 'Duplicate', detail: 'Create a copy of this pipeline with "(copy)" appended to the name. The copy starts disabled so it won\'t fire until you review and enable it.', icon: 'Copy' },
          { label: 'Notes button', detail: 'Queue a one-shot note for the pipeline\'s next fire. Notes are injected into the session prompt then automatically cleared — they won\'t appear on subsequent runs. Use for run-specific steering like "focus on the auth test failure" or "skip frontend lint this time." Hover a queued note for edit (pencil) and delete (×) buttons. Click the pencil to edit inline — Enter saves, Escape cancels.', icon: 'StickyNote' },
          { label: 'Notification bell', detail: 'Click the bell icon on a pipeline card to cycle through three notification levels: All (every fire), Failures (approval gates and budget alerts only — routine fires are suppressed), and Off (no desktop notifications). Solid bell = all, bell with minus = failures only, bell with × = none. The setting is saved to the pipeline\'s YAML.', icon: 'Bell' },
          { label: 'Right-click menu', detail: 'Right-click any pipeline card for quick actions: enable/disable, pause for 1h/4h/8h/indefinitely, resume, trigger now, run with options, duplicate, or preview next run — without expanding the detail panel.' },
          { label: 'Pause timer', detail: 'Right-click → Pause 1h / 4h / 8h / Until resumed. Paused pipelines are skipped during polls but remain enabled — they auto-resume after the chosen duration. An amber "⏸ resumes in Xh" badge shows on the card. Right-click → Resume Now to cancel early. Use when doing maintenance without risking forgotten-disabled pipelines.' },
          { label: 'Copy YAML', detail: 'Right-click any pipeline card → Copy YAML to copy the full pipeline config to the clipboard. Also available as a Copy button in the YAML tab when the pipeline is expanded. A brief toast confirms the copy. Use to share pipeline configs with another Colony installation, paste into documentation, or back up before editing.', icon: 'Copy' },
          { label: 'Last-run outcome line', detail: 'A one-line summary below the run-strip badges: "✓ 3m ago" for success or "✗ 12m ago — error text" for failure. Saves a click-through to History for the most common question: "did the last run work?" Click the line to expand the pipeline. Only shown when there is at least 1 run.' },
          { label: 'Trigger Now', detail: 'Fires the pipeline immediately with its YAML defaults — no dialog. Use this for quick re-runs when no overrides are needed.', icon: 'Play' },
          { label: 'Run with Options...', detail: 'Opens a dialog pre-filled from the pipeline YAML where you can override prompt, model, working directory, and budget cap for this run only — YAML is never modified. Submit with Cmd+Enter or the Run button.', icon: 'Play' },
        ],
      },
      {
        name: 'Pipeline Detail',
        position: 'Expanded card',
        items: [
          { label: 'YAML definition', detail: 'Trigger (when), conditions (if), and actions (then). Edit the file directly.' },
          { label: 'Cron expression', detail: 'e.g., "0 9-17 * * 1-5" for hourly during work hours on weekdays.' },
          { label: 'Session routing', detail: 'route-to-session finds existing sessions by branch, repo, PR, or name. Falls back to launching new.' },
          { label: 'Content-hash dedup', detail: 'Tracks Git SHA — only re-fires when matched file content actually changes. Set dedup.maxRetries (default 0) to auto-retry: when the same content SHA fires again and the prior fix session has exited, the pipeline re-runs up to maxRetries times with a [RETRY N/M] prefix injected into the prompt. After exhaustion an attention alert is broadcast. Retry runs show an amber N/M badge in the History tab.' },
          { label: 'Poll Now', detail: 'Run a full poll cycle immediately. Evaluates conditions and fires actions if matched. Use Preview first to check before committing.', icon: 'Play' },
          { label: 'Delete', detail: 'Right-click a pipeline card to delete it. Removes the YAML file and associated sidecar files (memory, readme, debug, state). Requires confirmation.', icon: 'Trash2' },
          { label: 'Preview', detail: 'Dry-run the pipeline — evaluates trigger and conditions without firing any actions. Shows which PRs/contexts would match, resolved template variables, and whether dedup would suppress the fire.', icon: 'Eye' },
          { label: 'Approval gate', detail: 'Add requireApproval: true to a pipeline YAML to require human approval before it fires. Matched actions queue in the Activity bell — you approve or dismiss from there. Approvals auto-expire after 24h by default; set approvalTtl (hours) in the pipeline YAML to override.' },
          { label: 'Stage Handoff', detail: 'Inject structured context from a prior pipeline stage. Add handoffInputs: [name] to a pipeline action and list artifact names (from ~/.claude-colony/artifacts/<name>.txt). The content is wrapped in a framing block instructing the agent to respect prior decisions and focus constraints. Injected before artifactInputs so context precedes raw data.' },
          { label: 'Diff Review stage', detail: 'Add type: diff_review to a pipeline action to automatically review a git diff before proceeding. Runs git diff <diff_base> (default: HEAD~1) in workingDirectory, injects the diff into the prompt, and dispatches to a reviewer session. Replies containing APPROVED or LGTM pass immediately; otherwise an approval gate is created with the review text. Set auto_fix: true to launch a fixer session on failure and retry (up to autoFixMaxIterations, default 2). Diffs larger than 8KB are truncated.' },
          { label: 'Pipeline Chaining (trigger_pipeline)', detail: 'Add type: trigger_pipeline with target: "Pipeline Name" to fire another pipeline when this one runs. The target fires as an independent run (its own run ID and history entry). Fire-and-forget — the current pipeline continues without waiting for the target to complete. Circular chains (A→B→A) are detected and skipped with a warning. Useful for composing layered workflows: CI Auto-Fix → PR Review on success, Daily Build → Deploy Staging, etc.' },
          { label: 'Parallel Fan-Out stage', detail: 'Add type: parallel with a stages: list to dispatch multiple sub-actions simultaneously. All sub-stages run concurrently (Promise.all). Set fail_fast: false to run all stages regardless of failures (default: true, abort on first failure). The History tab shows parallel groups as indented sub-stage rows. Nested parallel stages are not supported.' },
          { label: 'Plan stage', detail: 'Add type: plan to require an agent to produce an implementation plan before the pipeline proceeds. The planning session writes its plan to a file, then an approval gate appears ("Approve plan to proceed?"). Approve to continue (plan is injected into the next stage via handoffInputs), Reject to stop the run. Set require_approval: false for fully automated pipelines — plan is logged but pipeline continues without a gate. Override the completion keyword with plan_keyword (default: PLAN_READY). The plan is saved as an artifact in ~/.claude-colony/artifacts/ for next stages to consume.', icon: 'FileText' },
          { label: 'Wait for Session stage', detail: 'Add type: wait_for_session with session_name: "My Session" to block the pipeline until a named session exits. Polls every 5s. Tolerate "not found" for 30s after the stage starts (session may not have launched yet). Set timeout_minutes (default: 30) to control the max wait. Transient daemon disconnects are ignored. Set artifact_output: name to write the session exit reason to ~/.claude-colony/artifacts/<name>.txt — useful for feeding results into subsequent stages via handoffInputs.', icon: 'Hourglass' },
          { label: 'Best-of-N stage', detail: 'Add type: best-of-n to spawn N sessions in separate worktrees with the same prompt, then auto-judge which output is best. Set n (2-8, default 3), repo: {owner, name}, branch (default main), and judge: {type: command|llm, cmd or prompt}. Command judge runs a shell command (e.g. npm test) in each worktree — winner is the first clean exit. LLM judge launches a session that evaluates all outputs and responds with WINNER: <slot>. Optional models: array for per-slot model overrides. Winner worktree is preserved (keep_winner: true by default); losers cleaned up. Results recorded in arena-stats.json for the Arena Leaderboard.', icon: 'Trophy' },
          { label: 'Stage model override', detail: 'Add model: claude-opus-4-6 (or claude-sonnet-4-6 / claude-haiku-4-5) to any stage to run that step on a specific model tier. Frontier reasoning for planning → opus; cheap + fast boilerplate → haiku. The model tag (· haiku) appears in the History tab. Blank/missing model uses the CLI default.' },
          { label: 'Auto model routing', detail: 'Set model: auto on a pipeline step to let Colony pick the cheapest model that can handle it. Heuristic: short prompt (≤400 chars) + no handoffInputs + launch-session type → Haiku automatically; anything heavier falls back to default_model or the global default. The History tab shows "· haiku · auto" so you can see which model was actually picked. Threshold is configurable via COLONY_AUTO_MODEL_THRESHOLD env var.' },
          { label: 'Pipeline default model', detail: 'Set default_model: claude-haiku-4-5 at the pipeline level to apply a fallback Claude model to all stages that don\'t set their own model override. Precedence: stage model → pipeline default_model → global CLI default. For a 6-stage pipeline that should mostly use Haiku except one Opus review step, set default_model: claude-haiku-4-5 at the top and model: claude-opus-4-6 only on the review stage. The effective default model appears as a chip in the pipeline detail view.' },
          { label: 'Webhook trigger', detail: 'Add trigger: {type: webhook, source: github|generic, secret: mytoken} to fire the pipeline when a POST arrives at /webhook/<slug>. The slug is the pipeline name lowercased with spaces replaced by hyphens. Colony validates the signature before firing.', icon: 'Globe' },
          { label: 'GitHub webhooks', detail: 'Set up a GitHub webhook pointing to http://localhost:7474/webhook/<slug> with the same secret as in the YAML. Colony verifies the X-Hub-Signature-256 header (HMAC-SHA256 of the request body). External tools like ngrok can expose the local server.' },
          { label: 'Webhook template variables', detail: '{{pr_title}}, {{pr_url}}, {{pr_number}}, {{sender}} are extracted from GitHub webhook payloads. {{webhook_payload}} contains the full JSON payload. These can be used in the action prompt.' },
          { label: 'Run condition', detail: 'Add run_condition: has_changes to a cron pipeline to skip the run when no new commits have landed since the last fire. Colony runs git log --after=<lastFiredAt> in the pipeline\'s workingDirectory. If no commits are found, the run is silently skipped and logged. First run always fires (no lastFiredAt). Shows as an "if changes" badge on the pipeline card.' },
          { label: 'Pre-run hooks', detail: 'Add pre_run: [{type: refresh-prs}] to a pipeline to refresh external data before the action fires. Hooks run sequentially after the condition passes. Currently supported: refresh-prs — fetches latest PRs for all configured repos and rewrites pr-context.md so the session launches with fresh data. Hook failures are logged as warnings but do not block the action. Timing is logged in the debug log. Pipelines with pre_run configured show a "pre-run" badge on the card.' },
          { label: 'files-changed condition', detail: 'Only fire when specific paths changed since the last run. Add condition: {type: files-changed, patterns: ["src/renderer/**", "*.css", "!**/*.test.ts"]}. Patterns use glob syntax; prefix with ! to exclude. First run always fires (no baseline). Works with any trigger type. Use with git-poll or cron pipelines in monorepos to avoid spurious runs — e.g. fire a backend pipeline only when Python files change, skip when only docs changed. The Preview dry-run lists matched files.' },
          { label: 'on_failure recovery action', detail: 'Add on_failure to any action to run a recovery step when the stage fails after all retries are exhausted. Example: action: {type: session, prompt: "Fix CI", max_retries: 2, on_failure: {type: session, prompt: "CI fix failed: {{error}}. Summarize.", model: haiku}}. The {{error}} template variable contains the failure message. on_failure is fire-and-forget — its own failures are logged but do not propagate, and it cannot itself have on_failure. Cost adds to the pipeline run total. The stage trace records whether on_failure fired.' },
        ],
      },
      {
        name: 'Pipeline Resources',
        position: 'Tabs within expanded card',
        items: [
          { label: 'Flow', detail: 'SVG node graph of the pipeline structure. Shows trigger → action → sub-stages as connected nodes. Parallel actions fork and rejoin via diamond nodes. Nodes are color-coded by last-run status: green (success), red (failure), gray (no data). Active stages pulse when the pipeline is running.', icon: 'GitBranch' },
          { label: 'Memory', detail: 'Per-pipeline memory file. Maker learnings and checker review rules are injected into prompts automatically. On approval, the checker\'s observations are persisted under a "Review Rules" header. Size-capped at ~4K tokens.' },
          { label: 'Outputs', detail: 'Configurable output directory for pipeline-generated files.' },
          { label: 'History', detail: 'Ring buffer of the last 20 poll runs: timestamp, trigger type, whether an action fired, success/failure, duration, cost (green under $0.10, amber over $1.00), and session count. Click rows with a chevron (▶) to expand per-stage details — stage type, session name (clickable if session still exists — navigates to that session), reviewer response snippet (diff_review stages), individual duration, per-stage cost in green (when >$0.001), and a △ badge on any stage whose status changed from the prior run. Session names are clickable — running sessions navigate to them; ended sessions expand an inline preview card showing summary, commits, changes, cost, and a Resume button to continue the conversation. Resume launches a new session with --resume using the original Claude conversation context. Use the checkboxes on the left to select two runs for side-by-side comparison. Failed runs show the first error inline; click to expand full stage trace.', icon: 'Clock' },
          { label: 'Failures only filter', detail: 'Toggle "Failures only (N)" in the history toolbar to hide successful runs and focus on the N failed entries. Original run indices are preserved so expand/compare still work after toggling. Empty state shows "No failures in the last N runs" when all runs succeeded.' },
          { label: 'History search + date filter', detail: 'History tab supports text search (matches trigger type and error message content) and date range filtering (Today/7d/30d/All) alongside the failures-only toggle. All three filters compose — state resets when switching to a different pipeline.' },
          { label: 'Retry Failed Run', detail: 'Re-trigger the pipeline from a failed history entry. Appears as a refresh icon on failed rows.', icon: 'RefreshCw' },
          { label: 'Replay Run', detail: 'Replay any historical run immediately — available on every history row, not just failures. Appears as a circular arrow icon on hover. Same as Trigger Now, but surfaces the specific run being replayed in a toast banner. Disabled if the pipeline is already running.', icon: 'RotateCw' },
          { label: 'Search History', detail: 'Click the History icon (⟳) in the panel header to open cross-pipeline history search. Type any text to search across all pipeline run histories by pipeline name, trigger type, or session ID. Use filter keywords: "failed" shows only failures, ">$1" shows runs costing over $1, "today" shows today\'s runs, "last-hour" shows the past hour. Click any result row to navigate to that pipeline\'s History tab. Results are sorted by timestamp (newest first), capped at 50 entries.', icon: 'History' },
          { label: 'Trigger context', detail: 'Each history row shows a collapsible trigger context below it — click the chevron to expand. For cron pipelines: shows the cron expression. For git-poll: shows matched PR numbers, commit SHAs, and changed files (up to 10). Useful for debugging "why did this fire at 3am?" without digging through debug logs.' },
          { label: 'Run Comparison', detail: 'Select two history runs via their checkboxes and click Compare to see a structured side-by-side diff — duration delta, cost delta, and stage-by-stage status/timing changes. Earlier/Later labels are assigned automatically by timestamp.', icon: 'ArrowUpDown' },
          { label: 'Docs', detail: 'Companion readme if <name>.readme.md exists alongside the pipeline.' },
          { label: 'Artifacts', detail: 'Browse captured artifact files from ~/.claude-colony/artifacts/. Artifacts are captured at fire time via artifactOutputs in the pipeline action (commands like grep, jq, git log). Shows all artifacts sorted by most-recently modified with file size and timestamp. Click any artifact to preview its content inline (monospace, first 200 lines, capped at 50KB). Files over 50KB show a truncation notice. Copy-to-clipboard button in the preview header.', icon: 'Archive' },
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
          { label: 'Worktrees tab', detail: 'View and manage git worktrees. Clean up stale worktrees from arena runs and forked sessions.' },
          { label: 'Tab navigation', detail: 'Cmd+Shift+{ / Cmd+Shift+} cycles between the Environments, Templates, and Worktrees tabs without touching the mouse.' },
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
          { label: 'Search', detail: 'Filter environments by name or branch. The compact grid and card list both update. Cleared when switching tabs.', icon: 'Search' },
        ],
      },
      {
        name: 'Environment Cards',
        position: 'Main area — Environments tab',
        items: [
          { label: 'Status dot', detail: 'Green = all services running. Yellow = partial. Red = crashed. Gray = stopped.' },
          { label: 'Age badge', detail: 'Shows how long ago the environment was created (e.g. "2d ago"). Hover for the exact date. Helps identify stale environments.' },
          { label: 'Template drift badge', detail: 'Amber badge appears when the environment\'s source template changed after creation. Tooltip shows which fields differ (services, ports, etc.). Click to accept the current template as the new baseline (clears the indicator without modifying services or config). To apply template changes to services, teardown + recreate the env from the template.' },
          { label: 'Service dots', detail: 'Colored dot + service name for each service. Dot color shows status: green = running, red = crashed, gray = stopped. Hover for port and restart info.' },
          { label: 'Start', detail: 'Launch all services in the environment.', icon: 'Play' },
          { label: 'Stop', detail: 'Halt all running services.', icon: 'Square' },
          { label: 'Restart', detail: 'Stop all services then start them again. Useful after config changes or to clear bad state.', icon: 'RefreshCw' },
          { label: 'Terminal', detail: 'Open a Claude session in the environment directory.', icon: 'Terminal' },
          { label: 'Open Folder', detail: 'Open the environment directory in Finder.', icon: 'FolderOpen' },
          { label: 'Diagnose', detail: 'Launch Claude to diagnose and fix environment issues.', icon: 'Stethoscope' },
          { label: 'Debug', detail: 'Toggle debug mode. When on, services restart with a debugger attached (Node.js --inspect / Python debugpy). Amber bug icon indicates debug is active. Agent sessions launched in a debug environment automatically get debug_* MCP tools for setting breakpoints, inspecting variables, and stepping through code.', icon: 'Bug' },
          { label: 'Clone', detail: 'Duplicate an environment with the same template, branch, and base branch but fresh ports and a new directory. Enter a name in the dialog. Disabled while the source is still creating.', icon: 'Copy' },
          { label: 'View Context', detail: 'Inspect the CLAUDE.md file injected into agent sessions for this environment. Shows merged content (auto-generated block + your edits). Tabs for Env Root and Worktree Bundle (when a worktree is mounted). Footer: Regenerate rewrites from current config; Open in Editor opens in your default app.', icon: 'FileText' },
        ],
      },
      {
        name: 'Expanded Environment',
        position: 'Below card when expanded',
        items: [
          { label: 'Service list', detail: 'Each service row shows status, uptime, port, restart count, and start/stop/restart controls. When debug mode is on, an amber "debug :PORT" badge shows the debug adapter port.' },
          { label: 'URLs section', detail: 'Clickable URLs for accessible service endpoints.' },
          { label: 'Auto-restart toggle', detail: 'When enabled, any crashed service in this environment is automatically restarted after 5 seconds. Off by default.' },
          { label: 'Purpose tag', detail: 'Tag an environment as interactive (sprint work), background (parallel tasks), or nightly (overnight batch jobs). Shows as a colored badge on the card. Optional — helps you filter and understand at a glance what each environment is for.' },
          { label: 'Ports section', detail: 'Allocated ports per service — unique across environments to avoid conflicts.' },
          { label: 'Paths section', detail: 'Root path, backend path, frontend path, etc. for the environment.' },
          { label: 'Active Worktree', detail: 'Shows the currently mounted worktree — display name, branch, and repo. Use "Swap" to switch to a different unmounted worktree without tearing down services (~7s). Appears only when worktrees exist.', icon: 'GitBranch' },
          { label: 'Swap Worktree', detail: 'Dropdown listing compatible unmounted worktrees. Selecting one triggers: stop services → swap mount → restart (~5-10s). "Create new worktree" opens the Worktrees tab. Disabled if no unmounted worktrees exist.', icon: 'ArrowLeftRight' },
          { label: 'Recent Worktrees', detail: 'Shows the 5 most recent unmounted worktrees with quick Swap and Delete actions. Swap mounts the worktree and restarts services in place.', icon: 'GitBranch' },
          { label: 'Files', detail: 'Collapsible file browser for the environment worktree. Click to expand and browse repo checkouts — directories lazy-load on expand, files show a preview with line numbers. Filter by name and refresh the tree. Hover any row to reveal Reveal-in-Finder and Copy Path buttons. The file preview header adds a third Open Externally action.', icon: 'FolderTree' },
          { label: 'Log filter', detail: 'Type in the search box to filter log lines by keyword. Match count updates in real-time. Download always exports the full unfiltered log.', icon: 'Search' },
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
        name: 'Worktrees',
        position: 'Main area — Worktrees tab',
        items: [
          { label: 'Worktrees tab', detail: 'View and manage git worktrees created by arena runs, forked sessions, and PR reviews. Each card shows display name, repo, branch, mount status, and age. Orphaned and stale worktrees are highlighted for cleanup.' },
          { label: 'Lifecycle status', detail: 'Worktrees have four states: Mounted (attached to an env, blue badge), Unmounted (detached, amber badge), Orphaned (env was deleted — red highlight, auto-unmounted on restart), Stale (unmounted >30 days — amber highlight).' },
          { label: 'Mount', detail: 'Attach an unmounted worktree to an environment. Pick from the environment dropdown to link them.', icon: 'Link' },
          { label: 'Unmount', detail: 'Detach a worktree from its environment without deleting it. The worktree becomes removable.', icon: 'Unlink' },
          { label: 'Remove', detail: 'Delete an unmounted worktree from disk. Only available for unmounted worktrees.', icon: 'Trash2' },
          { label: 'Remove All Unmounted', detail: 'Bulk-remove all worktrees not attached to any environment. Asks for confirmation first.', icon: 'Trash2' },
          { label: 'Reveal in Finder', detail: 'Open the worktree directory in Finder. Appears on hover next to the path.', icon: 'FolderOpen' },
          { label: 'Copy path', detail: 'Copy the full worktree path to your clipboard. Shows a checkmark briefly to confirm.', icon: 'Copy' },
          { label: 'New worktree', detail: 'Create a standalone git worktree from a tracked repo. Pick a repo and branch — Colony creates the worktree in its managed directory. Mount it to an environment later.', icon: 'Plus' },
          { label: 'Pull button', detail: 'Fast-forwards the worktree to the latest origin/<branch>. Shows "Check" until status is loaded, then "Pull N" (N commits behind), "Up to date", "Diverged", or "Pull (dirty)" if there are uncommitted changes. Disabled when dirty or diverged — stash or rebase manually first. For mounted worktrees, services pick up file changes on next hot-reload.', icon: 'Download' },
          { label: 'Check upstream button', detail: 'Fetches latest refs from origin and refreshes upstream status for all worktrees simultaneously. Use this to see how far behind each worktree is before pulling.', icon: 'RefreshCw' },
          { label: 'Disk size', detail: 'Shows how much disk space each worktree uses (summed across all repos). Useful for identifying bloated arena or fork worktrees before pruning. Updated on tab open and on Check upstream.', icon: 'HardDrive' },
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
    description: 'Configure Colony\'s behavior, CLI defaults, and manage the background PTY daemon that owns all terminal sessions. Use the search bar at the top to filter the 17 sections by keyword.',
    zones: [
      {
        name: 'Header Actions',
        position: 'Top right, in panel header',
        items: [
          { label: 'Export', detail: 'Download all settings, MCP servers, templates, and approval rules as a JSON file', icon: 'Download' },
          { label: 'Import', detail: 'Import settings from a JSON backup — merges MCP servers and templates, replaces other settings', icon: 'Upload' },
        ],
      },
      {
        name: 'Search',
        position: 'Top, below header',
        items: [
          { label: 'Filter settings', detail: 'Type keywords to filter sections. Matches section titles, field names, and descriptions. Case-insensitive substring match. Shows count of matching sections.', icon: 'Search' },
        ],
      },
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
        name: 'Appearance Section',
        position: 'Below Shell section',
        items: [
          { label: 'Theme', detail: 'Switch between Dark and Light mode. Changes apply instantly — terminal colors, syntax highlighting, and all UI elements update automatically. Persists across restarts.', icon: 'Palette' },
          { label: 'Font size', detail: 'Adjust terminal and UI font size (range 8–28, default 13). Changes apply instantly. Also adjustable with ⌘+/⌘− keyboard shortcuts; ⌘0 resets to default.' },
          { label: 'Font family', detail: 'Choose a monospace font for terminals: Menlo (default), JetBrains Mono, Fira Code, SF Mono, Source Code Pro, Cascadia Code, or system monospace. The font must be installed on your system.' },
          { label: 'Cursor style', detail: 'Choose block, bar, or underline cursor shape. Enable blink for an animated cursor. Applies to all session and shell terminals.' },
          { label: 'Scrollback lines', detail: 'Number of lines kept in the terminal scroll buffer (1,000–100,000, default 10,000). Higher values use more memory. Changes apply to new terminals only.' },
        ],
      },
      {
        name: 'General Section',
        position: 'Below Appearance section',
        items: [
          { label: 'Keep running in tray when closed', detail: 'Colony continues running pipelines and persona schedules when the window is closed. Access via the menu bar icon. Disable to quit on window close.' },
        ],
      },
      {
        name: 'Preferences Section',
        position: 'Middle section',
        items: [
          { label: 'Global hotkey', detail: 'Keyboard shortcut to summon Colony from any app (default: Ctrl+Shift+Space).' },
          { label: 'Desktop notifications', detail: 'Show system notifications for pipeline fires, approval gates, persona run start/complete events, and session error exits. Per-source toggles appear below when enabled — mute noisy sources (e.g. pipelines) while keeping important ones (e.g. approval gates). Error exit notifications fire for non-zero exit codes on non-persona sessions.' },
          { label: 'Environment notifications', detail: 'Alerts for environment lifecycle events: service crashes (with optional tag for mcp-server and other optional services), environments becoming fully ready (all services running), and auto-restart failures. Per-service crash-loop protection — at most one notification per service per minute. Toggle in notification source filters.' },
          { label: 'Sound on finish', detail: 'Play a sound when Claude finishes processing and the app isn\'t focused.' },
          { label: 'Quiet hours', detail: 'Suppress desktop notifications during a time window (e.g. 22:00–07:00). In-app notification history still records everything — only OS-level alerts are silenced. Supports overnight ranges that cross midnight.' },
          { label: 'Auto-cleanup', detail: 'Remove stopped sessions after N minutes. Set to 0 to keep them forever.' },
          { label: 'Session retention', detail: 'Auto-remove stopped sessions older than N days on startup and every 6 hours. Persona and pinned sessions are always kept. Set to 0 to disable.' },
          { label: 'Daily cost budget', detail: 'Set a daily dollar limit for persona run costs. When exceeded, a desktop notification fires (once per day). The overview cost chart shows a dashed budget line and today\'s bar turns amber/red. Leave empty to disable.' },
          { label: 'Per-session cost cap', detail: 'Auto-stop any session (manual, pipeline, or persona) when its cost exceeds this dollar amount. Persona max_cost_usd in frontmatter takes precedence. Leave empty to disable. Uses the same budget-exceeded broadcast, notification, and activity log as persona cost caps.' },
          { label: 'Stale session threshold', detail: 'Minutes of no output before a busy session is flagged as "stale" in the Overview attention section. Default: 15 minutes. Increase for long-running workflows that are legitimately silent (builds, large file processing). The idle time and threshold are shown in the tooltip on stale attention items.' },
          { label: 'Trigger chain depth limit', detail: 'Maximum number of hops in a persona on_complete_run trigger chain before Colony halts further triggers. Prevents infinite loops from circular chains (A→B→A). Default: 10. When the limit is reached, a warning appears in the activity log and a desktop notification fires. Depth resets to 0 for any manually-launched or scheduled run.' },
        ],
      },
      {
        name: 'MCP Catalog Section',
        position: 'Lower-middle section',
        items: [
          { label: 'MCP Server Catalog', detail: 'Define named MCP servers (stdio command or SSE URL). Reference them by name in pipeline YAML (mcpServers: ["name"]) or when creating sessions. Colony writes a --mcp-config temp file and passes it to the Claude CLI.', icon: 'Network' },
          { label: 'gh skill auto-discovery', detail: 'Colony scans ~/.local/share/gh/skills/ (or %APPDATA%/gh/skills/ on Windows) at startup and each time the MCP panel opens. Installed gh skills are added automatically with a "gh" badge. Ignored skills are tracked in gh-skill-ignored.json and won\'t re-appear.', icon: 'RotateCcw' },
          { label: 'Refresh skills button', detail: 'Re-scan the gh skills directory immediately and merge any newly installed skills into the catalog. Uses a 60-second cache — click refresh if you just installed a skill and it hasn\'t appeared yet.', icon: 'RotateCcw' },
          { label: 'Add Server', detail: 'Choose command (stdio) or SSE type. For command servers, enter the executable and arguments. Arguments support quoted strings with spaces (e.g. "-y @mcp/fs \"/path with spaces\"") and environment variables (e.g. "$HOME", "${VAR}"). Example: npx -y @modelcontextprotocol/server-filesystem $HOME/data', icon: 'Plus' },
          { label: 'Environment Variables', detail: 'Set custom environment variables (KEY=value pairs) that will be available when the MCP server runs. Variables are merged with system environment; custom values take precedence. Example: API_KEY=secret, PORT=3000. Variables can be referenced in args using $VAR or ${VAR} syntax.', icon: 'Box' },
          { label: 'Test', detail: 'Verify an MCP server is reachable — spawns the command or fetches the URL with a 5-second timeout. Result shows inline as a green checkmark (success) or red X (failure) and auto-clears after 10 seconds.', icon: 'Play' },
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
          { label: 'Liveness heartbeat', detail: 'The app pings the daemon every 30 seconds. If 2 consecutive pings fail (~50s), the daemon is force-killed and auto-restarted. An amber banner appears during recovery.' },
          { label: 'Rate limit banner', detail: 'A red banner appears when the API rate limit is hit. Colony automatically pauses all cron pipelines and persona schedules. The banner shows a live countdown and utilization percentage when available (from the structured probe). Dismiss hides the banner but keeps crons paused; Resume Now explicitly clears the pause. An amber early-warning banner appears when utilization is high but crons are still running.' },
          { label: 'Cron pause banner', detail: 'An amber banner appears when you manually pause all cron jobs via the Pause All button in the Pipelines panel. All cron-triggered pipelines and persona schedules are suspended. Git-poll and file-poll pipelines continue running. Click Resume to unpause. Independent from the rate-limit pause.', icon: 'PauseCircle' },
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
          { label: 'API URL', detail: 'Base URL for the Colony REST API (http://127.0.0.1:7474/api/). Click the copy button to copy it. Use GET /api/sessions, GET /api/pipelines, POST /api/sessions/:id/steer, POST /api/pipelines/:name/trigger, or GET /api/events (SSE stream).' },
          { label: 'API token', detail: 'Set a token to require authentication on the Colony REST API. When configured, requests must include a Bearer token or X-Colony-Token header. Leave empty for no authentication.' },
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
          { label: 'Edit rule', detail: 'Click the pencil icon on any rule row to edit its name, type, condition, or action inline. Updates are saved immediately.', icon: 'Pencil' },
          { label: 'Rule precedence', detail: 'Rules are evaluated in order — first match wins. Disabled rules are skipped.' },
          { label: 'Auto-approve audit trail', detail: 'Auto-approved actions are logged for compliance (autoApproved: true).' },
        ],
      },
      {
        name: 'Integrations Section',
        position: 'Above Session Templates',
        items: [
          { label: 'Jira Cloud', detail: 'Configure Jira Cloud credentials to attach ticket context to sessions. Uses Basic auth (email + API token). Get your token at id.atlassian.com/manage-profile/security/api-tokens. Once configured, use the "Attach JIRA Ticket" field in the New Session dialog to prepend any ticket\'s title and description to the session\'s first prompt.' },
          { label: 'Test Connection', detail: 'Sends a test request to the configured Jira domain. A 404 (ticket not found) counts as success — it confirms auth worked. A 401 means wrong email or API token.', icon: 'Play' },
          { label: 'Transition on Commit', detail: 'Exact Jira status name (case-sensitive). When set, Colony automatically moves the attached ticket to this status whenever a commit is made from the session. Leave blank to disable. Example: "In Review".' },
          { label: 'Status on session start', detail: 'Exact Jira status name (case-sensitive). When set, Colony moves the attached ticket to this status the moment a new session is created with that ticket attached. Leave blank to disable. Example: "In Progress".' },
          { label: 'Post comment on session exit', detail: 'When enabled, Colony posts a comment to the linked Jira ticket when a session exits with commits. The comment lists commit SHAs and subjects made during the session, the duration, and the environment name. Sessions with no commits are skipped.' },
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
          { label: 'From Template', detail: 'Create a persona from a built-in or custom template. Built-in templates include Colony Verifier (runs the test suite after implementation sessions). Add custom templates as .yaml files in ~/.claude-colony/persona-templates/.', icon: 'Copy' },
          { label: 'Audit', detail: 'Run an AI-powered audit of all persona configurations. Detects broken cron schedules, impossible permission combos, stale model names, and other misconfigurations. Results show severity (HIGH/MEDIUM/LOW) and actionable fix suggestions.', icon: 'ShieldCheck' },
          { label: 'List / Schedule / Triggers tabs', detail: 'List shows persona cards. Schedule shows a 24-hour heatmap of when each persona fires. Triggers shows a directed graph of cross-persona trigger chains.', icon: 'CalendarClock' },
          { label: 'Search', detail: 'Filter the persona list by name or ID. Case-insensitive substring match. Clear with the ✕ button.', icon: 'Search' },
          { label: 'Compare', detail: 'Enter compare mode to diff two persona configs side-by-side. Click the Compare button (GitCompare icon) to toggle. In compare mode, click any two persona cards to select them — a unified diff of their full config files (frontmatter + body) appears below the list. Clear selection with the ✕ button, exit compare mode with Escape or the Exit button.', icon: 'GitCompare' },
          { label: 'Search Learnings', detail: 'Search across all persona learnings and active situations. Click the "Search Learnings" button (book icon) to open the search bar. Type at least 2 characters to search — results appear grouped by persona with the matched text highlighted. Click any result to expand that persona\'s card. Press Escape to close.', icon: 'BookOpen' },
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
          { label: 'Brief preview', detail: 'Muted one-line subtitle below the persona name showing the first meaningful line of its latest session brief. Gives an at-a-glance "what did it do last?" without opening the card. Empty when the persona has never run or has no brief.' },
          { label: 'Working status', detail: 'When a persona is running, a live italic status line appears below the persona name (replaces the brief preview). Personas write this by creating ~/.claude-colony/personas/{slug}.status with a one-line description of their current task (e.g. "Reviewing PR #38 for auth issues"). The status is deleted automatically when the session exits. Also shown in the status bar inside the expanded card.', icon: 'Activity' },
          { label: 'Queued badge', detail: 'Amber "queued" badge appears when another persona has dispatched a trigger for this one — it will launch on its next scheduled run or when manually triggered. Hover for the triggering persona name and context note.' },
          { label: 'Retry badge', detail: 'Orange "↺ N" badge appears when a persona is waiting to auto-retry after a failed run. The number shows which attempt is pending. Set retry_on_failure: N in persona frontmatter to enable up to N retries before the trigger chain fires. Retries occur 30 seconds after failure with the last 500 chars of output as context.' },
          { label: 'Draining badge', detail: 'Amber "Draining" badge appears when a persona has been set to drain. The current session completes normally, all on_complete_run triggers fire, and then the persona is automatically disabled. New scheduled cron runs are suppressed while draining. Use the Drain button (timer icon) to initiate graceful shutdown without orphaning mid-chain work.', icon: 'Timer' },
          { label: 'Health dot', detail: 'Small colored dot after the persona name — green (healthy), yellow (degraded), red (unhealthy). Computed from the last 10 runs. Green: ≥80% success rate and average cost < 80% of session budget. Yellow: 50–79% success rate or average cost 80–100% of budget. Red: <50% success rate, ≥3 consecutive failures, or any run with budget exceeded. Gray / no dot: fewer than 3 runs (insufficient data). Hover for a tooltip showing run count, success rate, average cost, average duration, and consecutive failure count.' },
          { label: 'Triggered-by chip', detail: 'When a running persona was triggered by another persona (via on_complete_run chain), a muted "↳ from <name>" chip appears next to the Running badge. Shows the trigger source without expanding the card. Disappears when the session completes.' },
          { label: 'Schedule', detail: 'Shows when the persona runs automatically as a human-readable label (e.g. "Every 2 hours"). Click to open the schedule editor with presets and next-run times.', icon: 'Clock' },
          { label: 'Run count', detail: 'How many sessions this persona has completed.' },
          { label: 'Run history sparkline', detail: 'Shows pass/fail pattern for the last 20 runs (green = success, red = failure, gray = no data). Hover any cell for timestamp, outcome, and cost. Hidden when the persona has no run history.' },
          { label: 'Brief reply shortcut', detail: 'Hover the "Latest Brief" section header and click the MessageSquare icon to reply to the brief. Opens the whisper bar pre-filled with the first 3 lines of the brief as quoted context, ready for your follow-up instructions or corrections.', icon: 'MessageSquare' },
          { label: 'File attachments in whisper', detail: 'Drop any file onto the whisper bar to embed its content as a fenced code block (📎 filename + line count + content). Files over 50 KB or binary files insert the path only with a note. Sensitive paths (.ssh, .env, .gnupg) are blocked. Multiple files are supported — each becomes its own code block. Review embedded content in the textarea before sending.', icon: 'FileText' },
          { label: 'Brief diff', detail: 'When a persona has run at least twice, a GitCompare button appears next to the Session Brief in the Outputs tab. Click it to see a unified diff of what changed between the last two briefs — added lines in green, removed lines in red, with word-level highlights on changed lines. The previous brief snapshot is saved automatically when each new session starts.', icon: 'GitCompare' },
          { label: 'Trigger label', detail: '"→ colony-qa" (accent color) — set via on_complete_run; those personas auto-launch when this session ends. Muted "→ x" — set via can_invoke; personas this one may trigger dynamically via a trigger file, but never fires automatically. When on_complete_run fires, the downstream persona automatically receives a context message with: upstream name, success/failure, duration, commit count, files changed, cost, error summary (if failed), and the brief file path.' },
          { label: 'Run button', detail: 'Manually trigger a persona session now.', icon: 'Play' },
          { label: 'Stop button', detail: 'Stop the currently running persona session.', icon: 'Square' },
          { label: 'Notes button', detail: 'Queue a note for the persona\'s next session. Notes are injected into the planning prompt, then removed after use. Hover a queued note for edit (pencil) and delete (×) buttons. Click the pencil to edit inline — Enter saves, Escape cancels.', icon: 'StickyNote' },
          { label: 'Attention badge', detail: 'Bell icon badge appears when a persona has unresolved attention requests — things it needs your input on. Click the amber banner at the top of the app to reply or dismiss.', icon: 'Bell' },
          { label: 'Drain button', detail: 'Graceful shutdown. If the persona is running: marks it as draining — the current session and its triggers complete normally, then the persona is automatically disabled. If the persona is idle: disables it immediately (same as toggle off). Prevents orphaned trigger chains when you need to update a persona\'s config.', icon: 'Timer' },
          { label: 'Enable/Disable', detail: 'Toggle scheduled runs on or off without deleting the persona.' },
          { label: 'Duplicate', detail: 'Clone this persona with a new name. The copy starts disabled so you can edit it before enabling scheduled runs.', icon: 'Copy' },
          { label: 'Delete', detail: 'Remove the persona file.', icon: 'Trash2' },
          { label: 'Run with Options', detail: 'Right-click any persona card to open "Run with Options...". Override Prompt Prefix (additional context prepended to the planning prompt), Model (use a different Claude model tier for this one run), and Budget Cap ($). All overrides are ephemeral — the persona file is not modified. Use for one-off tests: try a new model, inject extra context for a specific task, or cap spend on an exploratory run. Cmd+Enter to fire.' },
          { label: 'Preview Prompt', detail: 'Right-click any persona card → "Preview Prompt" to see the exact system prompt that would be sent to Claude for the next session. Shows the assembled planning prompt including colony context, knowledge base, task assignments, active situations, and permissions. Use "Copy" to grab the full text. Useful for debugging persona behavior or understanding what context the model receives.' },
          { label: 'Run on Startup', detail: 'Add run_on_startup: true to persona frontmatter (or toggle in Edit modal) to fire the persona once every time Colony starts. Startup runs are staggered 2s apart to avoid thundering herd. All normal guards apply: max_sessions, daily cost cap, enabled check. A persona with both a cron schedule and run_on_startup: true fires on startup AND on schedule — no conflict. The "startup" badge appears on the persona card when this is enabled.' },
          { label: 'Min Interval Cooldown', detail: 'Add min_interval_minutes: N to persona frontmatter (or set in Edit modal) to enforce a minimum gap between automatic runs. Cron, trigger, startup, and queued runs are gated — manual "Run Now" always bypasses the cooldown. When the cooldown is active, the persona card shows a timer badge with the time remaining (e.g. "5m"). This prevents wasted overlapping runs in trigger-heavy topologies where multiple personas chain into each other rapidly.' },
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
          { label: 'Outputs tab', detail: 'Switch to the Outputs tab in an expanded card to browse files the persona wrote to ~/.claude-colony/outputs/<persona>/. Click any file to open a read-only viewer with a copy-to-clipboard button in the header. Session Brief is always listed first.', icon: 'FolderOpen' },
          { label: 'History tab', detail: 'Switch to the History tab in an expanded card to see a timeline of past runs — timestamp, duration, cost, and success status. Failed runs show an inline failure reason (budget exceeded, timed out, stopped, failed). Click any row with a session ID to focus that session in the sidebar. Run history sparkline at the top shows pass/fail pattern over the last 20 runs.', icon: 'Clock' },
          { label: 'Analytics tab', detail: 'Switch to the Analytics tab to see aggregate stats: total runs, success rate, average duration, total cost, 7-day cost. Includes a run-duration sparkline (green=success, red=fail) — click any bar to expand a detail card showing timestamp, duration, cost, outcome, and a "View Session" button if the session still exists. Daily cost bar chart and a table of the last 10 runs with per-run cost. When a persona has more than 10 runs, a "Show all N runs" button expands the table (max-height scrollable) to reveal full run history. "Show less" collapses it back.', icon: 'BarChart3' },
          { label: 'Memory tab', detail: 'View and edit a persona\'s structured memory. Click a situation status badge to cycle it (pending → done → delegated → blocked). Use the + button next to "Active Situations" or "Learnings" to add new entries via an inline form. Double-click any situation or learning text to edit it in-place (Enter saves, Escape cancels). Hover any row for a remove button. Session Log heading has a + button for adding manual notes and a "clear old" button that keeps only the last 5 entries.', icon: 'Brain' },
          { label: 'Multi-select', detail: 'Click the checkbox on each persona row to select it. A bulk action bar appears with Enable, Disable, Run Now (2s stagger), Stop, and Whisper. Select All / Deselect All toggles the full list. Press Escape to clear selection.' },
          { label: 'Batch Whisper', detail: 'Select multiple personas then click the Whisper button in the bulk action bar. A modal opens with a textarea — type your message and click "Send to N personas". The same message is delivered as a whisper to all selected personas simultaneously. Useful for broadcasting instructions like "update your brief" or "focus on X this cycle".', icon: 'StickyNote' },
          { label: 'Brief History', detail: 'Each time a persona runs, its previous brief is rotated into a history archive (up to 5 entries). In the expanded card, click the Clock icon next to the Latest Brief section header to open a dropdown showing archived briefs with relative timestamps. Select any entry to view its content read-only. "Current" returns to the live brief. The diff button compares against the most recent archived entry.', icon: 'Clock' },
          { label: 'Sort dropdown', detail: 'Sort the persona list by Name, Last Run, Runs, Cost, or Success Rate. In the panel header, next to the help icon.', icon: 'ArrowUpDown' },
          { label: 'Stat chips', detail: 'Inline success rate and 7-day cost chips on each persona card row. Color-coded: green ≥80%, amber ≥50%, red <50%.' },
          { label: 'Cost cap', detail: 'Set max_cost_usd in frontmatter (or via Edit modal) to auto-stop a persona session when its cost exceeds the limit. The sidebar shows a red "$cap" badge and a desktop notification fires. Budget-exceeded runs still count as successful in analytics.' },
          { label: 'Daily cap', detail: 'Set max_cost_per_day_usd in frontmatter (or via Edit modal) to skip persona launches when its trailing 24h spend reaches the cap. The cap uses a rolling 24h window (not a calendar day). Badge shows $spent / $cap today — amber at 75%, red at 100%. A one-time desktop notification fires when the cap is first hit; suppressed during rate limit pauses.' },
          { label: 'Monthly budget', detail: 'Set monthly_budget_usd in frontmatter (or via Edit modal) to auto-pause a persona when its cumulative monthly spend reaches the limit. A progress bar appears on the persona card: amber at 80%, red at 95%. When exceeded, the persona is disabled and a desktop notification fires. Resets on the 1st of each UTC month.' },
          { label: 'Edit persona settings', detail: 'Click the Pencil icon (list view) to open a quick-edit modal for schedule, model, max sessions, cost cap, trigger chains, and enabled state — without touching the raw markdown.', icon: 'Pencil' },
          { label: 'Trigger Chain Editor', detail: 'Edit on_complete_run and can_invoke in the config modal — select target personas from a dropdown, shown as removable chips. No raw markdown needed.' },
          { label: 'Fire Triggers When', detail: 'Condition that gates when on_complete_run triggers fire. Options: Always (default, triggers on every exit), Success only (exit 0), Has commits (only if ≥1 commit was made), Has changes (only if ≥1 file changed). Set via the "Fire Triggers When" dropdown in the Edit modal or via on_complete_run_if in frontmatter. Condition applies to all targets in on_complete_run; memory extraction always fires regardless. Trigger map edges show "if success" / "if has commits" / "if has changes" labels when a condition is set.' },
          { label: 'View File', detail: 'Open a read-only preview of the persona\'s raw markdown file.', icon: 'FileText' },
          { label: 'Edit File', detail: 'Open the persona\'s markdown file in a text editor. Edit any section and save — useful for updating Role, Objectives, or manually fixing the Active Situations block.', icon: 'Pencil' },
          { label: 'Run queue badge', detail: 'When a trigger or cron fires while the persona is already running, the run is queued (not dropped). A "N queued" badge appears on the tile. The queue pops automatically when the current session exits — one pop per exit to prevent thundering herd. Max queue depth: 5 (oldest trigger dropped with a warning). Queued runs preserve the original handoff context and trigger source. Draining personas flush their queue instead of popping.' },
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
          { label: 'Jira tab', detail: 'Auto-appears when a Jira ticket is attached (manually or auto-detected from branch name matching NP-XXXX pattern). Shows ticket key, status, summary, and full description. Click the key to open in browser. Configure pattern in Settings → Integrations.', icon: 'Ticket' },
          { label: 'Tab navigation', detail: 'Cmd+Shift+{ / Cmd+Shift+} cycles through the visible tabs (Session, Terminal, Files, Changes, Artifacts, plus Services/Logs when an environment is attached and Team/Metrics for Coordinator sessions). Works even when focus is inside a terminal or input — the Cmd+Shift combo never conflicts with typing `{`/`}`. Same shortcut works in Environments (Environments ↔ Templates).' },
        ],
      },
      {
        name: 'Header Info',
        position: 'Right side of tab bar',
        items: [
          { label: 'Git branch badge', detail: 'Shows the current git branch and repo name.', icon: 'GitBranch' },
          { label: 'Info button', detail: 'Opens a popover with launch command, PID, working directory, MCP servers, token usage, and child processes.', icon: 'Info' },
          { label: 'Export Session', detail: 'Save the session output as a markdown file. Includes terminal content, metadata, and git state.', icon: 'FileDown' },
          { label: 'Copy Output', detail: 'Copy the session output as markdown to the clipboard for pasting into docs, issues, or chat.', icon: 'Copy' },
          { label: 'Steer session', detail: 'Send a mid-run redirect message without stopping the session. If idle, the message is delivered immediately. If busy, it is queued and delivered the moment the session next becomes idle. Prefixed with [Operator steering]: so the agent recognises it as a course correction.', icon: 'Navigation' },
          { label: 'Cancel queued steer', detail: 'Dismiss a pending steering message before it is delivered. Appears as an X button next to the steer indicator when a message is queued.', icon: 'X' },
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
          { label: 'Auto-Judge', detail: 'Gavel button — two modes: Command runs a shell command (e.g. "npm test") in each session\'s directory, first to exit 0 wins. LLM launches a judge session that compares each pane\'s git diff against your criteria and picks a winner. After LLM judging, a verdict panel shows the judge\'s full reasoning. Dismiss the verdict by clicking ×. Stats are recorded automatically. Human can still override by clicking vote buttons. The LLM judge also sees up to 5 recent manual-pick reasons (captured when you click a vote button) — toggle in Settings.', icon: 'Gavel' },
          { label: 'Promote Winner', detail: 'After a winner is declared, a "Promote to <branch>" button appears alongside Reveal and Keep Winner Only. Click it to cherry-pick the winner\'s commits onto a new local branch from the source branch (e.g. arena-promote-<timestamp>). On success, loser worktrees are removed and a toast shows the promoted branch — push it from the Git panel. On conflict, the conflicting files are listed and the operation is rolled back cleanly. If the winner made no commits, the button is hidden.', icon: 'Rocket' },
          { label: 'Arena cleanup', detail: 'When exiting grid mode after an arena launch, you are prompted to remove all temporary worktrees (including winner if any). Use Keep Winner Only first to preserve the winner before cleaning up.' },
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
          { label: 'Cost', detail: 'Live session cost. Green under $1, amber $1–$5, red over $5. Hover for precise amount. Hidden until the session incurs cost.' },
          { label: 'Token counts', detail: 'Input (↓, blue) and output (↑, green) token counts in the status strip. Format: 12.3k↓ 4.1k↑ for ≥1000 tokens, exact for smaller. Hover for precise counts. Hidden until tokens are recorded. Not shown for non-Claude backends.' },
          { label: 'Ctx indicator', detail: 'Amber = context ≥ 250 KB output, red ≥ 600 KB. Consider checkpointing.' },
        ],
      },
      {
        name: 'Changed Files Panel',
        position: 'Below status strip (running sessions with uncommitted changes)',
        items: [
          { label: 'Changed Files panel', detail: 'When a session has uncommitted changes, a collapsible "N changed files" bar appears below the status strip. Click to expand a file list grouped by Staged/Unstaged. Each file row shows a status letter (M/A/D/U) and filename — click a row to see a rich diff with syntax highlighting, line numbers, and unified/split view toggle. Click the same file again to close the diff. Copy-to-clipboard button available in the diff header. Opens/closes state persists per session. After a session exits, the panel stays visible with a "(session ended)" label so you can review the final file state. The panel disappears only when the session is removed from the list.', icon: 'FileCode' },
        ],
      },
      {
        name: 'Children Panel',
        position: 'Below status strip (sessions that spawned child sessions)',
        items: [
          { label: 'Child sessions', detail: 'Collapsible list of sessions spawned by this one — from persona triggers, maker-checker pipelines, or manual child spawns. Shows status dot (running/waiting/done), name, cost, and state. Running-busy sessions sort to the top, exited sessions sort by cost.', icon: 'GitMerge' },
          { label: 'Navigate to child', detail: 'Click any child row to focus that session in the sidebar and main view.' },
          { label: 'Kill child', detail: 'Hover a running child row to reveal a stop button. Click to kill that session individually — without affecting siblings.', icon: 'Square' },
          { label: 'Cost rollup', detail: 'When 2+ children have usage data, a Σ total footer shows the combined cost and session count.' },
          { label: 'Stop all', detail: 'Kills all running child sessions at once. Prompts for confirmation before stopping.', icon: 'Square' },
          { label: 'Sidebar badge', detail: 'Parent tiles show a ⇣N accent badge when they have children. Click the badge to jump to the first child.' },
        ],
      },
      {
        name: 'Exited Session Bar',
        position: 'Below tab bar (exited sessions)',
        items: [
          { label: 'Exit badge', detail: '"Completed" (green) for exit code 0, "Failed (N)" (red) for non-zero exit codes. Gives immediate visual feedback on session outcome.' },
          { label: 'Duration', detail: 'How long the session ran (wall time from creation). Format: "ran 45m", "ran 2h 15m". Hover for exact start time.' },
          { label: 'Cost', detail: 'Session cost after completion. Green under $1, amber $1–$5, red over $5. Hover for precise amount. Hidden for zero-cost sessions.' },
          { label: 'Retry', detail: 'Opens a dialog pre-filled with the session name, working directory, and original prompt. Edit the prompt before launching — useful for tweaking a failed approach without retyping everything. Click Retry or press Cmd+Enter to launch. The exit code and duration are shown as read-only context. If you click Retry without editing, behavior is identical to an instant retry. Also available via right-click context menu in the sidebar.', icon: 'Play' },
          { label: 'Restart', detail: 'Re-launch the session with the same configuration. Same as the sidebar restart action.', icon: 'RotateCcw' },
          { label: 'Remove', detail: 'Remove the session from the sidebar entirely. Same as the sidebar remove action.', icon: 'X' },
        ],
      },
      {
        name: 'Error Summary Card',
        position: 'Above terminal (exited sessions with non-zero exit code)',
        items: [
          { label: 'Error card', detail: 'When a session exits with a non-zero exit code, the last ~2 KB of output is parsed for error patterns (Python tracebacks, Node stack traces, generic errors). A collapsible card shows the error type, message, file location, and context lines.', icon: 'AlertTriangle' },
          { label: 'Sidebar preview', detail: 'A 1-line error message appears below the working directory on the session tile in the sidebar, making it easy to spot what went wrong without clicking in.' },
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
          { label: 'Search button', detail: 'Click the magnifying glass in the terminal header to open/close the search bar. Also available via Cmd+F.', icon: 'Search' },
          { label: 'Search navigation', detail: 'Use the Next (Enter) and Previous (Shift+Enter) buttons in the search bar to jump between matches. The match counter shows your position (e.g. "3 of 12"). Press Escape to clear.' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Alt+1..N', action: 'Jump directly to the Nth visible tab' },
      { keys: 'Cmd+[ / ]', action: 'Cycle to previous / next tab' },
      { keys: 'Hold Cmd', action: 'Show shortcut hints on all UI elements (release to hide)' },
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
          { label: 'Quick open', detail: 'Press ⌘P from any tab to open a floating file search overlay. Fuzzy match — type characters in order (gaps allowed, VS Code style). Filename matches rank above path-only matches, then by path length. ↑↓ to navigate, Enter to open, ESC to dismiss. Selecting a file expands the tree to reveal its location. File type icons distinguish .ts, .json, .md, images, archives, and more.', icon: 'Search' },
          { label: 'Name filter', detail: 'Fuzzy-match the file tree by name — type characters in order (gaps allowed). Matching directories auto-expand.' },
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
          { label: 'Env repos', detail: 'When the session was launched from a multi-repo environment, sibling repo checkouts appear as collapsible roots below the primary tree (e.g. Newton: nri-server + nri-frontend). Preview, in-file search, content search, and Paste Path all work identically across roots.', icon: 'FolderTree' },
        ],
      },
      {
        name: 'Preview Pane',
        position: 'Right pane',
        items: [
          { label: 'File content', detail: 'Shows file contents with line numbers. Supports Cmd+F to search within the file.' },
          { label: 'Markdown rendering', detail: '.md / .markdown files render as formatted by default. Code blocks get syntax highlighting. Mermaid diagrams render inline (```mermaid fenced blocks). Toggle Source/Rendered in the preview header. Cmd+F auto-switches to source so search highlights work.', icon: 'Eye' },
          { label: 'Image preview', detail: 'Select PNG, JPG, SVG, GIF, WebP, BMP, or ICO files to see an inline preview on a checkered background. Dimensions appear in the header after load. SVG files have a Source/Rendered toggle to view the raw XML.', icon: 'Eye' },
          { label: 'HTML preview', detail: 'Select .html or .htm files to see a rendered preview in a sandboxed iframe. Toggle Source/Rendered to switch between rendered view and raw markup. Cmd+F auto-switches to source so in-file search works.', icon: 'Eye' },
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
          { label: 'Quick commands bar', detail: 'One-click shortcuts for common commands. Click a chip to run it instantly in the shell.' },
          { label: 'Customize', icon: 'Pencil', detail: 'Click the pencil icon to add, remove, or reset commands. Commands are saved per project and persist across restarts.' },
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
          { label: 'Embedded browser', detail: 'Full web browser rendering the selected service. Cookies and sessions are isolated per environment. Click-drag to select text, double-click to select a word.' },
          { label: 'Context menu', detail: 'Right-click inside the browser for a context menu with Back, Forward, Reload, Cut, Copy, Paste, Select All, and Inspect Element. Edit actions are context-aware (e.g., Copy is disabled when nothing is selected).' },
          { label: 'Error state', detail: 'If a service fails to load (e.g., not yet started), shows an error with a Retry button.' },
          { label: 'Split view', detail: 'Click the split button in the header to open a secondary pane alongside the browser. Pick any other tab (Logs, Services, Files, Changes, etc.) to display in the secondary pane. Drag the divider to resize, double-click to reset to 50/50.', icon: 'PanelRight' },
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
          { label: 'New task', detail: 'Open the new-task form. Fill in title, status, priority, assignee (dropdown of personas + custom option), and optional tags/description.', icon: 'Plus' },
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
          { label: 'Tag filter', detail: 'Show only tasks with a specific tag. Click a tag on any task card to quick-filter by that tag.' },
          { label: 'Sort dropdown', detail: 'Reorder tasks across all columns: Priority (default), Newest first, Oldest first, or A → Z alphabetically.', icon: 'ArrowUpDown' },
          { label: 'Clear filters', detail: 'Remove all active filters and show all tasks. Also clears the persisted filter state.' },
          { label: 'Filter persistence', detail: 'All filter and sort settings are saved to localStorage and restored when you return to the task board.' },
        ],
      },
      {
        name: 'Board columns',
        position: 'Main area',
        items: [
          { label: 'To Do / In Progress / Blocked / Done', detail: 'All four columns are always visible, even when empty. Each shows a task count in the header.' },
          { label: 'Quick add (+)', detail: 'Click the + icon in a column header to quickly add a task directly to that column.', icon: 'Plus' },
          { label: 'Archive done', detail: 'Trash icon in the Done column header — bulk-deletes all completed tasks after confirmation. Keeps the board clean.', icon: 'Trash2' },
          { label: 'Sorting', detail: 'Tasks within each column are sorted by the selected mode: Priority (Critical first, then recency), Newest, Oldest, or A → Z. Default is Priority.' },
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
          { label: 'Agent filter', detail: 'Dropdown to narrow results to a single agent/persona. Shows "N of M" count when active. Populated dynamically from all output entries.' },
          { label: 'Sort', detail: 'Sort the list by Newest, Oldest, Name A-Z, Name Z-A, Largest, or By Agent. Defaults to Newest (most recent first). Sort and agent filter persist across sessions.' },
          { label: 'Search', detail: 'Type to filter by name or agent ID. With 3+ characters, also searches inside file contents — matching lines appear as snippets below each result. A badge shows the total content match count.', icon: 'Search' },
          { label: 'Refresh', detail: 'Reload the file list from disk. Useful after a persona or pipeline run completes.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Viewer',
        position: 'Right pane',
        items: [
          { label: 'Markdown rendering', detail: 'Files ending in .md are rendered with rich formatting: syntax-highlighted code blocks (Python, JS/TS, Bash, JSON, YAML, and more), inline Mermaid diagrams for ```mermaid fenced blocks, copy-to-clipboard on code blocks, task list checkboxes, alternating table row colors, and styled headings with borders.' },
          { label: 'Size limit', detail: 'Files larger than 32KB are truncated with a notice at the end.' },
          { label: 'Diff with Previous', detail: 'Compare the selected file with the chronologically previous output from the same agent/persona. Shows a unified diff with green additions and red deletions. Enabled when the agent has 2+ output files. Click again to exit diff view.', icon: 'GitCompare' },
          { label: 'Copy Content', detail: 'Copy the full file contents to clipboard — not just the path. Shows a brief "Copied!" confirmation.', icon: 'ClipboardCopy' },
          { label: 'Send to Session', detail: 'Open a dropdown of sessions currently waiting for input. Clicking one injects the output content as a prompt. Content over 4KB is truncated with a warning. Closes the colony loop: output produced → output consumed.', icon: 'Send' },
          { label: 'Copy Path', detail: 'Copy the absolute file path to clipboard.', icon: 'Copy' },
          { label: 'Reveal in Finder', detail: 'Open the parent folder in Finder with the file selected.', icon: 'FolderOpen' },
          { label: 'Open in Editor', detail: 'Opens the output file in your default application. Uses the system file association — typically VS Code for .md and .json files.', icon: 'ExternalLink' },
          { label: 'Delete', detail: 'Permanently delete the output file. Shows a confirmation prompt first.', icon: 'Trash2' },
        ],
      },
    ],
    emptyState: {
      hook: 'Nothing here yet. Run a persona or pipeline to generate an artifact.',
    },
  },
  changesTab: {
    title: 'Changes (Git Diff)',
    description: 'Shows uncommitted file changes in the session\'s working directory (`git diff HEAD`). For sessions in worktree-backed environments, the diff is shown for the worktree repo root (not the env config directory). Each file can be reverted individually or all at once. If the working directory no longer exists, a clear error message is shown instead of a silent empty state. Review agents can annotate specific lines via COLONY_COMMENT sentinels — annotations appear inline below the file they reference.',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Diff mode toggle', detail: '"Working Tree" shows uncommitted changes in the current working directory (default). "vs <branch>" shows all files changed between the base branch (auto-detected) and HEAD — the same view as a GitHub PR diff. Switching modes clears the current file selection. The base branch is fetched via `gh repo view` at load time, defaulting to "main".' },
          { label: 'Branch chip', detail: 'Shows the current git branch. Click to open the branch switcher dropdown. Lists local branches with ahead/behind counts relative to the current branch (↑N = branch has N commits not in current; ↓N = current has N commits not in branch). Remote branches have merge buttons (cloud icon). Click any branch to switch via `git checkout`. A "↓N" behind-count badge appears when behind upstream. Delete (trash), Merge, and Rebase (GitCommit) buttons per branch row. Prune removes stale remote refs. Clicking Merge first shows a preview: file count, +/- stats, fast-forward indicator (FF), and up to 8 changed files. Confirm with the Merge button or Cancel to dismiss.', icon: 'GitBranch' },
          { label: 'Rename branch', detail: 'In the branch dropdown, the current branch entry shows a Pencil icon button. Click it to enter rename mode — the branch name becomes an editable input pre-filled with the current name. Press Enter or click Save to apply `git branch -m`. Press Escape to cancel. If the branch had a remote upstream, an amber notice reminds you to update the remote manually. Errors (invalid name, etc.) appear inline.', icon: 'Pencil' },
          { label: 'Pull button', detail: 'Appears next to the branch chip when the current branch is behind its upstream (e.g., "Pull 3"). Runs `git pull --ff-only`. On success, refreshes the branch info, file list, stashes, and checkpoints — behind count drops to 0. On failure (diverged history, merge conflict), shows the first line of the git error inline. Spinner shown during pull (can take 30s on large repos).', icon: 'ArrowDown' },
          { label: 'Refresh', detail: 'Reload the change list from git.', icon: 'RefreshCw' },
          { label: 'Stash', detail: 'Stash all uncommitted changes (including untracked files) using `git stash push --include-untracked`. Only visible when there are changes. A numbered badge appears when stashes exist — click it to open a dropdown listing each stash with its message and relative date. Eye (👁) button previews the stash diff in the main right pane without applying. Each entry also has Apply (restore without removing), Pop (restore and remove), and Drop (delete) actions. Click a file in the stash preview to see its diff in isolation — per-file diff view shows only that file\'s changes.', icon: 'Archive' },
          { label: 'Stage & Commit', detail: 'Open a commit dialog to stage selected files and commit (or commit & push) directly from the UI. Shows branch info, file checklist with select/deselect, insertion/deletion stats. Click any file row\'s name to expand an inline diff preview (accordion — one file at a time, capped at 200 lines). When on main/master, an amber banner warns and offers inline branch creation. If a Jira ticket was attached at session start, the commit subject is pre-filled from the ticket summary and the branch name field is seeded from the ticket key + summary. A "Refs <key>" footer is automatically appended to the commit body. Ctrl+Enter (Cmd+Enter on Mac) submits. Push button only appears when a remote is configured. The Suggest button (Sparkles icon) sends the staged diff to Claude and populates a conventional commit message — type prefix included. Check "Amend last commit" to update the previous commit instead of creating a new one — the message is pre-filled from the last commit. After committing (before push), an "Undo Commit" button runs git reset --soft HEAD~1 to safely reverse the commit — files return to staged state. After a successful push on a non-default branch, a "Create PR" button appears — fill in the title (pre-filled from commit message), optional description, and base branch. Check "Draft" to create a draft PR. If the repo has a `.github/pull_request_template.md`, the body is pre-filled from it automatically (indicated by a "(from template)" note). Click Create PR to open one via the gh CLI. The PR URL is clickable and opens in your browser.', icon: 'GitCommit' },
          { label: 'Score Output', detail: 'Run an LLM-as-Judge assessment on the current diff. Returns a 1–5 confidence score, scope creep warning, test coverage indicator, and 2-3 sentence summary. Powered by claude-haiku. Results are cached by diff hash — switching tabs and back restores the card instantly with no extra token cost.', icon: 'Sparkles' },
          { label: 'Save Checkpoint', detail: 'Create a lightweight git tag at the current HEAD, saving a named restore point for this session. Tags are namespaced per-session (colony-cp/<session-id>/<timestamp>) so they don\'t collide across sessions. Appears in the checkpoint timeline below.', icon: 'Bookmark' },
          { label: 'Revert All', detail: 'Revert every changed file to HEAD. A confirmation dialog appears first — this cannot be undone.', icon: 'Undo2' },
          { label: 'File search', detail: 'Filter the file list by name. Only visible when there are changed files. Escape clears the filter and returns keyboard focus.', icon: 'Search' },
          { label: 'Auto-refresh', detail: 'The change list refreshes automatically every 10 seconds while this tab is open.' },
        ],
      },
      {
        name: 'File List',
        position: 'Main area',
        items: [
          { label: 'Status letter', detail: 'M = modified, A = added, D = deleted, R = renamed. Color-coded: amber for M, green for A, red for D.' },
          { label: 'File path', detail: 'Relative path of the changed file within the working directory. Click to select — diff renders in the right pane. `j`/`k` navigate files, `Escape` clears selection. Right-click a file to open a context menu with "File History", "Blame", and "Add to .gitignore".' },
          { label: 'Add to .gitignore', detail: 'Right-click a file and choose "Add to .gitignore" to append its path to `.gitignore` (creates the file if needed). For tracked files, the label changes to "Add to .gitignore (stop tracking)" — confirms before running `git rm --cached`. Duplicate patterns are silently skipped. File list refreshes automatically.', icon: 'EyeOff' },
          { label: '+/- counts', detail: 'Number of inserted lines (green) and deleted lines (red) in the diff.' },
          { label: 'Diff pane', detail: 'Selecting a file loads a color-coded diff in the right pane with syntax highlighting (language auto-detected from file extension). Toggle between Unified (interleaved) and Split (side-by-side) view using the button in the top-right. Split view aligns old code on the left and new code on the right, with empty padding rows for unmatched lines. Mode preference persists in localStorage. Large diffs (500+ lines) are truncated with a "Show full diff" button. Binary files show a placeholder. Review agent annotations appear below the diff.' },
          { label: 'Revert button', detail: 'Reverts that single file to HEAD via `git checkout HEAD -- <file>`. Confirmation required.', icon: 'Undo2' },
          { label: 'Empty state', detail: 'Shows "No uncommitted changes" when the working tree is clean.' },
        ],
      },
      {
        name: 'Checkpoints',
        position: 'Below file list (collapsible)',
        items: [
          { label: 'Checkpoint timeline', detail: 'Collapsible section showing all checkpoint tags for this session, sorted newest-first. Each row shows timestamp, short commit hash, and the ISO tag name. Click a row to preview the diff from that checkpoint to HEAD.' },
          { label: 'Diff preview', detail: 'Expanding a checkpoint row shows the full diff between the checkpoint and the current HEAD, using the same color-coded diff viewer as the file list.' },
          { label: 'Restore', detail: 'Creates a new branch from the checkpoint commit (non-destructive). Your current branch stays intact — no data is lost. A confirmation dialog shows the branch name before proceeding.', icon: 'GitBranch' },
          { label: 'Delete checkpoint', detail: 'Removes the git tag for this checkpoint. Does not affect the underlying commit or code.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Commits',
        position: 'Below checkpoints (collapsible)',
        items: [
          { label: 'Commit history', detail: 'Collapsible section listing the last 20 commits on the current branch. Shows short hash, subject, relative date, and inline diff stats (+N -N Nf) per row. Lazy-loads on first open. Click any row to expand it and view the full commit diff.', icon: 'GitCommit' },
          { label: 'Unpushed badge', detail: 'Commits ahead of the upstream remote are marked with a purple "unpushed" chip. The section header also shows the count: "Commits (3 unpushed)". Unpushed detection uses `git log origin/<branch>..HEAD`.' },
          { label: 'Commit diff', detail: 'Clicking a commit row expands the full diff for that commit using the same color-coded viewer as the file list. Only one commit diff is shown at a time — clicking another row collapses the previous one.' },
          { label: 'Cherry-pick', detail: 'Each commit row has a cherry-pick button (⇒ icon). Clicking it shows an inline confirmation: "Cherry-pick <hash> into <branch>?" with the commit subject. On success, the change list and commit history refresh. On conflict, shows the git error with an "Abort cherry-pick" button to run `git cherry-pick --abort`.', icon: 'ChevronsRight' },
          { label: 'Revert commit', detail: 'Each commit row has a revert button (↩ icon) that creates a new commit undoing the selected change. Shows an inline confirmation with the commit hash and subject. Disabled on merge commits. On conflict, shows an "Abort revert" button.', icon: 'Undo2' },
          { label: 'Commit search', detail: 'Search bar at the top of the Commits section. Enter 2+ characters to search commit messages via `git log --grep` (case-insensitive, all branches). Results replace the normal paginated view. Clear with the ✕ button or Escape.', icon: 'Search' },
          { label: 'Author filter', detail: 'Once commits load, an "Author" chip appears next to the search bar. Click it to open a dropdown of all known authors. Select an author to filter the log to only their commits via `--author=<name>`. The filter combines with text search — both can be active at once. Click ✕ on the chip or select "All Authors" to clear.', icon: 'Search' },
          { label: 'Branch from commit', detail: 'Each commit row has a branch button (branching icon). Click it to open an inline name input pre-filled with a slug from the commit subject. Press Enter or "Create" to run `git checkout -b <name> <hash>` — creates and switches to the new branch. Escape or "Cancel" dismisses.', icon: 'GitBranch' },
          { label: 'Commit file list', detail: 'Expanding a commit also loads a compact file list above the diff (via `git diff --name-status`). For commits with 4+ files the list opens automatically; for ≤3 files it is collapsed. Click the header to toggle. Each row shows: status badge (A/M/D/R), file path, and per-file +/- counts. Helps navigate large commits without scrolling through the full diff.', icon: 'ChevronRight' },
          { label: 'Diff stats', detail: 'Each commit row shows inline diff stats in muted green/red: +insertions -deletions (Nf files changed). Loaded in the same `git log --shortstat` call — no extra round-trips. Shown in both the Commits section and File History panel.' },
          { label: 'Copy hunk', detail: 'Hover over any hunk header (@@…@@) in the diff viewer to reveal a Clipboard button. Click it to copy the raw patch for that hunk to the clipboard — includes the @@ header line so it is a valid patch fragment. The icon swaps to a checkmark for 2 seconds as confirmation. Works in both unified and split view, in all diff contexts (not just working-tree).', icon: 'Clipboard' },
          { label: 'Compare two commits', detail: 'Check the checkbox on any two commit rows, then click the "Compare" button in the blue bar that appears. The diff between the two commits (older→newer, via `git diff`) appears inline below the header. A "Comparing abc..def" header shows the two short hashes with a Close (✕) button to return to normal mode. Selection is cleared when switching Working Tree / vs Base modes.', icon: 'GitCompare' },
          { label: 'Squash commits', detail: 'Check 2 or more consecutive unpushed commits starting from HEAD, then click "Squash N" in the blue selection bar. Opens the commit dialog pre-filled with all selected commit messages (oldest first). Edit the combined message and click "Squash" to merge the commits into one via `git reset --soft`. Only available for consecutive, unpushed commits — prevents accidentally squashing already-pushed history.', icon: 'GitMerge' },
          { label: 'Interactive rebase', detail: 'Click the "Rebase…" button in the Commits section header to open the interactive rebase panel. Shows all loaded commits oldest-first (matching git rebase-todo order). Each row has a drag handle for reordering, an action dropdown (pick/reword/squash/fixup/drop), short hash, and subject. "reword" expands an inline textarea to edit the commit message. "drop" dims the row and removes that commit. Drag rows to reorder. Click "Start Rebase" to run `git rebase -i`. If conflicts arise, the panel closes and the conflict banner activates. "Cancel" closes the panel without running anything.', icon: 'ListOrdered' },
          { label: 'Git bisect', detail: 'Click the "Bisect" button in the Commits section header to open the bisect wizard. Enter a bad commit (hash or HEAD) and a known-good commit (hash, tag, or branch), then click "Start Bisect". Git checks out midpoint commits for you to test. Click "Bad" (the bug is present) or "Good" (no bug) after testing each commit. Git narrows down the range — typically ~log₂(N) steps. When done, the first bad commit is shown with its hash and subject. Click "End Bisect" to return to your original branch. "Abort" cancels at any point.', icon: 'Crosshair' },
          { label: 'Load more', detail: 'After the initial 20 commits, a "Load more..." button appends the next 20. Pagination uses `git log --skip=N`. Hidden when search is active.' },
          { label: 'Conflict banner', detail: 'When a merge, cherry-pick, revert, or rebase encounters conflicts, an amber banner appears at the top of the changes panel. Shows the operation type and count of conflicted files. Once all conflicts are resolved: for merge/cherry-pick/revert shows a "Complete" button (`git commit --no-edit`); for rebase shows a "Continue Rebase" button (`git rebase --continue`). "Abort" cancels the in-progress operation.', icon: 'AlertTriangle' },
          { label: 'Conflict resolution buttons', detail: 'Conflicted files in the file list show inline resolution buttons: "Ours" runs `git checkout --ours -- <file>` then stages it (keeps your version); "Theirs" runs `git checkout --theirs -- <file>` then stages it (takes the incoming version); "Resolved" stages the file with `git add` after you have manually removed conflict markers. After clicking any button, the conflict count on the banner updates automatically.', icon: 'AlertTriangle' },
          { label: 'Rebase onto branch', detail: 'Each branch row in the branch picker has a rebase button (GitCommit icon) that rebases the current branch onto the selected branch. Click to show an inline confirm — "Rebase <current> onto <branch>?". On success, refreshes the branch and file list. On conflict, closes the dropdown and activates the conflict banner. When all conflicts are resolved, a "Continue Rebase" button appears. "Abort" runs `git rebase --abort`.', icon: 'GitCommit' },
        ],
      },
      {
        name: 'Tags',
        position: 'Below Commits (collapsible)',
        items: [
          { label: 'Tags section', detail: 'Collapsible section listing all git tags in the repository sorted by date (newest first). Each row shows the tag name, short hash, and creation date. Lazy-loads on first open.', icon: 'Bookmark' },
          { label: 'New Tag button', detail: 'Opens an inline form to create a new tag. Enter a tag name (e.g. v1.0.0) and an optional message. With a message, creates an annotated tag (`git tag -a <name> -m <message>`). Without, creates a lightweight tag. Press Enter or click Create. The tag list refreshes on success.', icon: 'Bookmark' },
          { label: 'Push tag', detail: 'Cloud icon button on each tag row. Pushes that specific tag to origin (`git push origin <tagname>`). Only this tag is pushed — not all tags.', icon: 'Cloud' },
          { label: 'Delete tag', detail: 'Trash icon button on each tag row. Requires inline confirmation (Confirm/Cancel) before running `git tag -d`. Local delete only — does not push deletion to remote.', icon: 'Trash2' },
          { label: 'Refresh', detail: 'Refresh button reloads the tag list from git.' },
        ],
      },
      {
        name: 'Remotes',
        position: 'Below Tags (collapsible)',
        items: [
          { label: 'Remotes section', detail: 'Collapsible section listing all configured git remotes with their name and fetch URL. Lazy-loads on first open. Remote count badge shown when collapsed.', icon: 'Cloud' },
          { label: 'Fetch button', detail: 'RefreshCw icon on each remote row. Runs `git fetch <remote>` to download refs from that specific remote. Shows a spinner during fetch.', icon: 'RefreshCw' },
          { label: 'Remove button', detail: 'Trash icon (non-origin remotes only). Runs `git remote remove <name>` after inline confirm/cancel. After removal the remote branch list updates automatically.', icon: 'Trash2' },
          { label: 'Add Remote (+)', detail: '+ button in the section header opens an inline form with name and URL inputs. Validates name (letters/digits/underscores/hyphens/dots only). After adding, auto-fetches the new remote. Shows inline error if the name already exists or URL is unreachable.', icon: 'Plus' },
        ],
      },
      {
        name: 'Reflog',
        position: 'Below Remotes (collapsible)',
        items: [
          { label: 'Reflog section', detail: 'Collapsible section showing the last 20 git reflog entries — a complete history of where HEAD has pointed. Each row shows: short hash (7 chars), action description (e.g. "rebase: checkout main"), and relative time. Lazy-loads on first open. Persists expanded/collapsed state.', icon: 'History' },
          { label: 'Checkout button', detail: 'Git branch icon. Runs `git checkout <hash>` to move HEAD to that commit in detached HEAD state. A confirmation dialog warns you before proceeding. Use this to inspect old state without changing your branch.', icon: 'GitBranch' },
          { label: 'Reset Here button', detail: 'RotateCcw icon. Runs `git reset --hard <hash>` — discards all commits and changes after that point. This is destructive and cannot be undone. A confirmation dialog shows the action description before proceeding.', icon: 'RotateCcw' },
          { label: 'Load more', detail: '"Load more" button at the bottom paginates by 20 additional entries when the reflog has more history beyond the current view.' },
        ],
      },
      {
        name: 'File History',
        position: 'Right pane (replaces diff when active)',
        items: [
          { label: 'File History panel', detail: 'Right-click any file in the file list and select "File History" to view commits that touched that file. Uses `git log --follow` to track across renames. Shows last 20 commits — click any row to expand and view the file-scoped diff for that commit. "Load more" paginates.', icon: 'History' },
          { label: 'Back button', detail: 'ArrowLeft button returns to the normal diff view, restoring the previously selected file diff.', icon: 'ArrowLeft' },
          { label: 'File-scoped diff', detail: 'Expanding a commit row shows only the changes to that specific file in that commit (`git diff hash~1 hash -- file`). First-commit diffs use `git show` since there is no parent.' },
        ],
      },
      {
        name: 'Blame View',
        position: 'Right pane (replaces diff when active)',
        items: [
          { label: 'Blame panel', detail: 'Right-click any file in the file list and select "Blame" to view line-by-line authorship. Uses `git blame --porcelain`. Shows: line number, short hash (7 chars), author name, date, and line content. Lines from the same commit share a subtle background — only the first line of each group shows the hash/author/date.', icon: 'GitMerge' },
          { label: 'Uncommitted lines', detail: 'Lines with uncommitted changes show "WIP" instead of a hash, in a distinct color.' },
          { label: 'Commit diff panel', detail: 'Click any commit hash in the blame view to expand the full diff for that commit in a split panel below. Click again or the X button to close. Only one diff shown at a time.' },
          { label: 'Back button', detail: 'ArrowLeft button closes the blame view and returns to the normal diff view.', icon: 'ArrowLeft' },
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
    description: 'Cross-session diff review — see uncommitted changes and unpushed commits in one view. Two tabs: Changes (per-session working-tree diffs) and Commits (committed-but-not-pushed history with inline diffs).',
    zones: [
      {
        name: 'Header',
        position: 'Top bar',
        items: [
          { label: 'Changes tab', detail: 'Uncommitted working-tree changes across all sessions. Shows per-session file diffs.', icon: 'GitCompare' },
          { label: 'Commits tab', detail: 'Committed-but-unpushed changes (origin/main..HEAD). Badge shows count. Click to see per-commit diffs.', icon: 'GitCommit' },
          { label: 'File search', detail: 'Type to filter the file list by path substring (case-insensitive). Sessions with no matching files are hidden. Shows filtered/total count on each card. Esc clears the search.', icon: 'Search' },
          { label: 'Filter toggle', detail: 'Switch between "Changed" (only sessions with uncommitted changes) and "All" (every session with a working directory). Only visible on the Changes tab.', icon: 'Filter' },
          { label: 'Fetch', detail: 'Fetch latest changes from the remote without merging. Updates the behind-count indicator.', icon: 'Download' },
          { label: 'Pull', detail: 'Pull upstream changes (fast-forward only). Only visible when behind the remote. Warns if there are uncommitted changes.', icon: 'ArrowDown' },
          { label: 'Push', detail: 'Push all unpushed commits to origin. Only visible on the Commits tab when commits exist. Warns with a confirmation dialog when pushing to main/master.', icon: 'Upload' },
          { label: 'Refresh', detail: 'Manually re-fetch git changes for all sessions. Also auto-refreshes every 30 seconds.', icon: 'RefreshCw' },
        ],
      },
      {
        name: 'Summary Bar',
        position: 'Below header',
        items: [
          { label: 'Change totals', detail: 'Total files changed, sessions with changes, and aggregate insertions/deletions across all sessions.' },
          { label: 'Branch switcher', detail: 'Click the branch name in the commits summary bar to open the branch picker. Type to filter branches by name (case-insensitive). Current branch always appears first with a divider below. Arrow keys navigate the list, Enter selects, Escape closes. Warns if there are uncommitted changes.', icon: 'GitBranch' },
          { label: 'Branch search', detail: 'The branch picker includes a search field auto-focused on open. Substring match filters the list as you type. "No matching branches" shown when filter yields zero results. Search clears automatically when you close and reopen the picker.', icon: 'Search' },
          { label: 'Behind indicator', detail: 'Shows how many commits the local branch is behind upstream. Fetch to update, Pull to merge.', icon: 'ArrowDown' },
        ],
      },
      {
        name: 'Session Cards',
        position: 'Main area (Changes tab)',
        items: [
          { label: 'Session name', detail: 'Color-coded dot + session name. Click to expand and see per-file changes.' },
          { label: 'Status badge', detail: 'Shows whether the session is running or exited.' },
          { label: 'File count + stats', detail: 'Number of changed files with total insertions (green) and deletions (red).' },
          { label: 'Branch name', detail: 'Git branch the session is working on, if available.' },
          { label: 'Commit', detail: 'Open the commit dialog for this session. Stage files, write a message, and optionally push — without leaving the review dashboard.', icon: 'GitCommit' },
          { label: 'Open in terminal', detail: 'Jump to this session in the Sessions view.', icon: 'Terminal' },
          { label: 'Copy branch', detail: 'Copy the branch name to clipboard.', icon: 'Copy' },
          { label: 'Open folder', detail: 'Open the session working directory in Finder.', icon: 'FolderOpen' },
          { label: 'Revert all', detail: 'Discard all uncommitted changes for this session. Confirmation required — this cannot be undone.', icon: 'Undo2' },
          { label: 'Branch warning', detail: 'When committing on main/master, an amber banner suggests creating a feature branch first. Type a name and click Create Branch to switch before committing.', icon: 'GitBranch' },
        ],
      },
      {
        name: 'Expanded File List',
        position: 'Left pane when session expanded (Changes tab)',
        items: [
          { label: 'Two-pane layout', detail: 'Changes tab uses a persistent split view: left pane shows the session/file list, right pane shows the selected file\'s diff. No more inline expand — clicking a file loads its diff in the right pane immediately.' },
          { label: 'Keyboard navigation', detail: 'Press j / ArrowDown or k / ArrowUp to move between files without using the mouse. Escape clears the selection. Focus must be inside the file list (click any file row first). Navigation is blocked when a commit dialog is open or focus is in a text field.' },
          { label: 'File status', detail: 'A = Added (green), M = Modified (yellow), D = Deleted (red), R = Renamed, ? = Untracked.' },
          { label: 'File path', detail: 'Full path of the changed file. Click to load its diff in the right pane. Selected row is highlighted with an accent border.' },
          { label: 'Diff viewer', detail: 'Right pane shows the selected file\'s diff with syntax highlighting (auto-detected). Toggle Unified/Split view in the toolbar. Diff is lazy-loaded and cached — rapid j/k navigation stays fast. In working-tree mode, each hunk header shows a + (stage) and trash (discard) button on hover — stage or discard individual hunks without touching the rest of the file.' },
          { label: 'Stage hunk', detail: 'In the diff viewer, hover over a hunk header (@@ line) to reveal a green + button. Click it to stage just that hunk via `git apply --cached`. The diff refreshes automatically. Only shown in Working Tree mode (not Base-branch diff).', icon: 'Plus' },
          { label: 'Discard hunk', detail: 'In the diff viewer, hover over a hunk header (@@ line) to reveal a red trash button. Click it to discard just that hunk from the working tree via `git apply --reverse`. The diff refreshes automatically. Only shown in Working Tree mode.', icon: 'Trash2' },
          { label: 'Hide whitespace', detail: 'Toggle button in the diff header (EyeOff icon) — when active, the diff is re-fetched with `-w` (ignore all whitespace). Useful for reviewing formatting changes without noise. State persists in localStorage. Works in both Working Tree and vs Base modes.', icon: 'EyeOff' },
          { label: 'Copy diff', detail: 'Copy the full diff for the selected file to clipboard. Button appears in the sticky header above the diff, next to the filename. Icon toggles to a checkmark for 2 seconds as confirmation.', icon: 'Copy' },
          { label: 'Multi-select', detail: 'Check the checkbox on each file row (Working Tree mode only) to select it. Shift+click selects a range; the checkbox click does not open the diff. When 2+ files are checked, a bulk action bar appears above the list: Stage All, Unstage All, Stash (selected files only), Revert All, Select All, Deselect All. Selected files are lightly highlighted. Selection clears on any refresh.', icon: 'CheckCircle' },
          { label: 'Insertions / Deletions', detail: 'Per-file line counts: green for additions, red for removals.' },
          { label: 'Open file', detail: 'Open the changed file in your default editor or application. Appears on hover. Disabled for deleted files (status D).', icon: 'ExternalLink' },
          { label: 'Revert file', detail: 'Undo changes to a single file (git checkout). Appears on hover. Confirmation required — cannot be undone. Disabled for untracked files.', icon: 'Undo2' },
        ],
      },
      {
        name: 'Commit List',
        position: 'Main area (Commits tab)',
        items: [
          { label: 'Two-pane layout', detail: 'Commits tab uses a persistent split view: left pane shows the unpushed commit list, right pane shows the selected commit\'s full diff. No inline expand — clicking a commit loads its diff in the right pane immediately.' },
          { label: 'Commit search', detail: 'Filter commits by subject or hash prefix (case-insensitive). Type in the search box to narrow the list. Escape clears.', icon: 'Search' },
          { label: 'Commit row', detail: 'Short hash (7 chars), subject, author, and relative date. Click to select and load the diff in the right pane. Selected row is highlighted with an accent border.' },
          { label: 'Keyboard navigation', detail: 'Press j / ArrowDown or k / ArrowUp to move between commits without using the mouse. Escape clears the selection. Focus must be inside the commit list (click any row first). Navigation is blocked when focus is in a text field.' },
          { label: 'Diff viewer', detail: 'Right pane shows the selected commit\'s full diff with syntax highlighting. Lazy-loaded and cached — rapid j/k navigation stays fast.' },
          { label: 'Empty state', detail: 'Shows when all commits are pushed to origin.' },
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
          { label: 'Worker drill-down', detail: 'Click any worker row to expand and see their recent individual runs with status, duration, and cost. Filter by success/failed.', icon: 'ChevronDown' },
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
  artifacts: {
    title: 'Session Artifacts',
    description: 'Browse the history of what every session produced — commits, file changes, costs, and durations. Artifacts are collected automatically when sessions exit.',
    zones: [
      {
        name: 'Session List',
        position: 'Main area',
        items: [
          { label: 'Session row', detail: 'Each row shows the session name, commit-type tags (feat, fix, ux, etc.), persona badge, git branch, commit count, insertions/deletions, cost, and relative time. Click to expand.', icon: 'Archive' },
          { label: 'Commit-type tags', detail: 'Colored badges extracted from conventional commit prefixes (feat, fix, ux, refactor, test, chore). Use the type filter chips to show only sessions of a specific type.' },
          { label: 'Exit status dot', detail: 'Green = exited successfully (code 0). Red = non-zero exit code (error or cancellation).', icon: 'Circle' },
          { label: 'Pipeline badge', detail: 'Artifacts from pipeline-triggered sessions show an amber lightning bolt badge. Hover for the pipeline run ID.', icon: 'Zap' },
          { label: 'Expanded view', detail: 'Shows one-line summary, full commit list (hash + message), file change list (with M/A/D/R status), duration, and cost.', icon: 'FileText' },
          { label: 'Session tile summary', detail: 'Exited sessions in the sidebar show a one-line summary below the title — e.g. commit messages and files changed. Loaded automatically from the most recent artifact.' },
        ],
      },
      {
        name: 'Summary Strip',
        position: 'Below header',
        items: [
          { label: 'Time filter', detail: 'Today / 7 days / All — filters both the summary stats and the artifact list.', icon: 'Clock' },
          { label: 'Aggregate stats', detail: 'Total sessions, commits, insertions, deletions, cost, and duration for the selected time range.' },
        ],
      },
      {
        name: 'Controls',
        position: 'Below summary',
        items: [
          { label: 'Filter', detail: 'Text search across session names and persona names.', icon: 'Search' },
          { label: 'Sort', detail: 'Sort by: Newest (default), Most changes (insertions + deletions), or Highest cost.', icon: 'Filter' },
          { label: 'Type filter', detail: 'Filter artifacts by conventional commit type (feat, fix, ux, etc.). Shows counts per type. Click a type to toggle, click again to clear.' },
          { label: 'Select', detail: 'Enter multi-select mode to pick two sessions for comparison. Checkboxes appear on each row (max 2).', icon: 'CheckSquare' },
          { label: 'Clear All', detail: 'Permanently removes all stored artifacts. Cannot be undone.', icon: 'Trash2' },
        ],
      },
      {
        name: 'Compare',
        position: 'Full-panel view after selecting 2 artifacts',
        items: [
          { label: 'Compare button', detail: 'Appears when exactly 2 sessions are selected. Opens a side-by-side comparison of metrics and file changes.', icon: 'ArrowLeftRight' },
          { label: 'Metrics table', detail: 'Duration, cost, commits, insertions, deletions, and exit code for both sessions. Delta column shows percentage difference. The better value (lower cost, lower duration, successful exit) is highlighted green.' },
          { label: 'File overlap', detail: 'Files touched by both sessions are highlighted amber. Files unique to each session are listed separately. Helps identify overlapping vs. divergent approaches.' },
          { label: 'Back button', detail: 'Return to the artifact list. Your selection is preserved so you can re-compare or pick different sessions.' },
        ],
      },
      {
        name: 'Data Notes',
        position: 'Reference',
        items: [
          { label: 'Collection', detail: 'Artifacts are collected fire-and-forget when sessions exit. Sessions with no git activity may not produce artifacts.' },
          { label: 'Capacity', detail: 'The ring buffer stores up to 200 session artifacts. Oldest entries are evicted as new ones arrive.' },
          { label: 'Cost tracking', detail: 'Cost is captured from the session\'s PTY output if available. Some sessions may show no cost data.', icon: 'DollarSign' },
        ],
      },
    ],
    emptyState: {
      hook: 'Session artifacts appear here after sessions exit.\nRun some sessions and come back to see what they produced.',
    },
  },

  arena: {
    title: 'Arena Mode',
    description: 'Run the same prompt across multiple sessions in parallel and compare results. Use blind mode to eliminate bias, then vote or auto-judge to pick a winner.',
    zones: [
      {
        name: 'Launch',
        position: 'Launch dialog (Swords icon in grid toolbar)',
        items: [
          { label: 'Repository & Branch', detail: 'Select a tracked GitHub repo and branch. Each arena pane gets its own git worktree.' },
          { label: 'Pane Count', detail: 'Run 2\u20134 sessions in parallel. Each gets an isolated worktree from the same branch.' },
          { label: 'Model Override', detail: 'Optionally set a different model per pane to compare model performance head-to-head.' },
          { label: 'Shared Prompt', detail: 'The prompt sent to all panes simultaneously. All sessions start from the same state.' },
          { label: 'Quick Compare', detail: 'Open from the command palette (Cmd+Shift+C) or the Actions menu. Simplified dialog: enter a prompt, check 2-3 models, and launch. Repo and branch are inferred from the active session. Falls back to manual entry if no session is active.', icon: 'Swords' },
        ],
      },
      {
        name: 'Judge',
        position: 'Judge dialog (Gavel icon in arena toolbar)',
        items: [
          { label: 'Command Judge', detail: 'Run a shell command (e.g., test suite) in each worktree. Pass/fail determines the winner.', icon: 'Terminal' },
          { label: 'LLM Judge', detail: 'An AI evaluator reads the diffs from each pane and picks a winner based on criteria you define.', icon: 'Bot' },
          { label: 'Re-judge', detail: 'After a verdict, the Judge button becomes Re-judge. Clears the current winner, re-blinds panes, and opens the judge dialog to run again.', icon: 'Gavel' },
        ],
      },
      {
        name: 'Leaderboard',
        position: 'Trophy icon in arena toolbar',
        items: [
          { label: 'Win/Loss Stats', detail: 'Cumulative record across all arena rounds. Shows win rate percentage. Click a row to expand match history.', icon: 'Trophy' },
          { label: 'Match History', detail: 'Click a leaderboard row to see that session\'s individual matches — date, opponent, W/L, judge type (manual/command/LLM), and prompt preview. Click a match row for full details including verdict text.  Use the Replay button to re-launch the same match configuration.' },
          { label: 'Replay', detail: 'In the match detail panel, click Replay to re-launch the arena with the same participant count, model overrides, and prompt. You still pick the repo and branch. Only available for matches that had a prompt.', icon: 'RotateCcw' },
          { label: 'Voting', detail: 'In blind mode, panes are anonymized. Click a pane to vote it as the winner. Toggle blind mode with the eye icon.', icon: 'EyeOff' },
          { label: 'Clear Stats', detail: 'Trash icon in the leaderboard header. Clears all arena win/loss data and match history. Requires confirmation.', icon: 'Trash2' },
          { label: 'Learning footer', detail: 'When you have manual picks with reasons, the Leaderboard footer shows a count — click it to see the exact text the LLM judge will receive as preference history.', icon: 'Brain' },
        ],
      },
    ],
    shortcuts: [
      { keys: 'Click pane', action: 'Vote for winner (blind mode)' },
    ],
  },
}
