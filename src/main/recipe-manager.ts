import { promises as fsp } from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { colonyPaths } from '../shared/colony-paths'
import type { RecipeEntry } from '../shared/types'

const SEEDED_MARKER = path.join(colonyPaths.recipes, '.seeded')

function parseRecipeFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const parts = content.split(/^---\s*$/m)
  if (parts.length < 3) {
    return { meta: {}, body: content }
  }
  const metaSection = parts[1]
  const body = parts.slice(2).join('---\n').trim()
  const meta: Record<string, unknown> = {}
  for (const line of metaSection.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/)
    if (!m) continue
    const key = m[1]
    const val = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

async function ensureRecipesDir(): Promise<void> {
  await fsp.mkdir(colonyPaths.recipes, { recursive: true })
}

async function seedRecipes(): Promise<void> {
  try {
    await fsp.access(SEEDED_MARKER)
    return
  } catch { /* not seeded yet */ }

  const seedDir = path.join(app.getAppPath(), 'resources', 'recipes')
  let seedFiles: string[]
  try {
    seedFiles = await fsp.readdir(seedDir)
  } catch {
    return
  }

  for (const file of seedFiles) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    const src = path.join(seedDir, file)
    const dst = path.join(colonyPaths.recipes, file)
    try {
      await fsp.access(dst)
    } catch {
      const content = await fsp.readFile(src, 'utf-8')
      await fsp.writeFile(dst, content, 'utf-8')
    }
  }

  await fsp.writeFile(SEEDED_MARKER, new Date().toISOString(), 'utf-8')
}

export async function initRecipes(): Promise<void> {
  await ensureRecipesDir()
  await seedRecipes()
}

export async function listRecipes(): Promise<RecipeEntry[]> {
  await ensureRecipesDir()
  let files: string[]
  try {
    files = await fsp.readdir(colonyPaths.recipes)
  } catch {
    return []
  }

  const entries: RecipeEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    const filePath = path.join(colonyPaths.recipes, file)
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const { meta } = parseRecipeFrontmatter(content)
      entries.push({
        name: String(meta.name ?? file.replace(/\.(yaml|yml)$/, '')),
        description: String(meta.description ?? ''),
        category: String(meta.category ?? 'other'),
        tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
        author: String(meta.author ?? 'user'),
        filePath,
      })
    } catch { /* skip unreadable files */ }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getRecipe(filePath: string): Promise<string | null> {
  if (!filePath.startsWith(colonyPaths.recipes)) return null
  try {
    return await fsp.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function getRecipeTemplate(filePath: string): Promise<string | null> {
  const content = await getRecipe(filePath)
  if (!content) return null
  const { body } = parseRecipeFrontmatter(content)
  return body || content
}

export async function saveRecipe(filePath: string, content: string): Promise<void> {
  if (!filePath.startsWith(colonyPaths.recipes)) throw new Error('Invalid recipe path')
  await fsp.writeFile(filePath, content, 'utf-8')
}

export async function deleteRecipe(filePath: string): Promise<void> {
  if (!filePath.startsWith(colonyPaths.recipes)) throw new Error('Invalid recipe path')
  await fsp.unlink(filePath)
}

export async function importRecipe(yamlContent: string): Promise<string> {
  await ensureRecipesDir()
  const { meta } = parseRecipeFrontmatter(yamlContent)
  const rawName = String(meta.name ?? 'recipe')
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'recipe'
  const filePath = path.join(colonyPaths.recipes, `${slug}.yaml`)
  await fsp.writeFile(filePath, yamlContent, 'utf-8')
  return filePath
}
