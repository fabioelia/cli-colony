import { promises as fsp } from 'fs'
import * as path from 'path'
import { expandEnvVars } from '../shared/utils'
import { colonyPaths } from '../shared/colony-paths'

export interface McpServerDef {
  name: string
  command?: string
  args?: string[]
  url?: string
  description?: string
  env?: Record<string, string>
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
