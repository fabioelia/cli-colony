# Video 2: The PR Review Workflow

**Total runtime:** 3:30 - 4:15
**Format:** Screen recording with text captions. No voiceover.
**Resolution:** Same as Video 1 (1440x900 or 1920x1080)

## What This Video Shows

The end-to-end PR review and feedback loop in Claude Colony:

1. Viewing PRs across repos with status, CI, and comments
2. Launching a review session from a PR
3. The Colony Feedback pipeline detecting and routing feedback
4. Multi-session orchestration: reviewer session + author session + PR assistant
5. Using the ask bar, PR memory, and comments viewer

This is the most differentiated feature of the app and the best demo of how Colony orchestrates multiple AI sessions working together on a real workflow.

## Setup Before Recording

1. Complete all items in the Pre-Recording Checklist in `demo-data.md`
2. Start with the app open in **Sessions view** with 2-3 sessions running
3. Have both repos configured in the PRs tab with PRs already fetched
4. Colony Feedback pipeline must be **enabled** in the Pipelines tab (pulsing amber dot)
5. PR #139 (`fix/dashboard-perf`) should have failing CI and "Changes Requested" status
6. PR Memory should have content pre-loaded
7. Kill the `dep-upgrade` session from Video 1 if still running (keep 3 sessions max for cleaner sidebar)
8. Default global prompts configured (My PRs, Needs Review, Stale PRs)

---

## Shot List

### Shot 1: Opening the PRs Panel (0:00 - 0:20)

**What's on screen:** App in Sessions view with 3 running sessions in the sidebar.

**Action:**
1. Hold on the Sessions view for 2 seconds to establish context. (0:00)
2. Click the GitPullRequest icon in the sidebar navigation bar (third icon). (0:02)
3. The PRs panel loads. The header shows: "Pull Requests" title, Memory button, Context button, Prompts button, Add Repo button. (0:04)
4. Below the header: the ask bar with "Ask about these PRs..." placeholder and global prompt chips (My PRs, Needs Review, Stale PRs). (0:06)
5. Below the ask bar: search/filter bar. Below that: two repos listed, first one expanded showing its PRs. (0:08)
6. Pan slowly down the PR list. Each PR row shows: number, title (with draft badge if applicable), author, assignees, reviewers, branch, +/-diff, time ago, review status shield, CI badge, comment count, attention badges. (0:10 - 0:16)
7. Point out the attention badges -- "Review requested" on a PR assigned to you, and the CI failure badge (red "CI" with X icon) on PR #139. (0:18)

**Caption** (0:00 - 0:06, top center):
```
The PR Review Workflow -- orchestrate code reviews with Claude Colony.
```

**Caption** (0:08 - 0:14, bottom center):
```
Every open PR across all your repos. Status, CI, comments -- no tab-switching.
```

**Caption** (0:15 - 0:20, bottom center):
```
Red CI badge = failing checks. "Review requested" = your action needed.
```

**Duration:** 20 seconds

---

### Shot 2: Exploring a PR (0:20 - 0:55)

**What's on screen:** PRs panel with repos listed.

**Action:**
1. Click on PR #139 (`fix: dashboard query performance`) to expand it. (0:20)
2. The expanded view shows:
   - PR description rendered as markdown (0:22)
   - Labels section if labels exist (0:24)
   - "View 5 comments" button (0:24)
   - CI/CD Checks section with individual check rows -- green checks and one red failing check with its name. Each check has a status icon, name, and conclusion. (0:26)
   - The failing check has a "View failure details" button (FileText icon). Click it. (0:28)
3. A modal appears showing the CI failure log output. Hold for 2 seconds to let the viewer read a few lines. (0:30)
4. Close the log modal. (0:32)
5. Note the "Fix Failing Checks" button (wrench icon) below the checks section. Don't click it yet -- just hover to show the tooltip. (0:34)
6. Click the "View 5 comments" button. (0:36)
7. The comments viewer modal opens. Split layout: left sidebar shows comments grouped by "General" and by file path. Right pane shows the selected comment rendered in markdown. (0:38)
8. Click a General comment in the sidebar. The content updates on the right. Show the author name and timestamp. (0:42)
9. Click a file-level comment. The file path appears above the comment body. (0:46)
10. Close the comments viewer (Escape or X button). (0:50)
11. Scroll down to the quick action buttons row: "Review", "Summarize", "Checkout & Test" (and "Colony Feedback Review" if the pipeline is enabled). (0:52)

**Caption** (0:20 - 0:28, bottom center):
```
Expand any PR to see its full description, labels, and CI check details.
```

