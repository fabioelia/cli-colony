import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { app } from 'electron'
import type { AgentDef } from '../shared/types'
import { parseFrontmatter } from '../shared/utils'

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

const AGENT_TEMPLATE = `---
name: {{name}}
description: Describe what this agent does
tools: Read, Edit, Bash, Glob, Grep
model: sonnet
---

You are a helpful agent. Describe your role and capabilities here.
`

export function createAgent(name: string, scope: 'personal' | 'project', projectPath?: string): AgentDef | null {
  const home = app.getPath('home')
  let dir: string
  let projectName: string | undefined

  if (scope === 'personal') {
    dir = join(home, '.claude', 'agents')
  } else if (projectPath) {
    dir = join(projectPath, '.claude', 'agents')
    projectName = basename(projectPath)
  } else {
    return null
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md'
  const filePath = join(dir, fileName)

  if (existsSync(filePath)) {
    return null
  }

  const content = AGENT_TEMPLATE.replace('{{name}}', name)
  writeFileSync(filePath, content, 'utf-8')

  return {
    id: `${scope}:${projectName || 'personal'}:${name}`,
    name,
    description: 'Describe what this agent does',
    tools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
    model: 'sonnet',
    filePath,
    scope,
    projectName,
  }
}
