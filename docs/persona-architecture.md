# Architecture Plan: Persona System

## Current State

The system this builds on is well-structured. The pipeline engine (`src/main/pipeline-engine.ts`) already solves cron scheduling, session launching, prompt injection via files, "send prompt when ready" logic, memory files, and colony-context awareness. The instance manager provides a clean session lifecycle API through the daemon. The IPC layer follows a consistent pattern: handler modules in `src/main/ipc/`, typed API surface in `src/preload/index.ts`, React panels in `src/renderer/src/components/`.

### What Works (Reuse Directly)

- **Session creation** via `createInstance()` in `instance-manager.ts` -- exact same mechanism for launching persona sessions
- **Prompt injection** via `--append-system-prompt-file` arg and `writePromptFile()` pattern from pipeline-engine
- **"Send prompt when ready"** logic (trust dialog dismissal, activity listener) -- both main-process and renderer versions exist
- **Colony context** via `colony-context.ts` -- personas read the same `colony-context.md` for world awareness
- **Cron evaluation** via `cronMatches()` in pipeline-engine (5-field cron parser already works)
- **Broadcast/IPC patterns** -- `broadcast()` for main-to-renderer push, `ipcMain.handle()` for request/response
- **Panel UI patterns** -- `.panel-header`, `.panel-ask-bar`, card-based lists, expand/collapse

### What Doesn't Exist Yet

- No persona file format, parser, or validator
- No persona manager (file CRUD, watcher, state tracking)
- No planning loop prompt
- No self-modification mechanism (persona writing back to its own `.md` file)
- No persona-specific UI panel or sidebar entry
- No IPC channels for persona operations

## Target State

### Overview

A persona is a long-lived AI agent identity defined by a single `.md` file. The persona manager in the main process reads persona files from `~/.claude-colony/personas/`, tracks their state, and launches sessions with a planning-loop system prompt injected. The persona's session reads and writes its own `.md` file each run, maintaining continuity across sessions. The UI provides a dedicated panel accessible from the sidebar nav.

### Components

| Component | Responsibility | Notes |
|-----------|---------------|-------|
| `src/main/persona-manager.ts` | Load, validate, watch, and manage persona `.md` files. Launch persona sessions. Track run state. | Single module, no sub-files. ~400 lines. |
| `src/main/ipc/persona-handlers.ts` | Register IPC handlers for persona CRUD and actions. | Follows existing handler module pattern exactly. |
| `src/renderer/src/components/PersonasPanel.tsx` | List personas, show detail/editor, run button, activity feed. | Same structural pattern as `PipelinesPanel.tsx`. |
| `src/shared/types.ts` | Add `PersonaDef` and `PersonaInfo` types. | Shared between main and renderer. |
| `src/shared/colony-paths.ts` | Add `personas` directory path. | One line. |
| `src/preload/index.ts` | Add `persona` namespace to `ClaudeManagerAPI`. | IPC bridge. |

### Data Model

**Persona file** (`~/.claude-colony/personas/<name>.md`):

```markdown
---
name: Engineering Manager
schedule: "0 */2 9-17 * * 1-5"
model: opus
max_sessions: 2
can_push: false
can_merge: false
can_create_sessions: true
working_directory: ~/projects/myapp
color: "#f59e0b"
---

## Role
You are an Engineering Manager for the Colony workspace. You oversee code quality,
review PR status, and coordinate work across sessions.

## Objectives
- Monitor open PRs and flag ones that need attention
- Review session activity and suggest task prioritization
- Maintain a running summary of project health

## Active Situations
_Updated by persona each session. Tracks in-flight work, blockers, and pending items._

## Learnings
_Appended by persona. Pruned when stale. Patterns, preferences, and context that persist._

## Session Log
_Auto-managed. Last 20 entries. Format: `- [ISO timestamp] summary of what happened`_
```

