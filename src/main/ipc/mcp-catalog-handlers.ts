import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { readCatalog, writeCatalog, mergeGhSkills, ignoreGhSkill } from '../mcp-catalog'
import type { McpServerDef } from '../mcp-catalog'

export function registerMcpCatalogHandlers(): void {
  ipcMain.handle('mcp:list', () => readCatalog())

  ipcMain.handle('mcp:refreshSkills', () => mergeGhSkills())

  ipcMain.handle('mcp:ignoreGhSkill', async (_e, name: string) => {
    await ignoreGhSkill(name)
    const catalog = (await readCatalog()).filter((s) => s.name !== name)
    await writeCatalog(catalog)
    return catalog
  })

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

  ipcMain.handle('mcp:test', async (_e, server: McpServerDef) => {
    if (server.url) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(server.url, { signal: controller.signal, method: 'GET' })
        clearTimeout(timer)
        return { ok: res.ok, message: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${res.statusText}` }
      } catch (e: any) {
        return { ok: false, message: e.name === 'AbortError' ? 'Timeout (5s)' : e.message }
      }
    } else if (server.command) {
      return new Promise<{ ok: boolean; message: string }>((resolve) => {
        const env = { ...process.env, ...(server.env ?? {}) }
        const child = spawn(server.command!, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
        const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: 'Timeout (5s)' }) }, 5000)
        child.stdout.once('data', () => { clearTimeout(timer); child.kill(); resolve({ ok: true, message: 'Process started, stdout received' }) })
        child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, message: err.message }) })
        child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true, message: 'Exited cleanly' } : { ok: false, message: `Exit code ${code}` }) })
      })
    }
    return { ok: false, message: 'No command or URL configured' }
  })
}
