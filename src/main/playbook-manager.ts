import { promises as fsp } from 'fs'
import * as fs from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { parseYaml } from '../shared/yaml-parser'
import type { PlaybookDef, PlaybookInput } from '../shared/types'

const PLAYBOOKS_DIR = colonyPaths.playbooks

let _playbooks: PlaybookDef[] = []
let _watcher: fs.FSWatcher | null = null

function parsePlaybook(content: string, fileName: string): PlaybookDef | null {
  try {
    const raw = parseYaml(content) as Record<string, unknown>
    if (!raw || typeof raw.name !== 'string') {
      console.warn(`[playbooks] ${fileName}: missing required "name" field — skipping`)
      return null
    }
    return {
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      agent: typeof raw.agent === 'string' ? raw.agent : undefined,
      prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
      workingDirectory: typeof raw.workingDirectory === 'string' || typeof raw.working_directory === 'string'
        ? String(raw.workingDirectory ?? raw.working_directory)
        : undefined,
      permissionMode: ['autonomous', 'supervised', 'auto'].includes(raw.permissionMode as string)
        ? raw.permissionMode as PlaybookDef['permissionMode']
        : undefined,
      tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter(t => typeof t === 'string') as string[] : undefined,
      env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
        ? raw.env as Record<string, string>
        : undefined,
      inputs: Array.isArray(raw.inputs)
        ? (raw.inputs as unknown[]).flatMap((inp): PlaybookInput[] => {
            if (!inp || typeof inp !== 'object') return []
            const i = inp as Record<string, unknown>
            const type = ['string', 'select', 'boolean'].includes(i.type as string) ? i.type as PlaybookInput['type'] : 'string'
            return [{
              name: typeof i.name === 'string' ? i.name : '',
              label: typeof i.label === 'string' ? i.label : undefined,
              type,
              default: typeof i.default === 'string' ? i.default : typeof i.default === 'boolean' ? String(i.default) : undefined,
              required: i.required === true,
              options: Array.isArray(i.options) ? (i.options as unknown[]).filter(o => typeof o === 'string') as string[] : undefined,
              placeholder: typeof i.placeholder === 'string' ? i.placeholder : undefined,
            }].filter(inp2 => inp2.name)
          })
        : undefined,
    }
  } catch (e) {
    console.warn(`[playbooks] Failed to parse ${fileName}:`, e)
    return null
  }
}

export async function loadPlaybooks(): Promise<void> {
  try {
    await fsp.mkdir(PLAYBOOKS_DIR, { recursive: true })
    const files = await fsp.readdir(PLAYBOOKS_DIR)
    const yamlFiles = files.filter(f => /\.(yaml|yml)$/i.test(f))
    const results: PlaybookDef[] = []
    for (const file of yamlFiles) {
      const content = await fsp.readFile(join(PLAYBOOKS_DIR, file), 'utf-8')
      const pb = parsePlaybook(content, file)
      if (pb) results.push(pb)
    }
    _playbooks = results
  } catch (e) {
    console.error('[playbooks] loadPlaybooks error:', e)
  }
}

export function getPlaybooks(): PlaybookDef[] {
  return _playbooks
}

export function getPlaybook(name: string): PlaybookDef | null {
  return _playbooks.find(p => p.name === name) ?? null
}

export async function watchPlaybooks(): Promise<void> {
  await loadPlaybooks()
  if (_watcher) { _watcher.close(); _watcher = null }
  try {
    await fsp.mkdir(PLAYBOOKS_DIR, { recursive: true })
    _watcher = fs.watch(PLAYBOOKS_DIR, { persistent: false }, () => {
      loadPlaybooks().catch(e => console.error('[playbooks] reload error:', e))
    })
  } catch (e) {
    console.error('[playbooks] watchPlaybooks error:', e)
  }
}