**Frontmatter schema:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | -- | Display name. Must be unique across persona files. |
| `schedule` | string | no | `null` | Cron expression (6-field with seconds, or 5-field). `null` = manual only. |
| `model` | string | no | `"sonnet"` | Model hint passed via `--model` flag if supported, otherwise informational. |
| `max_sessions` | number | no | `1` | Max concurrent sessions this persona can have running. |
| `can_push` | boolean | no | `false` | Whether sessions can push to git remotes. |
| `can_merge` | boolean | no | `false` | Whether sessions can merge PRs. |
| `can_create_sessions` | boolean | no | `false` | Whether the persona can spawn child sessions. |
| `working_directory` | string | no | `"~/.claude-colony"` | Default cwd for persona sessions. |
| `color` | string | no | `"#a78bfa"` | Session color in the sidebar. |

**Section conventions:**

| Section | Author | Behavior |
|---------|--------|----------|
| `## Role` | User | Static. Never modified by the persona. Defines identity. |
| `## Objectives` | User | Static. Never modified by the persona. Defines goals. |
| `## Active Situations` | Persona | Updated every session. The persona replaces this section entirely with current state. |
| `## Learnings` | Persona | Append-only (with occasional pruning). Accumulated knowledge. |
| `## Session Log` | Persona | Append one entry per session. Auto-pruned to last 20 entries by the planning loop. |

**State file** (`~/.claude-colony/persona-state.json`):

```json
{
  "Engineering Manager": {
    "lastRunAt": "2026-04-02T10:00:00Z",
    "runCount": 42,
    "activeSessionIds": ["abc-123"],
    "lastError": null,
    "enabled": true
  }
}
```

### API Surface

**IPC Channels (main <-> renderer):**

```typescript
persona: {
  // Read operations
  list: () => Promise<PersonaInfo[]>
  getContent: (fileName: string) => Promise<string | null>
  getDir: () => Promise<string>

  // Write operations
  saveContent: (fileName: string, content: string) => Promise<boolean>
  create: (name: string) => Promise<{ fileName: string } | null>
  delete: (fileName: string) => Promise<boolean>

  // Actions
  run: (fileName: string) => Promise<string>  // returns instanceId
  stop: (fileName: string) => Promise<boolean>
  toggle: (fileName: string, enabled: boolean) => Promise<boolean>

  // Events (push from main to renderer)
  onStatus: (cb: (personas: PersonaInfo[]) => void) => () => void
  onRun: (cb: (data: { persona: string; instanceId: string }) => void) => () => void
}
```

**Shared types (in `src/shared/types.ts`):**

```typescript
export interface PersonaInfo {
  name: string
  fileName: string
  schedule: string | null
  model: string
  maxSessions: number
  color: string
  workingDirectory: string
  enabled: boolean
  running: boolean          // has active session(s)
  activeSessionIds: string[]
  lastRunAt: string | null
  runCount: number
  lastError: string | null
  // Permission summary
  canPush: boolean
  canMerge: boolean
  canCreateSessions: boolean
}
```

## Persona File Format Specification

### Parsing

The persona file is a Markdown file with YAML frontmatter delimited by `---`. The parser:

1. Extracts frontmatter between the first two `---` lines
2. Parses YAML key-value pairs (reuse the simple YAML parser from `pipeline-engine.ts` or use a lightweight approach since the schema is flat)
3. Extracts named sections by scanning for `## Heading` lines
4. Validates required fields (`name` is required; all others have defaults)

The persona body (everything after frontmatter) is freeform Markdown. The section headings are conventions, not enforced structure -- the planning loop prompt teaches the persona how to use them.

### File Naming

Files are named `<slugified-name>.md`. The slug is derived from the `name` field: lowercase, spaces to hyphens, strip non-alphanumeric. Example: `Engineering Manager` -> `engineering-manager.md`.

### Self-Modification Protocol

The persona modifies its own file by:
1. Reading the full file content at session start (path provided in system prompt)
2. Updating the `## Active Situations`, `## Learnings`, and `## Session Log` sections
3. Writing the modified content back to the same path

