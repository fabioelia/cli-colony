import { promises as fsp } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'

export interface PersonaTemplate {
  id: string
  name: string
  description: string
  builtIn: boolean
}

const VERIFIER_FRONTMATTER = `---
name: "Colony Verifier"
schedule: null
model: "claude-sonnet-4-6"
max_sessions: 1
can_push: false
can_merge: false
enabled: false
on_complete_run: []
---`

const VERIFIER_BODY = `You are a test verifier. Run the full test suite in your working directory. Report:
1. Total tests run
2. Tests passing
3. Tests failing with details
4. Any new failures compared to the main branch

If any tests fail, write results to ~/.claude-colony/outputs/verifier/{timestamp}.md.
Keep it factual — no fixes, just report.`

const BUILT_IN_TEMPLATES: PersonaTemplate[] = [
  {
    id: 'verifier',
    name: 'Colony Verifier',
    description: 'Runs the test suite after implementation sessions and reports failures.',
    builtIn: true,
  },
]

function buildVerifierContent(): string {
  return `${VERIFIER_FRONTMATTER}\n\n${VERIFIER_BODY}\n`
}

export async function getBuiltInTemplates(): Promise<PersonaTemplate[]> {
  return BUILT_IN_TEMPLATES
}

export async function getUserTemplates(): Promise<PersonaTemplate[]> {
  const dir = colonyPaths.personaTemplates
  try {
    const files = await fsp.readdir(dir)
    const templates: PersonaTemplate[] = []
    for (const f of files) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
      try {
        const content = await fsp.readFile(join(dir, f), 'utf-8')
        // Minimal parse: look for name: and description: lines
        const nameMatch = content.match(/^name:\s*["']?(.+?)["']?\s*$/m)
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)
        const id = f.replace(/\.ya?ml$/, '')
        templates.push({
          id,
          name: nameMatch?.[1] || id,
          description: descMatch?.[1] || '',
          builtIn: false,
        })
      } catch { /* skip malformed */ }
    }
    return templates
  } catch {
    return []
  }
}

export async function getAllTemplates(): Promise<PersonaTemplate[]> {
  const [builtIn, user] = await Promise.all([getBuiltInTemplates(), getUserTemplates()])
  return [...builtIn, ...user]
}

export async function createPersonaFromTemplate(templateId: string): Promise<{ fileName: string } | null> {
  const personasDir = colonyPaths.personas
  await fsp.mkdir(personasDir, { recursive: true })

  if (templateId === 'verifier') {
    const fileName = 'colony-verifier.md'
    const dest = join(personasDir, fileName)
    await fsp.writeFile(dest, buildVerifierContent(), 'utf-8')
    return { fileName }
  }

  // User template: read YAML and convert to .md persona
  const dir = colonyPaths.personaTemplates
  const srcPath = join(dir, `${templateId}.yaml`)
  let src: string
  try {
    src = await fsp.readFile(srcPath, 'utf-8')
  } catch {
    try {
      src = await fsp.readFile(join(dir, `${templateId}.yml`), 'utf-8')
    } catch {
      return null
    }
  }

  // User templates must have a prompt: field and frontmatter fields
  const promptMatch = src.match(/^prompt:\s*\|?\s*\n([\s\S]+?)(?=^[a-z]|\Z)/m)
  if (!promptMatch) return null

  const nameMatch = src.match(/^name:\s*["']?(.+?)["']?\s*$/m)
  const name = nameMatch?.[1] || templateId

  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const fileName = `${safeName}.md`
  const dest = join(personasDir, fileName)

  const frontmatter = `---\nname: "${name}"\nschedule: null\nmodel: "claude-sonnet-4-6"\nmax_sessions: 1\nenabled: false\non_complete_run: []\n---`
  const content = `${frontmatter}\n\n${promptMatch[1].trimEnd()}\n`
  await fsp.writeFile(dest, content, 'utf-8')
  return { fileName }
}
