import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import { colonyPaths } from '../../shared/colony-paths'
import type { SessionTemplate } from '../../shared/types'
import { createInstance } from '../instance-manager'
import { sendPromptWhenReady } from '../send-prompt-when-ready'

function readTemplates(): SessionTemplate[] {
  try {
    if (!fs.existsSync(colonyPaths.sessionTemplates)) return []
    const raw = fs.readFileSync(colonyPaths.sessionTemplates, 'utf-8')
    return JSON.parse(raw) as SessionTemplate[]
  } catch {
    return []
  }
}

function writeTemplates(templates: SessionTemplate[]): void {
  fs.writeFileSync(colonyPaths.sessionTemplates, JSON.stringify(templates, null, 2), 'utf-8')
}

export function registerSessionTemplateHandlers(): void {
  ipcMain.handle('sessionTemplates:list', (): SessionTemplate[] => {
    return readTemplates()
  })

  ipcMain.handle('sessionTemplates:save', (_e, template: SessionTemplate): boolean => {
    const templates = readTemplates()
    const idx = templates.findIndex((t) => t.id === template.id)
    if (idx >= 0) {
      templates[idx] = template
    } else {
      templates.push(template)
    }
    writeTemplates(templates)
    return true
  })

  ipcMain.handle('sessionTemplates:delete', (_e, id: string): boolean => {
    const templates = readTemplates()
    const filtered = templates.filter((t) => t.id !== id)
    writeTemplates(filtered)
    return true
  })

  ipcMain.handle('sessionTemplates:launch', async (_e, id: string) => {
    const templates = readTemplates()
    const template = templates.find((t) => t.id === id)
    if (!template) return null

    const workingDir = template.workingDir
      ? template.workingDir.replace(/^~/, os.homedir())
      : undefined

    const args: string[] = []
    if (template.model) {
      args.push('--model', template.model)
    }

    const inst = await createInstance({
      name: template.name,
      workingDirectory: workingDir,
      args: args.length > 0 ? args : undefined,
    })

    // Set role if present
    if (template.role && inst) {
      // Role is set via daemon — fire-and-forget via IPC after instance creation
      // We do this after returning so we don't block; use a short delay to allow
      // the instance to be registered before the renderer tries to set the role.
      setTimeout(() => {
        ipcMain.emit('instance:set-role-internal', inst.id, template.role)
      }, 500)
    }

    // Send initial prompt if present
    if (template.initialPrompt && inst) {
      sendPromptWhenReady(inst.id, { prompt: template.initialPrompt }).catch(() => {})
    }

    // Update lastUsed and launchCount
    const idx = templates.findIndex((t) => t.id === id)
    if (idx >= 0) {
      templates[idx] = {
        ...templates[idx],
        lastUsed: Date.now(),
        launchCount: (templates[idx].launchCount ?? 0) + 1,
      }
      writeTemplates(templates)
    }

    return inst
  })
}