The planning loop prompt includes the exact file path and explicit instructions for which sections to modify and which to leave untouched.

## Planning Loop System Prompt

This is the system prompt injected into every persona session via `--append-system-prompt-file`. Template variables (`{{...}}`) are resolved before injection.

```markdown
# Persona: {{name}}

You are a persistent AI agent in Claude Colony. You have identity, memory, and goals
that persist across sessions. This is session #{{runCount}} for this persona.

## Your Identity File

Your complete identity, objectives, memory, and session history are stored in:
  {{personaFilePath}}

Read this file NOW, before doing anything else. It contains your Role, Objectives,
Active Situations, Learnings, and Session Log.

## Colony Context

The Colony workspace state is described in:
  {{colonyContextPath}}

Read this file to understand what sessions are running, what PRs are open, what
repos are tracked, and what other agents/personas exist.

## Planning Loop

Execute this cycle every session:

### 1. READ
- Read your identity file ({{personaFilePath}})
- Read the colony context ({{colonyContextPath}})
- Read any other files referenced in your Active Situations

### 2. ASSESS
- What has changed since your last session?
- Are any of your Active Situations resolved?
- Are there new situations that match your Objectives?
- What did you learn in previous sessions that applies now?

### 3. DECIDE
- Pick 1-3 concrete actions for this session
- Prioritize by: urgency > alignment with objectives > effort
- If nothing needs doing, say so and update your session log

### 4. ACT
- Execute your chosen actions
- Use the tools available to you (file read/write, shell commands, etc.)
- Stay within your permission scope (see below)

### 5. UPDATE
After completing your actions, update your identity file ({{personaFilePath}}):

**Active Situations** -- Replace the entire section content (keep the `## Active Situations` heading).
Write a concise summary of all in-flight work, blockers, and items you're tracking.

**Learnings** -- Append new entries if you discovered something useful. Remove entries
that are no longer relevant. Keep this section under 30 items.

**Session Log** -- Append exactly one entry in this format:
`- [{{timestamp}}] <one-line summary of what you did>`
If there are more than 20 entries, remove the oldest ones.

IMPORTANT: Do NOT modify the `## Role` or `## Objectives` sections. Those are set by your operator.
IMPORTANT: Write the complete file back, preserving the YAML frontmatter exactly as-is.

## Permissions

