import { promises as fsp } from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { expandEnvVars } from '../shared/utils'
import { colonyPaths } from '../shared/colony-paths'

export interface McpServerDef {
  name: string
  command?: string
  args?: string[]
  url?: string
  description?: string
  env?: Record<string, string>
  /** 'gh-skill' for auto-discovered gh skills; absent or 'manual' for user-added entries */
  source?: 'manual' | 'gh-skill'
}

export async function readCatalog(): Promise<McpServerDef[]> {
  try {
    return JSON.parse(await fsp.readFile(colonyPaths.mcpCatalog, 'utf-8')) as McpServerDef[]
  } catch {
    return []
  }
}

export async function writeCatalog(servers: McpServerDef[]): Promise<void> {
  await fsp.mkdir(path.dirname(colonyPaths.mcpCatalog), { recursive: true })
  await fsp.writeFile(colonyPaths.mcpCatalog, JSON.stringify(servers, null, 2), 'utf-8')
}

/**
 * Build a temporary --mcp-config JSON file for the named servers.
 * Returns the file path, or null if no valid servers were found.
 * Expands environment variables in command arguments (e.g., $HOME, ${VAR}).
 * Custom env variables defined per server take precedence over system env.
 */
export async function buildMcpConfig(serverNames: string[], configId: string): Promise<string | null> {
  const catalog = await readCatalog()
  const selected = catalog.filter((s) => serverNames.includes(s.name))
  if (selected.length === 0) return null

  const mcpServers: Record<string, unknown> = {}
  for (const s of selected) {
    if (s.url) {
      mcpServers[s.name] = { type: 'sse', url: s.url }
    } else if (s.command) {
      // Merge system env + custom server env (custom takes precedence)
      const mergedEnv = { ...process.env, ...(s.env ?? {}) } as Record<string, string>
      // Expand environment variables in each arg using merged env
      const expandedArgs = (s.args ?? []).map((arg) => expandEnvVars(arg, mergedEnv))
      mcpServers[s.name] = { command: s.command, args: expandedArgs }
    }
  }
  if (Object.keys(mcpServers).length === 0) return null

  await fsp.mkdir(colonyPaths.mcpConfigs, { recursive: true })
  const configPath = path.join(colonyPaths.mcpConfigs, `${configId}.json`)
  await fsp.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8')
  return configPath
}

/** Delete a previously-written config file (called on session exit). */
export async function cleanMcpConfigFile(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath)
  } catch { /* ignore */ }
}

/** Platform-specific path to the gh skills directory. */
function getGhSkillsDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? homedir(), 'gh', 'skills')
  }
  return path.join(homedir(), '.local', 'share', 'gh', 'skills')
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

async function readSkillManifest(skillDir: string): Promise<Partial<McpServerDef> | null> {
  // Try skill.yml first, then package.json
  const ymlPath = path.join(skillDir, 'skill.yml')
  const pkgPath = path.join(skillDir, 'package.json')
  try {
    if (await pathExists(ymlPath)) {
      const raw = await fsp.readFile(ymlPath, 'utf-8')
      // Simple key: value extraction for name and description
      const nameMatch = raw.match(/^name:\s*(.+)$/m)
      const descMatch = raw.match(/^description:\s*(.+)$/m)
      const cmdMatch = raw.match(/^command:\s*(.+)$/m)
      if (!nameMatch) return null
      return {
        name: nameMatch[1].trim().replace(/^['"]|['"]$/g, ''),
        description: descMatch?.[1].trim().replace(/^['"]|['"]$/g, ''),
        command: cmdMatch?.[1].trim(),
      }
    }
    if (await pathExists(pkgPath)) {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf-8'))
      if (!pkg.name) return null
      return {
        name: pkg.name as string,
        description: pkg.description as string | undefined,
        command: pkg.bin ? 'npx' : undefined,
        args: pkg.bin ? [pkg.name as string] : undefined,
      }
    }
  } catch { /* malformed — skip */ }
  return null
}

let _ghSkillCache: { ts: number; skills: McpServerDef[] } | null = null
const GH_SKILL_CACHE_TTL = 60_000

export async function discoverGhSkills(): Promise<McpServerDef[]> {
  if (_ghSkillCache && Date.now() - _ghSkillCache.ts < GH_SKILL_CACHE_TTL) {
    return _ghSkillCache.skills
  }
  const skillsDir = getGhSkillsDir()
  if (!await pathExists(skillsDir)) {
    _ghSkillCache = { ts: Date.now(), skills: [] }
    return []
  }
  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true })
    const skills: McpServerDef[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = await readSkillManifest(path.join(skillsDir, entry.name))
      if (manifest?.name) {
        skills.push({ name: manifest.name, command: manifest.command, args: manifest.args, description: manifest.description, source: 'gh-skill' })
      }
    }
    _ghSkillCache = { ts: Date.now(), skills }
    return skills
  } catch {
    return []
  }
}

/** Read ignored gh skill names from ghSkillIgnored JSON. */
async function readIgnored(): Promise<string[]> {
  try { return JSON.parse(await fsp.readFile(colonyPaths.ghSkillIgnored, 'utf-8')) as string[] } catch { return [] }
}

/**
 * Merge discovered gh skills into the catalog.
 * Skips ignored entries and existing entries (by name).
 * Returns the updated catalog.
 */
export async function mergeGhSkills(): Promise<McpServerDef[]> {
  const [catalog, discovered, ignored] = await Promise.all([readCatalog(), discoverGhSkills(), readIgnored()])
  const existingNames = new Set(catalog.map(s => s.name))
  const ignoredSet = new Set(ignored)
  let changed = false
  for (const skill of discovered) {
    if (!existingNames.has(skill.name) && !ignoredSet.has(skill.name)) {
      catalog.push(skill)
      existingNames.add(skill.name)
      changed = true
    }
  }
  if (changed) await writeCatalog(catalog)
  return catalog
}

/** Mark a gh skill as ignored so it won't re-appear on next discovery. */
export async function ignoreGhSkill(name: string): Promise<void> {
  const ignored = await readIgnored()
  if (!ignored.includes(name)) {
    ignored.push(name)
    await fsp.mkdir(path.dirname(colonyPaths.ghSkillIgnored), { recursive: true })
    await fsp.writeFile(colonyPaths.ghSkillIgnored, JSON.stringify(ignored, null, 2), 'utf-8')
  }
}
