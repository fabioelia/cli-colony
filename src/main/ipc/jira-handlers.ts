import { ipcMain } from 'electron'
import { fetchTicket, searchMyTickets, transitionTicket, addComment } from '../jira'
import { getSettings } from '../settings'

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

  ipcMain.handle('jira:transitionTicket', async (_e, key: string) => {
    try {
      const settings = await getSettings()
      const transitionName = settings.jiraTransitionOnCommit?.trim()
      if (!transitionName) return { ok: false, error: 'No transition configured' }
      await transitionTicket(key, transitionName)
      return { ok: true, transitionName }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('jira:addComment', async (_e, key: string, body: string) => {
    try {
      return await addComment(key, body)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
