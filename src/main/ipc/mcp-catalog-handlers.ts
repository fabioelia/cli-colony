import { ipcMain } from 'electron'
import { readCatalog, writeCatalog } from '../mcp-catalog'
import type { McpServerDef } from '../mcp-catalog'

export function registerMcpCatalogHandlers(): void {
  ipcMain.handle('mcp:list', () => readCatalog())

  ipcMain.handle('mcp:save', async (_e, server: McpServerDef) => {
    const catalog = await readCatalog()
    const idx = catalog.findIndex((s) => s.name === server.name)
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
