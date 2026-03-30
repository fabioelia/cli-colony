/**
 * Centralized path constants for ~/.claude-colony.
 *
 * Usage:
 *   import { colonyPaths } from '../shared/colony-paths'
 *   const dir = colonyPaths.environments   // => /Users/x/.claude-colony/environments
 */

import * as path from 'path'

const HOME = process.env.HOME || '/'
const ROOT = path.join(HOME, '.claude-colony')

export const colonyPaths = {
  root: ROOT,

  // Top-level files
  settingsJson: path.join(ROOT, 'settings.json'),
  githubJson: path.join(ROOT, 'github.json'),
  daemonLog: path.join(ROOT, 'daemon.log'),
  colonyContext: path.join(ROOT, 'colony-context.md'),

  // Daemon sockets / PIDs
  daemonSock: path.join(ROOT, 'daemon.sock'),
  daemonPid: path.join(ROOT, 'daemon.pid'),
  envdSock: path.join(ROOT, 'envd.sock'),
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
  recentSessions: path.join(ROOT, 'recent-sessions.json'),

  /** Build a repo clone path for a given owner/name */
  repoDir: (owner: string, name: string) => path.join(ROOT, 'repos', owner, name),

  /** Build an environment instance path */
  envDir: (envName: string) => path.join(ROOT, 'environments', envName),

  /** Build a template file path */
  templateFile: (safeName: string) => path.join(ROOT, 'environment-templates', `${safeName}.json`),
}
