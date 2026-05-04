import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as nodePath from 'path'

const RECIPES_DIR = '/mock/.claude-colony/recipes'
const SEED_DIR = '/mock/app/resources/recipes'

type FsMock = {
  promises: {
    access: ReturnType<typeof vi.fn>
    mkdir: ReturnType<typeof vi.fn>
    readdir: ReturnType<typeof vi.fn>
    readFile: ReturnType<typeof vi.fn>
    writeFile: ReturnType<typeof vi.fn>
    unlink: ReturnType<typeof vi.fn>
  }
  _files: Record<string, string>
}

function buildFsMock(files: Record<string, string> = {}): FsMock {
  const store: Record<string, string> = { ...files }
  const accessSet = new Set(Object.keys(store))

  return {
    promises: {
      access: vi.fn().mockImplementation(async (p: string) => {
        if (!accessSet.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockImplementation(async (p: string) => {
        if (p !== RECIPES_DIR) return []
        return Object.keys(store)
          .filter(k => k.startsWith(RECIPES_DIR + '/'))
          .map(k => nodePath.basename(k))
      }),
      readFile: vi.fn().mockImplementation(async (p: string, _enc?: string) => {
        if (p in store) return store[p]
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }),
      writeFile: vi.fn().mockImplementation(async (p: string, data: string) => {
        store[p] = data
        accessSet.add(p)
      }),
      unlink: vi.fn().mockImplementation(async (p: string) => {
        delete store[p]
        accessSet.delete(p)
      }),
    },
    _files: store,
  }
}

async function loadModule(fsMock: FsMock, appPath = '/mock/app') {
  vi.resetModules()
  vi.doMock('fs', () => fsMock)
  vi.doMock('electron', () => ({
    app: { getAppPath: vi.fn().mockReturnValue(appPath) },
  }))
  vi.doMock('../../shared/colony-paths', () => ({
    colonyPaths: { recipes: RECIPES_DIR },
  }))
  return await import('../recipe-manager')
}

const RECIPE_YAML = `---
name: My Recipe
description: Does something useful
category: automation
tags: [ci, test]
author: colony-builtin
---
name: My Recipe
enabled: false
trigger:
  type: cron
  cron: "0 9 * * 1-5"
`

// ─── listRecipes ─────────────────────────────────────────────────────────────

describe('listRecipes', () => {
  beforeEach(() => vi.resetModules())

  it('returns empty array when directory has no yaml files', async () => {
    const fs = buildFsMock({ [`${RECIPES_DIR}/notes.txt`]: 'not yaml' })
    const mod = await loadModule(fs)
    expect(await mod.listRecipes()).toEqual([])
  })

  it('parses frontmatter fields correctly', async () => {
    const fs = buildFsMock({ [`${RECIPES_DIR}/my-recipe.yaml`]: RECIPE_YAML })
    const mod = await loadModule(fs)
    const entries = await mod.listRecipes()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'My Recipe',
      description: 'Does something useful',
      category: 'automation',
      tags: ['ci', 'test'],
      author: 'colony-builtin',
      filePath: `${RECIPES_DIR}/my-recipe.yaml`,
    })
  })

  it('uses defaults when frontmatter fields are missing', async () => {
    const minimal = `---\n---\nname: Foo\n`
    const fs = buildFsMock({ [`${RECIPES_DIR}/foo.yaml`]: minimal })
    const mod = await loadModule(fs)
    const [entry] = await mod.listRecipes()
    expect(entry.name).toBe('foo')        // falls back to filename
    expect(entry.description).toBe('')
    expect(entry.category).toBe('other')
    expect(entry.tags).toEqual([])
    expect(entry.author).toBe('user')
  })

  it('skips files that cannot be read', async () => {
    const fs = buildFsMock({ [`${RECIPES_DIR}/good.yaml`]: RECIPE_YAML })
    fs.promises.readFile.mockImplementationOnce(async () => { throw new Error('perm denied') })
    const mod = await loadModule(fs)
    expect(await mod.listRecipes()).toEqual([])
  })

  it('returns entries sorted by name', async () => {
    const makeYaml = (n: string) => `---\nname: ${n}\n---\n`
    const fs = buildFsMock({
      [`${RECIPES_DIR}/zebra.yaml`]: makeYaml('Zebra'),
      [`${RECIPES_DIR}/alpha.yaml`]: makeYaml('Alpha'),
      [`${RECIPES_DIR}/mango.yaml`]: makeYaml('Mango'),
    })
    const mod = await loadModule(fs)
    const names = (await mod.listRecipes()).map(e => e.name)
    expect(names).toEqual(['Alpha', 'Mango', 'Zebra'])
  })

  it('accepts .yml extension', async () => {
    const fs = buildFsMock({ [`${RECIPES_DIR}/recipe.yml`]: RECIPE_YAML })
    const mod = await loadModule(fs)
    expect(await mod.listRecipes()).toHaveLength(1)
  })
})

// ─── getRecipe ────────────────────────────────────────────────────────────────

describe('getRecipe', () => {
  beforeEach(() => vi.resetModules())

  it('returns file content for valid path', async () => {
    const fp = `${RECIPES_DIR}/my-recipe.yaml`
    const fs = buildFsMock({ [fp]: RECIPE_YAML })
    const mod = await loadModule(fs)
    expect(await mod.getRecipe(fp)).toBe(RECIPE_YAML)
  })

  it('returns null for path outside recipes dir (path traversal guard)', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    expect(await mod.getRecipe('/etc/passwd')).toBeNull()
    expect(await mod.getRecipe('/mock/.claude-colony/personas/colony-qa.md')).toBeNull()
  })

  it('returns null when file does not exist', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    expect(await mod.getRecipe(`${RECIPES_DIR}/missing.yaml`)).toBeNull()
  })
})

