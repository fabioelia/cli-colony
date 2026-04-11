import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import * as os from 'os'
import { colonyPaths } from '../../shared/colony-paths'
import type { SessionTemplate } from '../../shared/types'
import { createInstance } from '../instance-manager'
import { getDaemonClient } from '../daemon-client'
import { sendPromptWhenReady } from '../send-prompt-when-ready'

async function readTemplates(): Promise<SessionTemplate[]> {
  try {
    const raw = await fsp.readFile(colonyPaths.sessionTemplates, 'utf-8')
    return JSON.parse(raw) as SessionTemplate[]
  } catch {
    return []
  }
}

async function writeTemplates(templates: SessionTemplate[]): Promise<void> {
  await fsp.writeFile(colonyPaths.sessionTemplates, JSON.stringify(templates, null, 2), 'utf-8')
}

export function registerSessionTemplateHandlers(): void {
  ipcMain.handle('sessionTemplates:list', () => readTemplates())

  ipcMain.handle('sessionTemplates:save', async (_e, template: SessionTemplate) => {
    const templates = await readTemplates()
    const idx = templates.findIndex((t) => t.id === template.id)
    if (idx >= 0) {
      templates[idx] = template
    } else {
      templates.push(template)
    }
    await writeTemplates(templates)
    return true
  })

  ipcMain.handle('sessionTemplates:delete', async (_e, id: string) => {
    const templates = await readTemplates()
    const filtered = templates.filter((t) => t.id !== id)
    await writeTemplates(filtered)
    return true
  })

  ipcMain.handle('sessionTemplates:launch', async (_e, id: string) => {
    const templates = await readTemplates()
    const template = templates.find((t) => t.id === id)
    if (!template) return null

    const workingDir = template.workingDir
      ? template.workingDir.replace(/^~/, os.homedir())
      : undefined

    const args: string[] = []
    if (template.model) {
      args.push('--model', template.model)
    }
    if (template.permissionMode) {
      args.push('--permission-mode', template.permissionMode)
    }

    const inst = await createInstance({
      name: template.name,
      workingDirectory: workingDir,
      args: args.length > 0 ? args : undefined,
    })

    // Set role if present
    if (template.role && inst) {
      getDaemonClient().setInstanceRole(inst.id, template.role!).catch(() => {})
    }

    // Send initial prompt if present
    if (template.initialPrompt && inst) {
      sendPromptWhenReady(inst.id, {
        prompt: template.initialPrompt,
        planFirst: template.planFirst,
      }).catch(() => {})
    }

    // Update lastUsed and launchCount
    const idx = templates.findIndex((t) => t.id === id)
    if (idx >= 0) {
      templates[idx] = {
        ...templates[idx],
        lastUsed: Date.now(),
        launchCount: (templates[idx].launchCount ?? 0) + 1,
      }
      await writeTemplates(templates)
    }

    return inst
  })
}
