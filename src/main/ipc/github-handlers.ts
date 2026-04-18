import { ipcMain, app } from 'electron'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import {
  checkGhAuth, fetchPRs, fetchPRFiles, postPRComment, submitPRReview, mergePR, fetchIssues, createIssue, getRepos, addRepo, removeRepo, getRemovalImpact,
  updateRepoPath, getPrompts, savePrompts, resolvePrompt, writePrContext,
  getPrMemory, savePrMemory, getPrMemoryPath, getPrWorkspacePath,
  fetchChecks, fetchCheckLogs, ensureBareClone,
  getGitHubUser, fetchFeedbackFiles,
} from '../github'
import type { GitHubRepo, QuickPrompt, GitHubPR } from '../../shared/types'

export function registerGitHubHandlers(): void {
  ipcMain.handle('github:authStatus', () => checkGhAuth())
  ipcMain.handle('github:fetchPRs', (_e, repo: GitHubRepo) => fetchPRs(repo))
  ipcMain.handle('github:getRepos', () => getRepos())
  ipcMain.handle('github:addRepo', (_e, repo: GitHubRepo) => addRepo(repo))
  ipcMain.handle('github:cloneRepo', async (_e, repo: GitHubRepo) => {
    await ensureBareClone(repo)
    return true
  })
  ipcMain.handle('github:removeRepo', (_e, owner: string, name: string) => removeRepo(owner, name))
  ipcMain.handle('github:getRemovalImpact', (_e, owner: string, name: string) => getRemovalImpact(owner, name))
  ipcMain.handle('github:updateRepoPath', (_e, owner: string, name: string, localPath: string) => updateRepoPath(owner, name, localPath))
  ipcMain.handle('github:getPrompts', () => getPrompts())
  ipcMain.handle('github:savePrompts', (_e, prompts: QuickPrompt[]) => savePrompts(prompts))
  ipcMain.handle('github:resolvePrompt', (_e, prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => resolvePrompt(prompt, pr, repo))
  ipcMain.handle('github:writePrContext', (_e, prsByRepo: Record<string, GitHubPR[]>) => writePrContext(prsByRepo))
  ipcMain.handle('github:getPrMemory', () => getPrMemory())
  ipcMain.handle('github:savePrMemory', (_e, content: string) => savePrMemory(content))
  ipcMain.handle('github:getPrMemoryPath', () => getPrMemoryPath())
  ipcMain.handle('github:getPrWorkspacePath', () => getPrWorkspacePath())
  ipcMain.handle('github:getCommentsFile', async (_e, repoSlug: string, prNumber: number) => {
    const commentsDir = colonyPaths.prComments
    const safeSlug = repoSlug.replace(/\//g, '-')
    const filePath = join(commentsDir, `${safeSlug}-${prNumber}.md`)
    try { return await fsp.readFile(filePath, 'utf-8') } catch { return null }
  })
  ipcMain.handle('github:fetchChecks', (_e, repo: GitHubRepo, prNumber: number) => fetchChecks(repo, prNumber))
  ipcMain.handle('github:fetchCheckLogs', (_e, repo: GitHubRepo, prNumber: number, checkName: string) => fetchCheckLogs(repo, prNumber, checkName))
  ipcMain.handle('github:getUser', () => getGitHubUser())
  ipcMain.handle('github:fetchFeedback', (_e, repo: GitHubRepo, prNumber: number) => fetchFeedbackFiles(repo, prNumber))
  ipcMain.handle('github:fetchPRFiles', (_e, repo: GitHubRepo, prNumber: number) => fetchPRFiles(repo, prNumber))
  ipcMain.handle('github:postPRComment', (_e, repo: GitHubRepo, prNumber: number, body: string) => postPRComment(repo, prNumber, body))
  ipcMain.handle('github:submitReview', (_e, repo: GitHubRepo, prNumber: number, event: string, body?: string) =>
    submitPRReview(repo, prNumber, event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body))
  ipcMain.handle('github:mergePR', (_e, repo: GitHubRepo, prNumber: number, method: 'merge' | 'squash' | 'rebase') => mergePR(repo, prNumber, method))
  ipcMain.handle('github:fetchIssues', (_e, repo: GitHubRepo) => fetchIssues(repo))
  ipcMain.handle('github:createIssue', (_e, repo: GitHubRepo, title: string, body: string, labels: string[]) => createIssue(repo, title, body, labels))
}