{{#if canPush}}
- You MAY push to git remotes
{{else}}
- You may NOT push to git remotes. Create branches and commits locally only.
{{/if}}
{{#if canMerge}}
- You MAY merge pull requests
{{else}}
- You may NOT merge pull requests
{{/if}}
{{#if canCreateSessions}}
- You MAY create child sessions by asking the user to launch them
{{else}}
- You may NOT create or request new sessions
{{/if}}

## Session Metadata

- Persona: {{name}}
- Session number: {{runCount}}
- Timestamp: {{timestamp}}
- Working directory: {{workingDirectory}}
- Model: {{model}}
```

The template variables are resolved at launch time by the persona manager. The `{{#if ...}}` blocks are simple conditional sections handled by the template resolver (3 flags, nothing complex -- a few string replacements).

## Migration Plan

### Phase 1: Persona Manager and File Format -- Core backend

**Goal:** Persona files can be loaded, validated, and listed from the main process. No UI yet.

**Files:**
- Create `src/shared/colony-paths.ts` -- add `personas` path
- Create `src/main/persona-manager.ts` -- file loading, parsing, state, session launch
- Modify `src/shared/types.ts` -- add `PersonaInfo` type
- Create `src/main/ipc/persona-handlers.ts` -- IPC registration
- Modify `src/main/ipc-handlers.ts` -- import and call `registerPersonaHandlers()`
- Modify `src/preload/index.ts` -- add `persona` namespace to API
- Modify `src/main/colony-context.ts` -- add personas section to colony context

**Steps:**

1. Add `personas: path.join(ROOT, 'personas')` to `colonyPaths` in `src/shared/colony-paths.ts`

2. Add types to `src/shared/types.ts`:
   ```typescript
   export interface PersonaInfo {
     name: string
     fileName: string
     schedule: string | null
     model: string
     maxSessions: number
     color: string
     workingDirectory: string
     enabled: boolean
     running: boolean
     activeSessionIds: string[]
     lastRunAt: string | null
     runCount: number
     lastError: string | null
     canPush: boolean
     canMerge: boolean
     canCreateSessions: boolean
   }
   ```

3. Create `src/main/persona-manager.ts` with:
   - `parsePersonaFrontmatter(content: string)` -- extract YAML frontmatter, return typed config
   - `loadPersonas()` -- scan `~/.claude-colony/personas/`, parse each `.md` file
   - `getPersonaList(): PersonaInfo[]` -- return current state
   - `getPersonaContent(fileName: string): string | null`
   - `savePersonaContent(fileName: string, content: string): boolean`
   - `createPersona(name: string): { fileName: string } | null` -- scaffold a new persona file with template
   - `deletePersona(fileName: string): boolean`
   - `runPersona(fileName: string): Promise<string>` -- build system prompt, launch session, return instanceId
   - `stopPersona(fileName: string): Promise<boolean>` -- kill active sessions for this persona
   - `togglePersona(fileName: string, enabled: boolean): boolean`
   - State persistence in `~/.claude-colony/persona-state.json`
   - File watcher using `fs.watch()` on the personas directory to auto-reload on external changes
   - Planning loop prompt builder with template resolution

   The `runPersona` function:
   - Reads the persona `.md` file
   - Builds the planning loop system prompt (template above) with all variables resolved
   - Writes it to a temp file via the same `writePromptFile` pattern as pipelines
   - Calls `createInstance()` with `--append-system-prompt-file` and the persona's working directory
   - Uses `sendPromptWhenReady()` to send: `"Read and execute the instructions in your system prompt. Begin now."`
   - Tracks the session ID in state
   - Broadcasts status update

   Session tracking: listen to daemon `exited` events (via the same `client.on('exited', ...)` pattern in instance-manager) to clean up `activeSessionIds` when persona sessions end.

4. Create `src/main/ipc/persona-handlers.ts`:
   ```typescript
   import { ipcMain } from 'electron'
   import {
     getPersonaList, getPersonaContent, savePersonaContent,
     createPersona, deletePersona, runPersona, stopPersona,
     togglePersona, getPersonasDir, loadPersonas,
   } from '../persona-manager'

   export function registerPersonaHandlers(): void {
     ipcMain.handle('persona:list', () => getPersonaList())
     ipcMain.handle('persona:getContent', (_e, fileName: string) => getPersonaContent(fileName))
     ipcMain.handle('persona:getDir', () => getPersonasDir())
     ipcMain.handle('persona:saveContent', (_e, fileName: string, content: string) => savePersonaContent(fileName, content))
     ipcMain.handle('persona:create', (_e, name: string) => createPersona(name))
     ipcMain.handle('persona:delete', (_e, fileName: string) => deletePersona(fileName))
     ipcMain.handle('persona:run', (_e, fileName: string) => runPersona(fileName))
     ipcMain.handle('persona:stop', (_e, fileName: string) => stopPersona(fileName))
     ipcMain.handle('persona:toggle', (_e, fileName: string, enabled: boolean) => togglePersona(fileName, enabled))
     ipcMain.handle('persona:reload', () => { loadPersonas(); return getPersonaList() })
   }
   ```

5. Add to `src/main/ipc-handlers.ts`:
   ```typescript
   import { registerPersonaHandlers } from './ipc/persona-handlers'
   // In registerIpcHandlers():
   registerPersonaHandlers()
   ```

6. Add to `src/preload/index.ts` -- both the type interface and the implementation:
   ```typescript
   // In ClaudeManagerAPI interface:
   persona: {
     list: () => Promise<PersonaInfo[]>
     getContent: (fileName: string) => Promise<string | null>
     getDir: () => Promise<string>
     saveContent: (fileName: string, content: string) => Promise<boolean>
     create: (name: string) => Promise<{ fileName: string } | null>
     delete: (fileName: string) => Promise<boolean>
     run: (fileName: string) => Promise<string>
     stop: (fileName: string) => Promise<boolean>
     toggle: (fileName: string, enabled: boolean) => Promise<boolean>
     reload: () => Promise<PersonaInfo[]>
     onStatus: (cb: (personas: PersonaInfo[]) => void) => () => void
     onRun: (cb: (data: { persona: string; instanceId: string }) => void) => () => void
   }

   // In api object:
   persona: {
     list: () => ipcRenderer.invoke('persona:list'),
     getContent: (fileName) => ipcRenderer.invoke('persona:getContent', fileName),
     getDir: () => ipcRenderer.invoke('persona:getDir'),
     saveContent: (fileName, content) => ipcRenderer.invoke('persona:saveContent', fileName, content),
     create: (name) => ipcRenderer.invoke('persona:create', name),
     delete: (fileName) => ipcRenderer.invoke('persona:delete', fileName),
     run: (fileName) => ipcRenderer.invoke('persona:run', fileName),
     stop: (fileName) => ipcRenderer.invoke('persona:stop', fileName),
     toggle: (fileName, enabled) => ipcRenderer.invoke('persona:toggle', fileName, enabled),
     reload: () => ipcRenderer.invoke('persona:reload'),
     onStatus: (cb) => {
       const l = (_e: any, data: PersonaInfo[]) => cb(data)
       ipcRenderer.on('persona:status', l)
       return () => ipcRenderer.removeListener('persona:status', l)
     },
     onRun: (cb) => {
       const l = (_e: any, data: { persona: string; instanceId: string }) => cb(data)
       ipcRenderer.on('persona:run', l)
       return () => ipcRenderer.removeListener('persona:run', l)
     },
   }
   ```

7. Modify `src/main/colony-context.ts` -- add a Personas section:
   ```typescript
   // After the Agents section, add:
   try {
     const { getPersonaList } = await import('./persona-manager')
     const personas = getPersonaList()
     if (personas.length > 0) {
       lines.push('## Personas', '')
       for (const p of personas) {
         const status = p.running ? '(running)' : p.enabled ? '(idle)' : '(disabled)'
         lines.push(`- **${p.name}** ${status} — last run: ${p.lastRunAt || 'never'}`)
       }
       lines.push('')
     }
   } catch { /* persona manager not loaded yet */ }
   ```

   Wait -- CLAUDE.md says static imports only in `src/main/`. So this must be a static import:
   ```typescript
   import { getPersonaList } from './persona-manager'
   ```
   And wrapped in try/catch for the function call, not the import.

8. Modify `src/main/index.ts` -- initialize persona manager on startup:
   ```typescript
   import { loadPersonas } from './persona-manager'
   // After startPipelines() call:
   loadPersonas()
   ```

**Validation:**
- `npx tsc --noEmit` passes
- `npm run build` succeeds
- Manually create a persona file in `~/.claude-colony/personas/test.md`, verify `persona:list` returns it via the dev tools console

**Risk:** The frontmatter parser needs to handle multiline strings and the Markdown body correctly. Keep it simple: split on the second `---`, parse the top as flat YAML, keep the bottom as raw Markdown.

---

### Phase 2: Persona Panel UI

**Goal:** Users can see, create, edit, and manually run personas from a dedicated UI tab.

**Files:**
- Create `src/renderer/src/components/PersonasPanel.tsx`
- Modify `src/renderer/src/components/Sidebar.tsx` -- add Personas nav button
- Modify `src/renderer/src/App.tsx` -- add 'personas' view routing
- Modify `src/renderer/src/styles/global.css` -- add persona-specific CSS
- Modify `src/renderer/src/lib/help-content.ts` -- add personas help topic
- Modify `src/renderer/src/components/HelpPopover.tsx` -- add any new icons to iconMap

**Steps:**

1. Add `'personas'` to the `SidebarView` union type in `Sidebar.tsx`:
   ```typescript
   export type SidebarView = 'instances' | 'agents' | 'github' | 'sessions' | 'settings' | 'logs' | 'tasks' | 'pipelines' | 'environments' | 'personas'
   ```

2. Add the nav button in `Sidebar.tsx` after the Environments button (or between Pipelines and Environments -- personas are conceptually closer to agents/pipelines):
   ```tsx
   <Tooltip text="Personas" detail="Long-lived AI agents with memory" position="bottom">
     <button className={`sidebar-nav-btn ${view === 'personas' ? 'active' : ''}`} onClick={() => onViewChange('personas')}>
       <User size={16} />
       {runningPersonaCount > 0 && <span className="sidebar-nav-badge">{runningPersonaCount}</span>}
     </button>
   </Tooltip>
   ```
   Import `User` from lucide-react. Add a `runningPersonaCount` state with the same pattern as `runningEnvCount`.

3. Create `PersonasPanel.tsx` following the `PipelinesPanel.tsx` structure:

   **Layout:**
   ```
   +--------------------------------------------------+
   | panel-header: [User icon] Personas  [spacer] [?] [+ New] [Reload] |
   +--------------------------------------------------+
   | panel-ask-bar: "Ask the Persona Assistant..."     |
   +--------------------------------------------------+
   | persona-card (for each persona)                   |
   |   [avatar dot] Name  [schedule badge] [Run btn]   |
   |   Description from Role section (first line)      |
   |   Status: idle | running (session link) | disabled |
   |   Last run: 2h ago | never                        |
   |   [expand: shows .md editor with tabs]            |
   |     [Identity] [Activity] [Log] [Raw]             |
   +--------------------------------------------------+
   ```

   **Component props** (same pattern as PipelinesPanel):
   ```typescript
   interface Props {
     onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
     onFocusInstance: (id: string) => void
     instances: Array<{ id: string; name: string; status: string }>
   }
   ```

   **Key interactions:**
   - **Run button:** Calls `window.api.persona.run(fileName)`, receives instanceId, calls `onFocusInstance(instanceId)` to switch to the session
   - **Stop button:** Calls `window.api.persona.stop(fileName)` (visible when persona has active sessions)
   - **Expand:** Shows the persona file in an editor with tabs for different sections
   - **Create:** Shows a simple name input, calls `window.api.persona.create(name)`, opens the new file in the editor
   - **Ask bar:** Same pattern as PipelinesPanel -- launches a Persona Assistant session with a system prompt that knows the persona file format

   **Expanded view tabs:**
   - **Identity** -- Read-only display of Role and Objectives sections (rendered as styled text)
   - **Situations** -- Editable textarea showing Active Situations and Learnings
   - **Log** -- Read-only session log with timestamp formatting
   - **Raw** -- Full file editor textarea (like pipeline YAML editor)

4. Add view routing in `App.tsx`:
   ```tsx
   {view === 'personas' && (
     <PersonasPanel
       instances={instances}
       onLaunchInstance={async (opts) => {
         const inst = await window.api.instance.create(opts)
         setActiveId(inst.id)
         setView('instances')
         return inst.id
       }}
       onFocusInstance={(id) => {
         setActiveId(id)
         setView('instances')
       }}
     />
   )}
   ```

5. Add CSS to `global.css`. Follow the pipeline naming convention but with `persona-` prefix:
   ```css
   /* ===== Personas Panel ===== */
   .personas-panel { padding: 16px 20px; overflow-y: auto; height: 100%; }
   .personas-description { ... }  /* same pattern as .pipelines-description */
   .personas-empty { ... }        /* same pattern as .pipelines-empty */
   .personas-list { ... }         /* same pattern as .pipelines-list */
   .persona-card { ... }          /* same pattern as .pipeline-card */
   .persona-card-header { ... }
   .persona-card-name { ... }
   .persona-card-role { ... }     /* first line of Role section, truncated */
   .persona-card-meta { ... }
   .persona-card-actions { ... }
   .persona-status-dot { ... }    /* same as .pipeline-status-dot */
   .persona-run-btn { ... }
   .persona-schedule-badge { ... }
   .persona-editor { ... }        /* same as .pipeline-editor */
   .persona-editor-tabs { ... }
   .persona-tab { ... }           /* same as .pipeline-tab */
   .persona-editor-textarea { ... }
   ```

6. Add help content to `src/renderer/src/lib/help-content.ts`:
   ```typescript
   personas: {
     title: 'Personas',
     description: 'Long-lived AI agents with identity, memory, and goals. Each persona runs periodically, maintains state across sessions, and can interact with the Colony ecosystem.',
     zones: [
       {
         name: 'Header',
         position: 'Top of panel',
         items: [
           { label: '+ New', detail: 'Create a new persona with a name and scaffold file.', icon: 'Plus' },
           { label: 'Reload', detail: 'Re-scan the personas directory for changes.', icon: 'RefreshCw' },
         ],
       },
       {
         name: 'Persona Cards',
         position: 'Main list',
         items: [
           { label: 'Run', detail: 'Manually trigger a persona session. The persona reads its identity file, assesses the situation, acts, and updates its memory.', icon: 'Play' },
           { label: 'Stop', detail: 'Kill all active sessions for this persona.', icon: 'Square' },
           { label: 'Expand', detail: 'View and edit the persona file. Identity tab shows Role/Objectives, Situations tab shows active state, Log tab shows session history.' },
         ],
       },
       {
         name: 'Ask Bar',
         position: 'Below header',
         items: [
           { label: 'Persona Assistant', detail: 'Ask an AI to help create or refine a persona definition. Launches a session with knowledge of the persona file format.' },
         ],
       },
     ],
   }
   ```

7. Add `<HelpPopover topic="personas" align="right" />` in the PersonasPanel header.

**Validation:**
- Personas tab appears in sidebar with User icon
- Clicking it shows the panel with any existing persona files listed
- "New" creates a scaffold file and opens editor
- "Run" launches a session, switches to terminal view, persona executes planning loop
- Session log shows the persona reading its file, assessing, acting, updating
- After session completes, persona file has updated Active Situations and Session Log sections

**Risk:** The sidebar is getting crowded (7 nav buttons already). The User icon from lucide-react is distinct enough. If sidebar space becomes an issue, that's a separate concern -- don't let it block this feature.

---

### Phase 3: Session Labeling and Colony Context Integration

**Goal:** Persona sessions are visually identifiable in the sidebar and colony context includes persona information.

**Files:**
- Modify `src/main/persona-manager.ts` -- add persona tag to session metadata
- Modify `src/renderer/src/components/Sidebar.tsx` -- show persona badge on sessions
- Modify `src/main/colony-context.ts` -- already done in Phase 1 step 7

**Steps:**

1. When `runPersona()` creates a session, prefix the name with the persona's identity:
   ```typescript
   const inst = await createInstance({
     name: `${persona.name}`,
     workingDirectory: resolvedCwd,
     color: persona.color,
     args: ['--append-system-prompt-file', promptFile],
   })
   ```

   Additionally, store a mapping of `instanceId -> personaFileName` in the persona manager so we can tell the UI which sessions are persona-driven.

2. In the sidebar session list, if a session's ID is in a persona's `activeSessionIds`, show a small persona indicator (a colored dot or label) next to the session name.

3. Track session exits: when a persona session exits, remove it from `activeSessionIds`, update `lastRunAt`, and broadcast status.

**Validation:**
- Running a persona shows the session in the sidebar with the persona's name and color
- When the session exits, the persona state updates (lastRunAt, runCount)
- Colony context file includes personas section

**Risk:** Minimal. This is cosmetic and bookkeeping.

---

### Phase 4: Scheduling (Future)

**Goal:** Personas with a `schedule` field run automatically.

This phase is deferred per the design constraints ("Manual Run button for Phase 1, scheduling comes later"). When implemented:

- Reuse `cronMatches()` from `pipeline-engine.ts` (extract to `src/shared/cron.ts` or import directly)
- Add a scheduler loop in `persona-manager.ts` that checks enabled personas with schedules every 60 seconds
- Respect `max_sessions` -- don't launch if already at capacity
- Add enable/disable toggle per persona (already in the API surface)

**Files:**
- Modify `src/main/persona-manager.ts` -- add `startPersonaScheduler()`, `stopPersonaScheduler()`
- Possibly extract `cronMatches()` to a shared utility if importing from pipeline-engine causes circular deps
- Modify `src/main/index.ts` -- call `startPersonaScheduler()` after `startPipelines()`

## Decisions Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Single `.md` file per persona (not YAML + separate memory) | The whole point is the persona reads and writes ONE file. Keeps the mental model simple. The file IS the persona. | Separate YAML config + memory.md + log.md -- too many files, harder for the persona to manage atomically |
| YAML frontmatter in Markdown (not pure YAML) | The body needs to be freeform Markdown that the persona writes naturally. Frontmatter gives us structured config without a separate file. Standard convention (Jekyll, Hugo, Obsidian). | Pure YAML with multiline blocks -- harder for the persona to edit correctly |
| Reuse `createInstance()` directly (not pipeline engine) | Persona sessions are simpler than pipeline actions -- no triggers, conditions, dedup, routing. Just: build prompt, launch session, track it. The pipeline engine would add unnecessary coupling. | Route through pipeline engine -- adds indirection for no benefit |
| Extract `cronMatches()` later (Phase 4) | No scheduling in Phase 1. Premature to refactor now. When scheduling is needed, the extraction is trivial. | Extract immediately -- YAGNI for Phase 1 |
| Persona modifies its own file via shell commands in the session | The persona is a Claude CLI session with full file access. It can read/write its own `.md` file directly. No special IPC needed. | IPC-based self-modification API -- over-engineering for a file write |
| No budget caps | Per design constraints. Can be added later as a frontmatter field + token tracking from `ClaudeInstance.tokenUsage`. | -- |
| Template variables use `{{...}}` not Handlebars-style `{{#if}}` | The conditional sections (permissions) are simple enough to handle with string replacement. Three boolean flags don't justify a template engine dependency. | Use a real template library -- dependency bloat for 3 if-statements |
| State in separate JSON file (not in the `.md`) | State (lastRunAt, runCount, activeSessionIds) is operational metadata, not identity. The persona shouldn't see or modify it. Keeping it separate means the `.md` file is purely about identity and memory. | Embed state in frontmatter -- pollutes the identity file with operational noise |

## Open Questions

- **Icon choice for sidebar:** `User` from lucide-react is the obvious choice but could be confused with account/profile. Alternatives: `UserCog`, `Brain`, `Sparkles`, `Ghost`. Recommend `User` -- it's standard for "persona/identity."

- **Concurrent persona sessions:** When `max_sessions > 1`, should each session get the same system prompt, or should they coordinate? For Phase 1 with `max_sessions: 1` default, this is moot. When needed, the simplest approach is: each session gets the same prompt and reads the same file. Last-write-wins on the identity file. The persona should be designed to handle this (or keep `max_sessions: 1`).

- **Persona file conflicts:** If a persona session is writing its identity file while the user edits it in the UI, last-write-wins. This is acceptable for Phase 1. A future enhancement could show a "modified externally" warning in the editor (same problem pipelines have, unsolved there too).