// ─── getRecipeTemplate ────────────────────────────────────────────────────────

describe('getRecipeTemplate', () => {
  beforeEach(() => vi.resetModules())

  it('strips frontmatter and returns body', async () => {
    const fp = `${RECIPES_DIR}/my-recipe.yaml`
    const fs = buildFsMock({ [fp]: RECIPE_YAML })
    const mod = await loadModule(fs)
    const body = await mod.getRecipeTemplate(fp)
    expect(body).not.toContain('---')
    expect(body).toContain('type: cron')
  })

  it('returns full content when no frontmatter present', async () => {
    const plain = 'name: plain\ntrigger:\n  type: cron\n'
    const fp = `${RECIPES_DIR}/plain.yaml`
    const fs = buildFsMock({ [fp]: plain })
    const mod = await loadModule(fs)
    expect(await mod.getRecipeTemplate(fp)).toBe(plain)
  })

  it('returns null when path is invalid', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    expect(await mod.getRecipeTemplate('/outside/path.yaml')).toBeNull()
  })
})

// ─── saveRecipe ───────────────────────────────────────────────────────────────

describe('saveRecipe', () => {
  beforeEach(() => vi.resetModules())

  it('writes file for valid path', async () => {
    const fp = `${RECIPES_DIR}/new.yaml`
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    await mod.saveRecipe(fp, RECIPE_YAML)
    expect(fs.promises.writeFile).toHaveBeenCalledWith(fp, RECIPE_YAML, 'utf-8')
  })

  it('throws for path outside recipes dir', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    await expect(mod.saveRecipe('/etc/cron.d/malicious.yaml', 'bad')).rejects.toThrow('Invalid recipe path')
  })
})

// ─── deleteRecipe ─────────────────────────────────────────────────────────────

describe('deleteRecipe', () => {
  beforeEach(() => vi.resetModules())

  it('unlinks file for valid path', async () => {
    const fp = `${RECIPES_DIR}/old.yaml`
    const fs = buildFsMock({ [fp]: RECIPE_YAML })
    const mod = await loadModule(fs)
    await mod.deleteRecipe(fp)
    expect(fs.promises.unlink).toHaveBeenCalledWith(fp)
  })

  it('throws for path outside recipes dir', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    await expect(mod.deleteRecipe('/tmp/malicious.yaml')).rejects.toThrow('Invalid recipe path')
  })
})