**Caption** (0:28 - 0:34, bottom center):
```
View failure logs inline. One-click "Fix Failing Checks" launches a Claude session.
```

**Caption** (0:36 - 0:45, bottom center):
```
Read every comment -- general and file-level -- without leaving the app.
```

**Caption** (0:50 - 0:55, bottom center):
```
Quick actions: Review, Summarize, Checkout & Test -- each launches a targeted session.
```

**Duration:** 35 seconds

---

### Shot 3: Launching a Review Session (0:55 - 1:40)

**What's on screen:** PR #139 expanded, quick action buttons visible.

**Action:**
1. The quick action row shows buttons. If Colony Feedback pipeline is enabled, the Review button says "Colony Feedback Review". Click it. (0:55)
2. A new session appears in the sidebar (named "Colony Feedback Review: web-platform#139") with a fresh color. The main view stays on the PRs panel -- but you can see the new session dot appear in the sidebar and start pulsing. (0:58)
3. Click the new session in the sidebar to switch to it. (1:00)
4. The terminal shows Claude starting up. The initial prompt is visible -- it includes the PR context, comment references, review instructions, and Colony Feedback branch push instructions. (1:02)
5. **Let Claude run for at least 15 seconds with visible terminal output.** The viewer needs to see Claude actually working -- reading the PR, checking out the branch, examining files, producing review commentary. Do not cut away too early. This is the payoff for the setup. (1:05 - 1:20)
6. While Claude is producing output, the session's git repo and branch badges appear in the terminal header (e.g., `web-platform` repo badge, `fix/dashboard-perf` branch badge). (1:22)
7. Click the "Files" tab briefly to show the file explorer scoped to the working directory, then click back to "Session" to return to the live output. (1:25)
8. In the sidebar, the session shows a pulsing dot (busy). Other sessions still show their state. (1:30)

**Caption** (0:55 - 1:02, bottom center):
```
One click launches a review session pre-loaded with the full PR context.
```

**Caption** (1:05 - 1:15, bottom center):
```
Claude reviews the code, reads every comment, and prepares structured feedback.
```

**Caption** (1:18 - 1:25, bottom center):
```
Git repo and branch detected automatically. Shown in the session header.
```

**Caption** (1:28 - 1:35, bottom center):
```
All sessions visible in sidebar. Pulsing = working. Solid = waiting.
```

**Duration:** 45 seconds

**RECORDING NOTE:** This is the shot where the viewer first sees Claude actually doing work. Do not rush it. Let the terminal output scroll for a full 15 seconds so the viewer can read along and get a sense of the review quality. If Claude finishes too quickly, use a longer PR or add a follow-up instruction.

---

### Shot 4: The Colony Feedback Loop (1:40 - 2:20)

This is the key differentiator shot. Show how the feedback pipeline creates a closed loop.

**What's on screen:** The review session running in the terminal.

**Action:**
1. While the review session works, switch briefly to the Pipelines tab (Zap icon) in the sidebar nav. (1:40)
2. Show the Colony Feedback pipeline with its pulsing amber dot (running). The last-polled time updates. (1:42)
3. Expand the pipeline to show the YAML: trigger (git-poll), condition (branch-file-exists on `colony-feedback` branch, path `reviews/{{pr.number}}/feedback.md`), action (route-to-session with `reuse: true`). (1:45)
4. Switch back to the review session (click it in sidebar). (1:50)
5. If the reviewer session has finished pushing feedback to the colony-feedback branch (or splice in the pre-recorded moment -- see recording strategy below):

   **Caption** (1:52 - 2:00, bottom center):
   ```
   The reviewer pushes structured feedback. Colony picks it up automatically.
   ```

6. Now show the author's session (`dashboard-fix`, the amber one). Click it in the sidebar. (2:00)

7. **The key moment:** The `dashboard-fix` session has received a new prompt injected by the pipeline, telling it to read the feedback and address it.

   **Caption** (2:02 - 2:12, bottom center):
   ```
   The author's session gets the feedback without a context switch --
   it already has the full history of their work.
   ```

8. The author's session now has both its original work context AND the reviewer feedback. It begins addressing the feedback points. (2:12)

9. Show both sessions in split view: Click Split in the terminal header, pick the review session for the right pane. Left = author's session (addressing feedback), Right = reviewer's session (completed review). (2:15)

**Caption** (2:15 - 2:20, bottom center):
```
Author addressing feedback (left) alongside the original review (right).
```

**Duration:** 40 seconds

**RECORDING STRATEGY FOR THE PIPELINE FIRING:**

The Colony Feedback pipeline polls on a configurable interval (default 300 seconds). You will almost certainly need to splice this moment in. Recommended approach:

