# Video 1: Claude Colony in 3 Minutes

**Total runtime:** 3:20 - 3:30
**Format:** Screen recording with text captions. No voiceover.
**Resolution:** 1440x900 or 1920x1080 (consistent with Video 2)

## Setup Before Recording

1. Complete all items in the Pre-Recording Checklist in `demo-data.md`
2. **Before the Colony window**, arrange 4-5 overlapping terminal windows on screen, each with a different Claude CLI session running or an IDE open. Make it look messy and overwhelming -- this is the "before" shot.
3. Have Colony ready but behind those windows, or use a hard cut. Start the real recording with Colony already open showing the **Sessions view** (default).
4. Have 3 sessions running: `onboarding-review` (pinned, blue, idle), `dashboard-fix` (amber, busy/pulsing), `auth-refactor` (green, idle)
5. The `dashboard-fix` session should be selected/active in the main pane, showing Claude mid-work in the terminal (some visible conversation)
6. Window positioned cleanly, no overlapping windows

---

## Shot List

### Shot 1: The Problem (0:00 - 0:05)

**What's on screen:** A cluttered desktop with 4-5 overlapping terminal windows, each running a separate Claude CLI session. Tabs everywhere. Maybe an IDE behind them. The visual impression should be: this is chaos.

**Action:** Hold for 3 seconds. Then quick-cut to the Colony window (Shot 2). No animation, no transition -- just a hard cut.

**Caption** (0:00 - 0:05, center of screen):
```
Running multiple Claude sessions?
```

**Duration:** 5 seconds

---

### Shot 2: The Solution -- Your Workspace (0:05 - 0:15)

**What's on screen:** Full Colony app view. Clean, organized. Sidebar on the left with 3 sessions listed (pinned section, active section). Main pane showing the `dashboard-fix` terminal with Claude actively working (pulsing amber dot in sidebar). Status bar at the bottom showing "3 running", branch name, model, CPU/memory stats.

**Action:** Hold still. Let the viewer absorb the contrast with the previous shot for 2 seconds. Then slowly mouse over the sidebar -- hover over the pulsing dot on `dashboard-fix` (busy), then the solid dot on `auth-refactor` (idle/waiting).

**Caption 1** (0:05 - 0:09, top center):
```
One window. Every session organized.
```

**Caption 2** (0:10 - 0:15, near sidebar):
```
Pulsing dot = Claude is working. Solid dot = waiting for you.
```

**Duration:** 10 seconds

---

### Shot 3: Creating a Session (0:15 - 0:30)

**What's on screen:** Starting from the previous view.

