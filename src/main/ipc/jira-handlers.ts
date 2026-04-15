import { ipcMain } from 'electron'
import { fetchTicket, searchMyTickets } from '../jira'

export function registerJiraHandlers(): void {
  ipcMain.handle('jira:fetchTicket', async (_e, key: string) => {
    try {
      const ticket = await fetchTicket(key)
      return { ok: true, ticket }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('jira:myTickets', async () => {
    try {
      const tickets = await searchMyTickets()
      return { ok: true, tickets }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