1. Set the pipeline `interval: 10` temporarily
2. Record the full sequence: reviewer pushes feedback, pipeline detects it, author session receives the prompt
3. Record it as a standalone clip -- get the moment of the pipeline firing and the author session lighting up
4. In the editor, splice this clip into the main take between the reviewer finishing and the split view
5. Reset the interval to the production value after recording

Do NOT try to capture this in a single continuous take. The timing is unpredictable and you will waste recording time. Pre-record the pipeline firing and splice it in.

---

### Shot 5: The Ask Bar (2:20 - 2:55)

**What's on screen:** Close the split view. Switch back to the PRs panel.

**Action:**
1. Close the split view (`Cmd+Shift+W`). (2:20)
2. Click the GitPullRequest icon to return to the PRs panel. (2:22)
3. The ask bar is at the top, below the header. Click into it. (2:24)
4. Notice the global prompt chips below the input: "My PRs", "Needs Review", "Stale PRs". Click "Needs Review". The input fills with the prompt text. (2:26)
5. Instead, clear the input and type a custom question: `Which PRs have failing CI and what are the failure reasons?` (2:30)
6. Press Enter (or click the Send button). (2:34)
7. A new session named "PR Assistant" appears in the sidebar and starts working. The PRs panel stays visible. (2:36)
8. Click the PR Assistant session in the sidebar to watch it work. Claude reads the PR context file, analyzes the PRs, and begins answering. (2:38)
9. Let it work for ~5 seconds with visible output. (2:40)
10. Go back to the PRs panel (click PR icon in sidebar nav). Type another question in the ask bar: `Summarize the review status of all open PRs` (2:45)
11. Press Enter. The same PR Assistant session receives the follow-up (it reuses the existing session). Switch to it briefly to show the continuation. (2:48)

**Caption** (2:22 - 2:28, bottom center):
```
Ask anything about your PRs in plain English.
```

**Caption** (2:30 - 2:36, bottom center):
```
Pre-built prompts for common questions, or type your own.
```

**Caption** (2:40 - 2:48, bottom center):
```
The PR Assistant remembers context. Follow-up questions build on previous answers.
```

**Caption** (2:49 - 2:55, bottom center):
```
It reads an auto-generated context file with every PR's full details.
```

**Duration:** 35 seconds

---

### Shot 6: PR Memory and Context (2:55 - 3:20)

**What's on screen:** PRs panel.

**Action:**
1. Click the "Memory" button in the panel header (Brain icon). (2:55)
2. The PR Memory modal opens. Shows the pre-loaded content: team conventions, known issues, reviewer preferences. (2:57)
3. Hold for 3 seconds to let the viewer read the content. (3:00)
4. Click the Edit button (pencil icon). The memory becomes an editable textarea. (3:03)
5. Add a new line: `- PR #139 dashboard fix: root cause is missing index on orders.created_at` (3:06)
6. Click "Save". (3:09)
7. Close the memory modal. (3:10)
8. Click the "Context" button in the panel header (FileText icon). (3:12)
9. The PR Context File modal opens, showing the auto-generated markdown with all PR data: numbers, titles, descriptions, branches, authors, reviewers, labels, diff stats. This is what every CLI session reads. (3:14)
10. Scroll down a bit to show the depth of the context. Close the modal. (3:18)

**Caption** (2:55 - 3:02, bottom center):
```
PR Memory -- teach Colony your team's conventions once. Every session inherits them.
```

**Caption** (3:03 - 3:10, bottom center):
```
Editable. Sessions read it for context and write back what they learn.
```

**Caption** (3:12 - 3:20, bottom center):
```
Context file -- auto-generated with every PR's details. Referenced by every session.
```

**Duration:** 25 seconds

---

### Shot 7: Customizing Prompts (3:20 - 3:40)

**What's on screen:** PRs panel.

**Action:**
1. Click the "Prompts" button in the panel header (Pencil icon). (3:20)
2. The prompt editor overlay opens. Shows the existing prompts: "Review" (or "Colony Feedback Review"), "Summarize", "Checkout & Test". Each has a label input, a PR/Global scope toggle, and a prompt template textarea with `{{pr.number}}`, `{{pr.branch}}`, etc. variables. (3:22)
3. Show the scope toggle: click "Global" on one prompt to show how it moves between per-PR buttons and ask bar chips. Click "PR" to switch it back. (3:26)
4. Click "+ Add" to add a new prompt. (3:28)
5. Type label: `Check Tests`. Type prompt: `Check out {{pr.branch}} and run the test suite. Report any failures and suggest fixes.` (3:30)
6. Click "Save". (3:34)
7. Close the overlay. Back on the PR list, expand a PR -- the new "Check Tests" button appears in the quick actions row alongside the others. (3:36)

