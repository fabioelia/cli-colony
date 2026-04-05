import { ipcMain } from 'electron'
import { readCatalog, writeCatalog } from '../mcp-catalog'
import type { McpServerDef } from '../mcp-catalog'

export function registerMcpCatalogHandlers(): void {
  ipcMain.handle('mcp:list', () => readCatalog())

  ipcMain.handle('mcp:save', (_e, server: McpServerDef) => {
    const catalog = readCatalog()
    const idx = catalog.findIndex((s) => s.name === server.name)
    if (idx >= 0) {
      catalog[idx] = server
    } else {
      catalog.push(server)
    }
    writeCatalog(catalog)
    return readCatalog()
  })

  ipcMain.handle('mcp:delete', (_e, name: string) => {
    const catalog = readCatalog().filter((s) => s.name !== name)
    writeCatalog(catalog)
    return catalog
  })
}
