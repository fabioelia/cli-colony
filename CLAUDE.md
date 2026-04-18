# Claude Colony — Development Guidelines

## Project Overview

Electron desktop app for managing multiple Claude CLI sessions, with GitHub PR integration, task queues, pipelines, environments, and agent management.

**Stack:** Electron (electron-vite), React 19, xterm.js, node-pty, TypeScript throughout.

## Build & Run

```bash
npm run dev          # Development with hot reload
npm run build        # Production build to out/
npm run typecheck    # Type-check without emitting (or: npx tsc -b --noEmit)
```

Always run `npm run typecheck` after changes and `npm run build` before testing.

## Architecture

- `src/daemon/` — Standalone PTY daemon (survives app restarts). Has its own protocol version (`DAEMON_VERSION` in `protocol.ts`).
- `src/main/` — Electron main process. IPC handlers in `src/main/ipc/`.
- `src/preload/` — Typed IPC bridge. Every new IPC channel needs a type in the `ElectronAPI` interface AND the implementation.
- `src/renderer/` — React UI. Components in `src/renderer/src/components/`.
- `src/shared/` — Types and utilities shared between main/renderer/daemon.

## Commit Convention

All commits MUST use [Conventional Commits](https://www.conventionalcommits.org/) format. The CI pipeline reads commit types to decide when to cut a release.

**Format:** `type: short description`

| Type | When to use | Triggers release? |
|------|-------------|-------------------|
| `feat:` | New user-facing feature or capability | **Yes** — bumps minor (1.2.0 → 1.3.0) |
| `fix:` | Bug fix | **Yes** — bumps patch (1.2.0 → 1.2.1) |
| `ux:` | Visual/UX polish (CSS, layout, copy) | **Yes** — bumps patch |
| `perf:` | Performance improvement | **Yes** — bumps patch |
| `refactor:` | Code restructuring, no behavior change | No |
| `test:` | Adding or updating tests | No |
| `chore:` | Build, deps, tooling, CI | No |
| `docs:` | Documentation only | No |

**Rules:**
- Keep the first line under 72 characters
- Use imperative mood ("add", "fix", "remove" — not "added", "fixes")
- Body is optional; use it for context on *why*, not *what*
- Breaking changes: add `!` after type (e.g., `feat!: redesign pipeline schema`) — bumps major
- Scope is optional: `feat(pipelines): add cron preview`

**Examples:**
```
feat: add fullscreen-aware titlebar padding
fix: tab clicks swallowed by drag region in fullscreen
ux: template card shows last-modified badge
refactor: convert sync FS calls to async in main process
test: add usePanelTabKeys cycle tests for Cmd+[ / Cmd+]
chore: add GitHub Actions release workflow
```

## Critical Rules

### Help Content Must Stay in Sync

**Every new UI feature, button, or action MUST be documented in the help system.**

The help content lives in `src/renderer/src/lib/help-content.ts`. It is organized by panel topic with zones that map to visual regions of each panel.

When adding or changing UI features:
1. Update the relevant topic in `help-content.ts` — add/edit items in the correct zone
2. If the feature uses an icon button, include the `icon` field with the Lucide icon name (e.g., `icon: 'Play'`)
3. If adding a new icon not in the icon map, also add it to the `iconMap` in `src/renderer/src/components/HelpPopover.tsx`
4. If adding an entirely new panel or tab, create a new topic entry and wire up `<HelpPopover topic="newTopic" />` in the component

The help popover is the primary onboarding tool for new users. Stale or missing help content directly degrades the user experience.

### Panel Header Convention

All main panels use the shared `.panel-header` CSS class with this structure:
```tsx
<div className="panel-header">
  {/* Optional back button */}
  <button className="panel-header-back">...</button>
  {/* Title with optional icon */}
  <h2><IconComponent size={16} /> Title</h2>
  {/* Optional tabs */}
  <div className="panel-header-tabs">...</div>
  {/* Spacer pushes actions right */}
  <div className="panel-header-spacer" />
  {/* Help icon */}
  <HelpPopover topic="..." align="right" />
  {/* Action buttons */}
  <div className="panel-header-actions">
    <button className="panel-header-btn">...</button>
  </div>
</div>
```

Do not create new panel-specific header CSS classes. Use `panel-header-btn` for action buttons and `panel-header-btn primary` for primary actions.

### Daemon Versioning

**Any change to files in `src/daemon/` MUST include a `DAEMON_VERSION` bump.** The daemon is a separate long-lived process — code changes only take effect after a restart. Without a version bump, users run stale daemon code with no indication anything is wrong.

When changing daemon protocol, behavior, or any file in `src/daemon/`:
1. Bump `DAEMON_VERSION` in `src/daemon/protocol.ts` (increment by 1)
2. The app will automatically show an amber banner prompting the user to restart the daemon
3. This also applies to changes in `src/main/` that affect daemon communication (e.g., new request types, changed event handling)

### Static Imports Only

All local module imports in `src/main/` MUST be static `import` statements, never dynamic `require()`. The bundler (electron-vite/Rollup) only includes statically imported code in the build output. Dynamic `require('./module')` calls are preserved as-is but the target file won't exist in `out/`, causing silent runtime failures.

### Session Restore

Session restore uses a snapshot-based approach:
- `snapshotRunning()` saves running sessions on app quit to `restore-snapshot.json`
- Only sessions from the snapshot are offered for restore (not previously-stopped sessions)
- The snapshot is deleted after restore/dismiss

### Bare Repo Config

Repos tracked in GitHub settings use bare git clones. When reading `.colony/` config from bare repos, use `resolveBareRef()` which reads `origin/HEAD` instead of the potentially-stale local `HEAD`.

## File Locations

- Help content: `src/renderer/src/lib/help-content.ts`
- Help component: `src/renderer/src/components/HelpPopover.tsx`
- Panel header CSS: search for `.panel-header` in `src/renderer/src/styles/global.css`
- Daemon protocol: `src/daemon/protocol.ts`
- IPC type definitions: `src/preload/index.ts` (ElectronAPI interface)
- App data: `~/.claude-colony/`

## README

Keep `README.md` updated when adding features. It serves as the canonical feature list.