**Caption** (3:20 - 3:28, bottom center):
```
Create your own review actions with template variables. Per-PR or Global scope.
```

**Caption** (3:30 - 3:40, bottom center):
```
Your custom actions show up as buttons on every PR -- one click to launch.
```

**Duration:** 20 seconds

---

### Shot 8: Multi-Session Overview (3:40 - 4:00)

**What's on screen:** PRs panel.

**Action:**
1. Click the Sessions icon in the sidebar nav to go back to Sessions view. (3:40)
2. The sidebar now shows multiple sessions from this workflow:
   - `onboarding-review` (pinned, idle)
   - `dashboard-fix` (busy, addressing feedback)
   - `auth-refactor` (idle)
   - `Colony Feedback Review: web-platform#139` (completed or working)
   - `PR Assistant` (completed or idle)
3. Mouse over each session slowly. Show the different states: pulsing dots, solid dots, "your turn" badges, "new" unread badges. (3:45)
4. Press `Cmd+K` to open the command palette. Type `pr` -- it shows both the PR Assistant session and the Review session. Shows the cross-session search working. (3:50)
5. Press Escape. (3:53)
6. Hold on the final view: multiple sessions, each with its purpose, all orchestrated from one window. (3:56)

**Caption** (3:40 - 3:48, bottom center):
```
Every session has a purpose. Colony keeps them all in view.
```

**Caption** (3:50 - 3:56, bottom center):
```
Cmd+K searches across all sessions. Switch context in a keystroke.
```

**Caption** (3:57 - 4:00, center, larger text):
```
Reviewer feedback -> Pipeline detection -> Author notification -> Fix pushed.
Closed-loop code review, fully automated.
```

**Duration:** 20 seconds

---

### Shot 9: Closing (4:00 - 4:15)

**What's on screen:** Sessions view with all sessions visible.

**Action:** Hold on the full app view. Let the viewer see all the sessions that were created during this workflow.

**Caption** (4:00 - 4:10, center of screen, larger text):
```
Claude Colony
AI-native PR reviews with automated feedback loops.

github.com/fabioelia/cli-colony
```

**Duration:** 15 seconds

---

## Editing Notes

- **Pace:** Slower than Video 1. This is a deep dive -- let each feature breathe. Transitions can be simple cuts.
- **The feedback loop (Shot 4) is the hero moment.** Pre-record the pipeline firing separately and splice it in (see the recording strategy note in Shot 4). Do not try to capture it live -- the timing is unreliable and you will waste takes. This shot needs to feel seamless and inevitable -- "Colony just routes the feedback to the right session automatically."
- **Show Claude working (Shot 3).** The 15-second window of Claude producing review output is essential. The viewer needs to see that this is real -- Claude is reading code, understanding context, and writing substantive commentary. If you cut away too early, it looks like a loading screen.
- **Captions:** Same style as Video 1 (clean sans-serif, white with dark background strip). In this video, some captions can be longer since the pace is slower.
- **No empty states:** Every panel, tab, and modal shown should have real content. PR Memory should be populated. Prompts should exist. The PR list should have PRs with comments, CI results, and review status already loaded. If something would be empty, populate it before recording.
- **Recording strategy:**
  - Record Shots 1-3 in one take (the natural flow from opening PRs to launching a review -- let Claude run long enough in Shot 3)
  - Record Shot 4 separately (the feedback loop requires pipeline timing -- see splice strategy)
  - Record Shots 5-8 in one take (ask bar, memory, prompts, overview)
  - Record Shot 9 as a final hold shot
  - Splice together in the editor
- **If the video runs long:** Cut Shot 7 (Customizing Prompts). The core story is: see PRs, launch review, feedback loop, ask questions, memory. The prompt editor is nice-to-have.

## Fallback: If Colony Feedback Pipeline Doesn't Fire During Recording

If you can't get the pipeline to fire during recording (timing issues), you can still tell the story:

1. Show the pipeline config (the YAML with its trigger/condition/action)
2. Show a caption explaining what happens when feedback is pushed
3. Manually send a prompt to the `dashboard-fix` session simulating what the pipeline would send: `A reviewer has left structured feedback for PR #139. Read the feedback: git show colony-feedback:reviews/139/feedback.md. Address each point, then push your fixes.`
4. The visual result is the same -- Claude starts addressing feedback in the existing session

This is slightly less magical but still demonstrates the concept effectively.
