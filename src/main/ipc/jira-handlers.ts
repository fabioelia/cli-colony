import { ipcMain } from 'electron'
import { fetchTicket } from '../jira'

export function registerJiraHandlers(): void {
  ipcMain.handle('jira:fetchTicket', async (_e, key: string) => {
    try {
      const ticket = await fetchTicket(key)
      return { ok: true, ticket }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
