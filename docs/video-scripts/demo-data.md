# Demo Data Definition

Consistent sample data used across all video recordings. Set this up before recording any video.

## GitHub Repositories

Configure these in the PRs tab:

| Repo | Owner/Name | Purpose |
|------|-----------|---------|
| Main app | `acme/web-platform` | Primary product repo. Has 4-6 open PRs. |
| Shared lib | `acme/shared-utils` | Smaller repo. Has 1-2 open PRs. |

If you don't have repos with open PRs available, use any two real repos you own or contribute to that have active PRs. The scripts reference `acme/web-platform` and `acme/shared-utils` as placeholders -- substitute your actual repo names.

### Required PR State (for acme/web-platform)

You need at least these PRs open (or equivalents with similar characteristics):

| # | Title | Author | Branch | Status | CI | Comments |
|---|-------|--------|--------|--------|-----|----------|
| 142 | feat: add user onboarding flow | teammate-a | `feat/onboarding` | Open | Passing | 3 comments |
| 139 | fix: dashboard query performance | you | `fix/dashboard-perf` | Open, Changes Requested | Failing (1 check) | 5 comments (including file-level) |
| 137 | refactor: extract auth middleware | teammate-b | `refactor/auth-middleware` | Open, Review Required | Passing | 1 comment |
| 135 | chore: upgrade dependencies | dependabot | `deps/upgrade-march` | Draft | Passing | 0 comments |

Key requirements:
- At least one PR with failing CI (for the "Fix CI" button demo)
- At least one PR with multiple comments including file-level comments (for the comments viewer)
- At least one PR with "Changes Requested" review status
- At least one PR assigned to or requesting review from you (for attention badges)

## Active Sessions

Before recording, have these sessions running:

| Name | Color | Working Directory | State |
|------|-------|------------------|-------|
| `onboarding-review` | Blue (#3b82f6) | `/path/to/web-platform` | Running, idle (waiting) |
| `dashboard-fix` | Amber (#f59e0b) | `/path/to/web-platform` | Running, busy (pulsing) |
| `auth-refactor` | Green (#10b981) | `/path/to/web-platform` | Running, idle |

The `dashboard-fix` session should be on the `fix/dashboard-perf` branch and have some conversation history (at least a few exchanges visible in the terminal).

## Pinned Session

Pin the `onboarding-review` session so it appears at the top of the sidebar with the pin icon.

## Task Queue

Create a file at `~/.claude-colony/task-queues/code-audit.yaml`:

```yaml
name: Code Audit
mode: parallel
tasks:
  - prompt: "Analyze the codebase for security vulnerabilities. Focus on input validation, SQL injection, XSS, and auth bypass. Write findings to the output directory."
    directory: /path/to/web-platform
    name: Security Scan
  - prompt: "Find all TODO and FIXME comments. Categorize by severity and suggest priorities. Write a summary to the output directory."
    directory: /path/to/web-platform
    name: TODO Audit
  - prompt: "Analyze test coverage gaps. Identify critical paths without tests and suggest test cases. Write recommendations to the output directory."
    directory: /path/to/web-platform
    name: Test Coverage
```

## Pipeline

Create a file at `~/.claude-colony/pipelines/colony-feedback.yaml` (this is auto-seeded if you enable it, but verify it exists):

```yaml
name: Colony Feedback
description: Routes reviewer feedback from colony-feedback branch to the active session
enabled: true

trigger:
  type: git-poll
  interval: 300
  repos: auto

condition:
  type: branch-file-exists
  branch: colony-feedback
  path: "reviews/{{pr.number}}/feedback.md"

action:
  type: route-to-session
  reuse: true
  match:
    gitBranch: "{{pr.branch}}"
  prompt: |
    A reviewer has left structured feedback for PR #{{pr.number}}.
    Read the feedback: git show colony-feedback:reviews/{{pr.number}}/feedback.md
    Address each point, then push your fixes.
```

Also ensure the Colony Feedback pipeline shows as enabled and running (pulsing amber dot) in the Pipelines tab.

## Environment Template (optional, for overview video only)

If you have an environment template configured, great. If not, this is shown briefly and can be skipped. The overview video just needs to show the Environments panel exists.

## Session History

Ensure you have at least 10-15 entries in your Claude CLI history (`~/.claude/history.jsonl`) so the History section in the sidebar has content. These accumulate naturally from using the CLI.

## PR Memory

Add some content to `~/.claude-colony/pr-workspace/pr-memory.md`:

```markdown
## Team Conventions
- All API endpoints must have integration tests before merge
- Use kebab-case for URL paths, camelCase for JSON fields
- Security-sensitive PRs require review from @security-team

## Known Issues
- Dashboard query on large datasets is slow -- needs index on created_at
- Auth middleware has a race condition with token refresh (tracked in #128)

## Reviewer Preferences
- teammate-a prefers detailed commit messages with "why" context
- teammate-b wants test output included in PR descriptions
```

## Default Global Prompts

Ensure these global prompt chips are configured in the PRs panel ask bar before recording. They appear as clickable chips below the input and are used in both videos.

| Label | Scope | Prompt Text |
|-------|-------|-------------|
| My PRs | Global | `Show me all PRs where I am the author. Include status, CI, and review state.` |
| Needs Review | Global | `Which PRs need my review? List them with their current status and how long they've been waiting.` |
| Stale PRs | Global | `Find PRs that haven't been updated in more than 7 days. Summarize their status and suggest next steps.` |

These are referenced in Video 2 Shot 6. If no global prompts are configured, those chips will be missing from the ask bar and the shot won't match the script.

## Pre-Recording Checklist

1. [ ] Two repos configured in PRs tab with PRs fetched
2. [ ] At least 3 sessions running with distinct colors
3. [ ] One session pinned
4. [ ] One session visibly busy (pulsing dot)
5. [ ] CI checks loaded for all PRs (green/red badges visible)
6. [ ] `code-audit.yaml` task queue file exists
7. [ ] Colony Feedback pipeline enabled and running
8. [ ] PR Memory file has content
9. [ ] Session history has 10+ entries
10. [ ] Default global prompts configured (My PRs, Needs Review, Stale PRs)
11. [ ] Task queue has at least one previous run with output files (no empty Outputs tab)
12. [ ] Window sized to 1440x900 or 1920x1080 (pick one, stay consistent)
13. [ ] Font size set to 13px (default)
14. [ ] Dark theme active (default)
15. [ ] No notifications or other apps visible
16. [ ] QuickTime screen recording ready

**Empty state rule:** Every panel and tab shown in either video should have real content already loaded. Never show an empty state during a demo -- it kills momentum and communicates "this feature has no value yet." Run the task queue at least once beforehand so Outputs has content. Populate PR Memory. Have sessions with history. If a tab would be empty, either pre-fill it or skip it in the script.
