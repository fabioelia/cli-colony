import * as fs from 'fs'
import * as path from 'path'
import { expandEnvVars } from '../shared/utils'
import { colonyPaths } from '../shared/colony-paths'

export interface McpServerDef {
  name: string
  command?: string
  args?: string[]
  url?: string
  description?: string
}

export function readCatalog(): McpServerDef[] {
  try {
    if (!fs.existsSync(colonyPaths.mcpCatalog)) return []
    return JSON.parse(fs.readFileSync(colonyPaths.mcpCatalog, 'utf-8')) as McpServerDef[]
  } catch {
    return []
  }
}

export function writeCatalog(servers: McpServerDef[]): void {
  fs.mkdirSync(path.dirname(colonyPaths.mcpCatalog), { recursive: true })
  fs.writeFileSync(colonyPaths.mcpCatalog, JSON.stringify(servers, null, 2), 'utf-8')
}

/**
 * Build a temporary --mcp-config JSON file for the named servers.
 * Returns the file path, or null if no valid servers were found.
 * Expands environment variables in command arguments (e.g., $HOME, ${VAR}).
 */
export function buildMcpConfig(serverNames: string[], configId: string): string | null {
  const catalog = readCatalog()
  const selected = catalog.filter((s) => serverNames.includes(s.name))
  if (selected.length === 0) return null

  const mcpServers: Record<string, unknown> = {}
  for (const s of selected) {
    if (s.url) {
      mcpServers[s.name] = { type: 'sse', url: s.url }
    } else if (s.command) {
      // Expand environment variables in each arg
      const expandedArgs = (s.args ?? []).map((arg) => expandEnvVars(arg))
      mcpServers[s.name] = { command: s.command, args: expandedArgs }
    }
  }
  if (Object.keys(mcpServers).length === 0) return null

  fs.mkdirSync(colonyPaths.mcpConfigs, { recursive: true })
  const configPath = path.join(colonyPaths.mcpConfigs, `${configId}.json`)
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8')
  return configPath
}

/** Delete a previously-written config file (called on session exit). */
export function cleanMcpConfigFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}