// ─── importRecipe ─────────────────────────────────────────────────────────────

describe('importRecipe', () => {
  beforeEach(() => vi.resetModules())

  it('slugifies name from frontmatter and writes file', async () => {
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    const result = await mod.importRecipe(RECIPE_YAML)
    expect(result).toBe(`${RECIPES_DIR}/my-recipe.yaml`)
    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      `${RECIPES_DIR}/my-recipe.yaml`,
      RECIPE_YAML,
      'utf-8'
    )
  })

  it('falls back to "recipe" slug when name is missing', async () => {
    const noName = `---\ndescription: No name here\n---\nenabled: false\n`
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    const result = await mod.importRecipe(noName)
    expect(result).toBe(`${RECIPES_DIR}/recipe.yaml`)
  })

  it('converts spaces and special chars in name to dashes', async () => {
    const spacey = `---\nname: My Cool Recipe!!!\n---\nenabled: false\n`
    const fs = buildFsMock({})
    const mod = await loadModule(fs)
    const result = await mod.importRecipe(spacey)
    expect(result).toBe(`${RECIPES_DIR}/my-cool-recipe.yaml`)
  })
})

// ─── seedRecipes / initRecipes ────────────────────────────────────────────────

describe('seedRecipes', () => {
  beforeEach(() => vi.resetModules())

  it('skips seeding when .seeded marker exists', async () => {
    const markerPath = `${RECIPES_DIR}/.seeded`
    const fs = buildFsMock({ [markerPath]: '2026-01-01T00:00:00.000Z' })
    const mod = await loadModule(fs)
    await mod.initRecipes()
    // writeFile only called for mkdir side-effects, not for seeding
    const writeCalls = fs.promises.writeFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(writeCalls).not.toContain(markerPath)
    expect(fs.promises.readdir).not.toHaveBeenCalledWith(SEED_DIR)
  })

  it('copies seed files to recipes dir and writes .seeded marker', async () => {
    const seedYaml = `---\nname: Seed One\n---\nenabled: false\n`
    const fsMock: FsMock = buildFsMock({})
    // seed dir has one file
    fsMock.promises.readdir = vi.fn().mockImplementation(async (p: string) => {
      if (p === SEED_DIR) return ['seed-one.yaml']
      return []
    })
    fsMock.promises.readFile = vi.fn().mockImplementation(async (p: string) => {
      if (p === `${SEED_DIR}/seed-one.yaml`) return seedYaml
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const mod = await loadModule(fsMock)
    await mod.initRecipes()

    const writeCalls = fsMock.promises.writeFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(writeCalls).toContain(`${RECIPES_DIR}/seed-one.yaml`)
    expect(writeCalls).toContain(`${RECIPES_DIR}/.seeded`)
  })

  it('does not overwrite existing recipe files during seed', async () => {
    const existingContent = 'existing content'
    const fsMock: FsMock = buildFsMock({
      [`${RECIPES_DIR}/seed-one.yaml`]: existingContent,
    })
    fsMock.promises.readdir = vi.fn().mockImplementation(async (p: string) => {
      if (p === SEED_DIR) return ['seed-one.yaml']
      return []
    })
    fsMock.promises.readFile = vi.fn().mockImplementation(async (p: string) => {
      if (p.startsWith(RECIPES_DIR)) return existingContent
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const mod = await loadModule(fsMock)
    await mod.initRecipes()

    const writeCalls = fsMock.promises.writeFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(writeCalls).not.toContain(`${RECIPES_DIR}/seed-one.yaml`)
  })

  it('gracefully handles missing seed directory', async () => {
    const fsMock: FsMock = buildFsMock({})
    fsMock.promises.readdir = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    )
    const mod = await loadModule(fsMock)
    await expect(mod.initRecipes()).resolves.toBeUndefined()
  })
})