**Action:**
1. Click the `+ New Session` button at the top of the sidebar (0:15)
2. The New Session dialog appears. Type `dep-upgrade` in the Name field (0:18)
3. Click the color swatch to pick purple (#8b5cf6) (0:20)
4. Click "Browse" to set working directory, navigate to your project folder, click Open (0:22)
5. Click "Create" (0:25)
6. The session appears in the sidebar and opens in the main pane. Claude CLI starts up with its welcome message. (0:27)
7. Wait for the CLI prompt to appear, then hold for 1 second (0:30)

**Caption** (0:15 - 0:22, bottom center):
```
Spin up a new Claude in seconds -- name it, color it, point it at any project.
```

**Caption** (0:27 - 0:30, bottom center):
```
Each session is a full Claude CLI terminal.
```

**Duration:** 15 seconds

---

### Shot 4: Split View (0:30 - 0:43)

**What's on screen:** The new `dep-upgrade` session is active.

**Action:**
1. Click the "Split" button in the terminal header (top right, the Columns2 icon) (0:30)
2. A session picker appears. Click `dashboard-fix` to open it in the right pane. (0:33)
3. Both terminals are now side-by-side. The left shows `dep-upgrade`, the right shows `dashboard-fix` with its ongoing work. L/R badges appear on the sidebar sessions. (0:35)
4. Click the right pane to focus it -- the accent color on the header switches. (0:37)
5. Drag the divider slightly left to give the right pane more space, then back to center. (0:39)
6. Press `Cmd+Shift+W` to close the split. (0:42)

**Caption** (0:30 - 0:37, bottom center):
```
Work on two problems at once without losing context.
```

**Caption** (0:39 - 0:43, bottom center):
```
Draggable divider. Cmd+\ to toggle, Cmd+Shift+W to close.
```

**Duration:** 13 seconds

---

### Shot 5: Session Tabs -- Terminal, Files (0:43 - 1:05)

**What's on screen:** Single session view, `dashboard-fix` selected.

**Action:**
1. Click on `dashboard-fix` in the sidebar to select it. (0:43)
2. The terminal header shows tabs: Session | Terminal | Files. Click "Files". (0:45)
3. The file explorer appears: tree on the left, preview on the right. The tree shows the project directory. (0:47)
4. Click to expand a `src/` folder in the tree. (0:49)
5. Click on a source file (e.g., `dashboard.ts`). The file preview appears on the right with line numbers. (0:51)
6. Hold on the preview for 2 seconds so the viewer can see it's a real file view. (0:53)
7. Type a few characters in the file name filter input at the top of the tree to filter the tree. (0:55)
8. Clear the filter. Switch to the "Content" search mode (the toggle). Type a search term (e.g., `query`). Results appear grouped by directory. (0:57)
9. Click a result -- the file preview shows with the search term highlighted. (1:00)
10. Hold for a moment to show the highlighted match. (1:02)
11. Click the "Session" tab to go back to the terminal. (1:04)

**Caption** (0:45 - 0:53, bottom center):
```
Browse and read project files without leaving your session.
```

**Caption** (0:55 - 1:05, bottom center):
```
Search by filename or grep through file contents across the whole project.
```

**Duration:** 22 seconds

---

### Shot 6: Command Palette (1:05 - 1:18)

**What's on screen:** `dashboard-fix` terminal view.

**Action:**
1. Press `Cmd+K`. The command palette opens as a centered modal with a search input. (1:05)
2. The palette shows sections: Sessions (listing all 4 running sessions), Actions (New Session, Kill, Toggle Split), Navigation (Agents, PRs, Tasks, etc.). (1:07)
3. Type `onb` in the search. It fuzzy-filters to show `onboarding-review`. (1:10)
4. Press Enter. The palette closes and switches to the `onboarding-review` session. (1:12)
5. Press `Cmd+K` again. Type `auth` -- it shows the `auth-refactor` session AND cross-session terminal search results (matching text from terminal output across all sessions). (1:14)
6. Press Escape to close. (1:17)

**Caption** (1:05 - 1:12, bottom center):
```
Cmd+K -- find any session, action, or terminal output instantly.
```

**Duration:** 13 seconds

---

### Shot 7: GitHub PRs Panel (1:18 - 1:52)

**What's on screen:** Any session view.

**Action:**
1. Click the GitPullRequest icon (the PR icon) in the sidebar navigation bar at the top. (1:18)
2. The PRs panel opens. Shows the panel header with "Pull Requests", Memory/Context/Prompts/Add Repo buttons. Below that, the ask bar with "Ask about these PRs..." placeholder. Below that, the repo list with two repos expanded. (1:20)
3. Pan slowly down the PR list. PRs show: number, title, author, branch, +/- diff stats, time since update, review status badges (green shield for approved, red for changes requested), CI badges (green checkmark or red X), comment count, attention badges. (1:22 - 1:28)
4. Click on PR #139 (the one with failing CI) to expand it. The PR body renders as markdown. Below it: CI/CD Checks section showing individual check results with red X on the failing one. Quick action buttons appear: "Review", "Summarize", "Checkout & Test". (1:30)
5. Hold for 2 seconds on the expanded PR so the viewer can absorb the layout. (1:32)
6. Click the comment count badge on PR #139. The comments viewer modal opens -- split layout with sidebar listing comments grouped by General/file, and the content pane showing the selected comment rendered in markdown. (1:35)
7. Click a file-level comment in the sidebar to show it. The path appears above the comment body. (1:38)
8. Hold for 2 seconds on the file-level comment. (1:40)
9. Press Escape to close the comments viewer. (1:42)
10. Click the "Memory" button in the header. The PR Memory modal opens showing the team conventions and known issues you pre-loaded. (1:44)
11. Hold for 2 seconds on the memory content. (1:46)
12. Close the memory modal. (1:48)

**Caption** (1:18 - 1:26, bottom center):
```
All your PRs in one place -- CI status, review state, comments, who needs what.
```

**Caption** (1:28 - 1:35, bottom center):
```
Expand to see the full description, check failures, and one-click actions.
```

**Caption** (1:35 - 1:42, bottom center):
```
Read every comment -- general and file-level -- without opening GitHub.
```

**Caption** (1:44 - 1:48, bottom center):
```
PR Memory -- persistent knowledge that every review session inherits.
```

**Duration:** 34 seconds (extra breathing room vs. the original 27s)

---

### Shot 8: Task Queue (1:52 - 2:00)

**What's on screen:** PRs panel.

**Action:**
1. Click the ListChecks icon (Tasks) in the sidebar navigation bar. (1:52)
2. The Tasks panel opens. The left side shows a list of task queue files; `code-audit.yaml` is listed. Click it. (1:53)
3. The right side shows the YAML editor with the Config tab active, displaying the 3 tasks defined. The header shows "3 tasks, parallel mode". (1:55)
4. Click the "Outputs" tab -- shows output from a previous run (files with results). Do NOT show an empty Outputs tab. (1:56)
5. Click back to the "Config" tab. Click the green Play button to run the queue. (1:58)
6. A Claude session launches. The sidebar briefly flashes showing the new session. Hold for 1 second as Claude starts processing. (1:59)

**Caption** (1:52 - 2:00, bottom center):
```
Define batch jobs as YAML -- security audits, test coverage, TODO sweeps -- and run them all at once.
```

**Duration:** 8 seconds

---

### Shot 9: Pipelines (2:00 - 2:15)

**What's on screen:** Tasks panel.

**Action:**
1. Click the Zap icon (Pipelines) in the sidebar navigation bar. (2:00)
2. The Pipelines panel opens. The Colony Feedback pipeline is listed with a pulsing amber dot indicating it's running/polling. (2:02)
3. Click to expand the Colony Feedback pipeline. The YAML content shows the trigger (git-poll), condition (branch-file-exists on colony-feedback branch), and action (route-to-session). (2:04)
4. The pipeline info shows: last polled time, fire count, enabled toggle. (2:07)
5. Click the "Docs" tab. The companion readme renders, explaining the Colony Feedback workflow. (2:10)
6. Hold for a moment on the docs content. (2:13)

**Caption** (2:00 - 2:07, bottom center):
```
Pipelines listen for events and route work to the right session automatically.
```

**Caption** (2:08 - 2:15, bottom center):
```
Colony Feedback: a reviewer pushes feedback, the author's session picks it up -- no manual handoff.
```

**Duration:** 15 seconds

---

### Shot 10: Session History and External Detection (2:15 - 2:30)

**What's on screen:** Pipelines panel.

**Action:**
1. Click the TerminalSquare icon (Sessions) in the sidebar navigation bar to go back to Sessions view. (2:15)
2. Scroll down past the active sessions in the sidebar. The History section appears, showing past Claude CLI sessions with search bar, session names, project names, message counts, and timestamps. (2:17)
3. Hover over a history session -- the popover appears showing first message and last message preview. (2:20)
4. If any External Sessions are detected (Claude processes running outside Colony), they appear above History with a distinct dot. Hover or click one to show the preview popover with conversation messages and the "Take Over" button. (2:23)
5. Click a history session to resume it. It opens in Colony with full history. (2:26)

**Caption** (2:15 - 2:22, bottom center):
```
Pick up any past conversation right where you left off.
```

**Caption** (2:23 - 2:30, bottom center):
```
Claude running in another terminal? Colony finds it and lets you take over.
```

**Duration:** 15 seconds

NOTE: If you don't have external sessions running, skip the external detection part (2:23 - 2:26) and shorten this shot by 3-4 seconds. Adjust subsequent timings.

---

### Shot 11: Quick Feature Montage (2:30 - 2:55)

A fast sequence of smaller features. Each gets 3-5 seconds.

**Action sequence:**

1. **Drag & drop** (2:30): Open Finder next to Colony. Drag a folder from Finder onto the sidebar. A new session dialog appears with the directory pre-filled. Cancel the dialog. (3 sec)

2. **Info popover** (2:33): Click the (i) info button on a running session in the sidebar. The popover shows: command, directory, PID, start time, MCP servers, and child processes with CPU/memory stats. Click away to close. (4 sec)

3. **Terminal search** (2:37): Press `Cmd+F` on an active session. The search bar appears at the top of the terminal. Type a term, matches highlight. Press Escape. (3 sec)

4. **Pin/Unpin from sidebar** (2:40): Click the actions icon on a session in the sidebar. The actions menu shows: Open in Split View, Rename, Pin/Unpin, Kill/Remove. Click Pin to demonstrate. Click away. (3 sec)

5. **Status bar** (2:43): Mouse slowly across the bottom status bar. Hover over the resource usage numbers (CPU/memory for Colony total and active session). (3 sec)

6. **Settings** (2:46): Click the gear icon in the sidebar footer. Settings panel shows: default CLI args, shell profile, global hotkey, sound notifications, auto-cleanup timeout, daemon section with version and restart button, logs viewer. (5 sec)

7. **Keyboard shortcut** (2:51): Press `Cmd+2` to jump to the second session. Then `Cmd+3` to jump to the third. Fast and snappy. (3 sec)

**Caption** (2:30 - 2:35, bottom center):
```
Drag folders to create sessions. Inspect any process in one click.
```

**Caption** (2:37 - 2:43, bottom center):
```
Cmd+F to search terminal output. Pin sessions to keep them at the top.
```

**Caption** (2:46 - 2:51, bottom center):
```
Settings: CLI defaults, shell, hotkey, daemon management, logs.
```

**Caption** (2:52 - 2:55, bottom center):
```
Cmd+1 through Cmd+9 -- jump between sessions instantly.
```

**Duration:** 25 seconds

---

### Shot 12: Closing (2:55 - 3:25)

**What's on screen:** Sessions view with all sessions visible.

**Action:** Hold on the full app view with all sessions listed. Let the viewer see the complete picture one more time.

**Caption** (2:55 - 3:25, center of screen, larger text):
```
Claude Colony
Parallel AI development sessions. One window.

github.com/fabioelia/cli-colony
```

**Duration:** 30 seconds

---

## Editing Notes

- **Pace:** This video moves fast. Each shot transition should be a hard cut with no fade. The viewer should feel momentum.
- **The opening contrast is critical.** Shot 1 (messy terminals) to Shot 2 (clean Colony) should feel like relief. Make the "before" genuinely cluttered.
- **Captions:** Use a clean sans-serif font (SF Pro, Inter, or similar). White text with a subtle dark shadow or semi-transparent dark background strip. Position consistently -- bottom center for descriptive captions, near the relevant UI element for callout captions.
- **Caption voice:** Every caption should answer "why should I care?" not "what is this feature called?" Lead with the benefit, not the label. If a caption reads like a tooltip, rewrite it.
- **Mouse movement:** Move the mouse deliberately. Avoid nervous jittering. When hovering to show a tooltip or popover, hold for at least 1 full second before moving on.
- **No empty states:** Every panel and tab shown should have real data. If the Outputs tab would be empty, run the task queue once before recording. If Memory would be empty, populate it. Empty states in a demo communicate "this feature isn't useful yet."
- **Recording tip:** Record each shot as a separate QuickTime recording. This makes retakes easy. Stitch in your video editor.
- **If a shot runs long:** Cut the montage (Shot 11) items. The first 10 shots cover the core features; the montage is bonus polish.
