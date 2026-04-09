import { ipcMain } from 'electron'
import { listArtifacts, getArtifact, clearArtifacts, collectSessionArtifact, tagArtifactPipeline } from '../session-artifacts'
import type { SessionArtifact } from '../../shared/types'

export function registerSessionArtifactHandlers(): void {
  ipcMain.handle('artifacts:list', async (): Promise<SessionArtifact[]> => {
    return listArtifacts()
  })

  ipcMain.handle('artifacts:get', async (_e, sessionId: string): Promise<SessionArtifact | null> => {
    return getArtifact(sessionId)
  })

  ipcMain.handle('artifacts:collect', async (_e, sessionId: string): Promise<SessionArtifact | null> => {
    return collectSessionArtifact(sessionId)
  })

  ipcMain.handle('artifacts:clear', async (): Promise<boolean> => {
    await clearArtifacts()
    return true
  })

  ipcMain.handle('artifacts:tagPipeline', async (_e, sessionId: string, pipelineRunId: string): Promise<boolean> => {
    return tagArtifactPipeline(sessionId, pipelineRunId)
  })
}
