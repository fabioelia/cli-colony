import { ipcMain } from 'electron'
import { readCatalog, writeCatalog } from '../mcp-catalog'
import type { McpServerDef } from '../mcp-catalog'

export function registerMcpCatalogHandlers(): void {
  ipcMain.handle('mcp:list', () => readCatalog())

  ipcMain.handle('mcp:save', async (_e, server: McpServerDef, originalName?: string) => {
    const catalog = await readCatalog()
    const lookupName = originalName ?? server.name
    const idx = catalog.findIndex((s) => s.name === lookupName)
    if (idx >= 0) {
      catalog[idx] = server
    } else {
      catalog.push(server)
    }
    await writeCatalog(catalog)
    return catalog
  })

  ipcMain.handle('mcp:delete', async (_e, name: string) => {
    const catalog = (await readCatalog()).filter((s) => s.name !== name)
    await writeCatalog(catalog)
    return catalog
  })
}
