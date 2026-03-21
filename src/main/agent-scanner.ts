import { readdirSync, readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { app } from 'electron'

export interface AgentDef {
  id: string
  name: string
  description: string
  tools: string[]
  model?: string
  color?: string
  filePath: string
  scope: 'personal' | 'project'
  projectName?: string
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      meta[key] = value
    }
  }
  return meta
}

function scanDir(dir: string, scope: 'personal' | 'project', projectName?: string): AgentDef[] {
  if (!existsSync(dir)) return []
  const agents: AgentDef[] = []
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const content = readFileSync(filePath, 'utf-8')
        const meta = parseFrontmatter(content)
        if (!meta.name) continue
        agents.push({
          id: `${scope}:${projectName || 'personal'}:${meta.name}`,
          name: meta.name,
          description: meta.description || '',
          tools: meta.tools ? meta.tools.split(',').map((t) => t.trim()) : [],
          model: meta.model || undefined,
          color: meta.color || undefined,
          filePath,
          scope,
          projectName,
        })
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // dir not readable
  }
  return agents
}

export function scanAgents(projectPaths?: string[]): AgentDef[] {
  const home = app.getPath('home')
  const agents: AgentDef[] = []

  // Personal agents
  agents.push(...scanDir(join(home, '.claude', 'agents'), 'personal'))

  // Project agents — scan known project dirs
  if (projectPaths) {
    for (const projPath of projectPaths) {
      const projName = basename(projPath)
      agents.push(...scanDir(join(projPath, '.claude', 'agents'), 'project', projName))
    }
  }

  // Also scan ~/projects/* for any .claude/agents dirs
  const projectsDir = join(home, 'projects')
  if (existsSync(projectsDir)) {
    try {
      const dirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(projectsDir, d.name))
      for (const dir of dirs) {
        const agentDir = join(dir, '.claude', 'agents')
        if (existsSync(agentDir)) {
          const projName = basename(dir)
          // Avoid duplicates
          const existing = agents.filter((a) => a.projectName === projName)
          if (existing.length === 0) {
            agents.push(...scanDir(agentDir, 'project', projName))
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return agents
}
