/**
 * Centralized path constants for ~/.claude-colony.
 *
 * Usage:
 *   import { colonyPaths } from '../shared/colony-paths'
 *   const dir = colonyPaths.environments   // => /Users/x/.claude-colony/environments
 */

import * as os from 'os'
import * as path from 'path'

const HOME = os.homedir()
const ROOT = path.join(HOME, '.claude-colony')

function getDaemonAddress(name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\claude-colony-${name}`
  }
  return path.join(ROOT, `${name}.sock`)
}

export const colonyPaths = {
  root: ROOT,

  // Top-level files
  settingsJson: path.join(ROOT, 'settings.json'),
  githubJson: path.join(ROOT, 'github.json'),
  daemonLog: path.join(ROOT, 'daemon.log'),
  schedulerLog: path.join(ROOT, 'scheduler.log'),
  colonyContext: path.join(ROOT, 'colony-context.md'),

  // Daemon sockets / PIDs (named pipes on Windows, Unix sockets elsewhere)
  daemonSock: getDaemonAddress('daemon'),
  daemonPid: path.join(ROOT, 'daemon.pid'),
  daemonNextSock: getDaemonAddress('daemon-next'),
  daemonNextPid: path.join(ROOT, 'daemon-next.pid'),
  envdSock: getDaemonAddress('envd'),
  envdPid: path.join(ROOT, 'envd.pid'),
  envIndex: path.join(ROOT, 'environments.json'),

  // Directories
  environments: path.join(ROOT, 'environments'),
  templates: path.join(ROOT, 'environment-templates'),
  repos: path.join(ROOT, 'repos'),
  pipelines: path.join(ROOT, 'pipelines'),
  pipelinePrompts: path.join(ROOT, 'pipeline-prompts'),
  prWorkspace: path.join(ROOT, 'pr-workspace'),
  prComments: path.join(ROOT, 'pr-workspace', 'comments'),
  reports: path.join(ROOT, 'reports'),
  screenshots: path.join(ROOT, 'screenshots'),
  taskWorkspace: path.join(ROOT, 'task-workspace'),
  taskQueues: path.join(ROOT, 'task-queues'),
  personas: path.join(ROOT, 'personas'),
  personaTemplates: path.join(ROOT, 'persona-templates'),
  personaState: path.join(ROOT, 'persona-state.json'),
  recentSessions: path.join(ROOT, 'recent-sessions.json'),
  activityLog: path.join(ROOT, 'activity.json'),
  knowledgeBase: path.join(ROOT, 'KNOWLEDGE.md'),
  mcpCatalog: path.join(ROOT, 'mcp-catalog.json'),
  mcpConfigs: path.join(ROOT, 'mcp-configs'),
  sessions: path.join(ROOT, 'sessions'),
  taskBoard: path.join(ROOT, 'colony-tasks.json'),
  wake: path.join(ROOT, 'wake'),
  triggers: path.join(ROOT, 'triggers'),
  bin: path.join(ROOT, 'bin'),
  worktrees: path.join(ROOT, 'worktrees'),
  specs: path.join(ROOT, 'specs'),
  forks: path.join(ROOT, 'forks'),
  artifacts: path.join(ROOT, 'artifacts'),
  coordination: path.join(ROOT, 'coordination'),
  forkGroups: path.join(ROOT, 'fork-groups.json'),
  scorecards: path.join(ROOT, 'scorecards.json'),
  sessionArtifacts: path.join(ROOT, 'session-artifacts.json'),
  sessionTemplates: path.join(ROOT, 'session-templates.json'),
  notificationHistory: path.join(ROOT, 'notification-history.json'),
  governance: path.join(ROOT, 'governance'),
  approvalRulesJson: path.join(ROOT, 'governance', 'approval-rules.json'),
  onboardingStateJson: path.join(ROOT, 'onboarding-state.json'),
  projectBriefs: path.join(ROOT, 'project-briefs'),
  reviewRules: path.join(ROOT, 'review-rules.json'),
  ghSkillIgnored: path.join(ROOT, 'gh-skill-ignored.json'),
  playbooks: path.join(ROOT, 'playbooks'),
  proofs: path.join(ROOT, 'proofs'),
  notes: path.join(ROOT, 'notes'),
  recipes: path.join(ROOT, 'recipes'),

  /** Build a daily activity log path for a given date (YYYY-MM-DD) */
  activityDailyLog: (date: string) => path.join(ROOT, `activity-${date}.json`),

  /** Build a proof-of-work file path: proofs/<YYYY-MM-DD>/<slug>-<ts>.md */
  proofFile: (date: string, slug: string, ts: number) =>
    path.join(ROOT, 'proofs', date, `${slug}-${ts}.md`),

  /** Build a per-project brief path for a given slug (basename of working directory) */
  projectBrief: (slug: string) => path.join(ROOT, 'project-briefs', `${slug}.md`),

  /** Build a repo clone path for a given owner/name (shallow clones for GitHub panel) */
  repoDir: (owner: string, name: string) => path.join(ROOT, 'repos', owner, name),

  /** Build a bare repo path for worktree-based environments: repos/<owner>/<name>.git */
  bareRepoDir: (owner: string, name: string) => path.join(ROOT, 'repos', owner, name + '.git'),

  /** Build an environment instance path */
  envDir: (envName: string) => path.join(ROOT, 'environments', envName),

  /** Build a worktree directory path */
  worktreeDir: (worktreeId: string) => path.join(ROOT, 'worktrees', worktreeId),

  /** Build a template file path */
  templateFile: (safeName: string) => path.join(ROOT, 'environment-templates', `${safeName}.json`),
}
