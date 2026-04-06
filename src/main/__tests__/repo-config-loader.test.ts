/**
 * Tests for src/main/repo-config-loader.ts
 *
 * No Electron dependency — repo-config-loader only uses fs/path/crypto/child_process.
 * Strategy: real temp directories (no mocking needed for most tests).
 * execSync('git remote get-url origin') fails in a plain tmpdir, falling back to basename.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  findColonyDir,
  loadRepoConfig,
  getRepoConfig,
  clearRepoConfigCache,
  getAllRepoConfigs,
} from '../repo-config-loader'

// ---- Helpers ----

let tmpDir: string

function mkdir(...parts: string[]): string {
  const p = path.join(tmpDir, ...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

function write(relPath: string, content: string): void {
  const p = path.join(tmpDir, relPath)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-rcl-test-'))
  clearRepoConfigCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  clearRepoConfigCache()
})

// ---- findColonyDir ----

describe('findColonyDir', () => {
  it('returns null when no .colony/ exists anywhere in the tree', () => {
    const deepDir = mkdir('a', 'b', 'c')
    expect(findColonyDir(deepDir)).toBeNull()
  })

  it('finds .colony/ in the given directory itself', () => {
    const repoRoot = mkdir('repo')
    mkdir('repo', '.colony')
    expect(findColonyDir(repoRoot)).toBe(repoRoot)
  })

  it('walks up to find .colony/ in a parent directory', () => {
    const repoRoot = mkdir('repo')
    mkdir('repo', '.colony')
    const deepDir = mkdir('repo', 'src', 'components')
    expect(findColonyDir(deepDir)).toBe(repoRoot)
  })

  it('stops at the first .colony/ found and does not continue walking up', () => {
    const parentRoot = mkdir('parent')
    mkdir('parent', '.colony')
    const childRoot = mkdir('parent', 'child')
    mkdir('parent', 'child', '.colony')
    const deepDir = mkdir('parent', 'child', 'src')
    // Should find child's .colony, not parent's
    expect(findColonyDir(deepDir)).toBe(childRoot)
  })

  it('ignores .colony if it is a file (not a directory)', () => {
    const repoRoot = mkdir('repo')
    // Write a file named .colony instead of a directory
    fs.writeFileSync(path.join(repoRoot, '.colony'), 'not a dir', 'utf-8')
    // Walk up should find nothing (parent has no .colony)
    expect(findColonyDir(repoRoot)).toBeNull()
  })
})

// ---- loadRepoConfig ----

describe('loadRepoConfig', () => {
  it('returns null when no .colony/ directory exists', () => {
    const repoRoot = mkdir('repo')
    expect(loadRepoConfig(repoRoot)).toBeNull()
  })

  it('returns config with repoSlug = basename when no git remote', () => {
    mkdir('my-project', '.colony')
    const repoRoot = path.join(tmpDir, 'my-project')
    const result = loadRepoConfig(repoRoot)
    // .colony exists but no config.yaml — still returns a result
    expect(result).not.toBeNull()
    expect(result!.repoSlug).toBe('my-project')
    expect(result!.repoPath).toBe(repoRoot)
  })

  it('loads config.yaml when present with name field', () => {
    write('repo/.colony/config.yaml', 'name: My Project\ndescription: Test repo\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result).not.toBeNull()
    expect(result!.config).not.toBeNull()
    expect(result!.config!.name).toBe('My Project')
  })

  it('returns config=null when config.yaml has no name field', () => {
    write('repo/.colony/config.yaml', 'description: No name here\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result).not.toBeNull()
    expect(result!.config).toBeNull()
  })

  it('skips config.yaml that is invalid YAML', () => {
    write('repo/.colony/config.yaml', ': invalid: {{ yaml')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result).not.toBeNull()
    expect(result!.config).toBeNull()
  })

  it('loads templates from templates/ subdirectory', () => {
    write('repo/.colony/templates/my-template.yaml',
      'name: My Template\ndescription: A test template\nprojectType: custom\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result).not.toBeNull()
    expect(result!.templates).toHaveLength(1)
    expect(result!.templates[0].name).toBe('My Template')
    expect(result!.templates[0].source).toContain('repo:')
  })

  it('skips template YAML files without name field', () => {
    write('repo/.colony/templates/bad.yaml', 'description: No name\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.templates).toHaveLength(0)
  })

  it('skips non-yaml files in templates/', () => {
    write('repo/.colony/templates/README.md', '# templates')
    write('repo/.colony/templates/good.yaml', 'name: Good\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.templates).toHaveLength(1)
  })

  it('assigns template id with repo: prefix and repoSlug', () => {
    write('repo/.colony/templates/env.yaml', 'name: Env Template\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.templates[0].id).toBe('repo:repo:Env Template')
  })

  it('loads pipelines from pipelines/ subdirectory', () => {
    write('repo/.colony/pipelines/ci.yaml', [
      'name: CI Pipeline',
      'trigger:',
      '  type: cron',
      '  cron: "0 9 * * 1-5"',
      'action:',
      '  type: session',
      '  prompt: Run CI',
    ].join('\n'))
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.pipelines).toHaveLength(1)
    expect(result!.pipelines[0].name).toBe('CI Pipeline')
    expect(result!.pipelines[0].fileName).toBe('ci.yaml')
    expect(result!.pipelines[0].source).toContain('repo:')
  })

  it('skips pipeline YAML without required name/trigger/action fields', () => {
    write('repo/.colony/pipelines/bad.yaml', 'name: Incomplete Pipeline\n')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.pipelines).toHaveLength(0)
  })

  it('loads prompts from prompts/ subdirectory', () => {
    write('repo/.colony/prompts/custom.yaml', [
      'prompts:',
      '  - id: p1',
      '    label: Run Tests',
      '    prompt: Please run all tests',
      '    scope: pr',
    ].join('\n'))
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.prompts).toHaveLength(1)
    expect(result!.prompts[0].id).toBe('p1')
    expect(result!.prompts[0].label).toBe('Run Tests')
    expect(result!.prompts[0].source).toContain('repo:')
  })

  it('defaults prompt scope to "pr" when not specified', () => {
    write('repo/.colony/prompts/no-scope.yaml', [
      'prompts:',
      '  - id: p2',
      '    label: Review',
      '    prompt: Please review',
    ].join('\n'))
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.prompts[0].scope).toBe('pr')
  })

  it('skips prompts missing required id/label/prompt fields', () => {
    write('repo/.colony/prompts/partial.yaml', [
      'prompts:',
      '  - id: p3',
      '    label: Missing prompt field',
    ].join('\n'))
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.prompts).toHaveLength(0)
  })

  it('loads context.md when present', () => {
    write('repo/.colony/context.md', '# Context\nThis is the project context.')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.context).toContain('This is the project context.')
  })

  it('sets context to null when context.md is absent', () => {
    mkdir('repo', '.colony')
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.context).toBeNull()
  })

  it('computes hashes for pipeline files', () => {
    write('repo/.colony/pipelines/ci.yaml', [
      'name: CI',
      'trigger:',
      '  type: cron',
      '  cron: "0 9 * * *"',
      'action:',
      '  type: session',
      '  prompt: Run CI',
    ].join('\n'))
    const repoRoot = path.join(tmpDir, 'repo')
    const result = loadRepoConfig(repoRoot)
    expect(result!.hashes.pipelines['ci.yaml']).toBeDefined()
    expect(result!.hashes.pipelines['ci.yaml']).toHaveLength(64) // sha256 hex
  })
})

// ---- getRepoConfig (caching) ----

describe('getRepoConfig', () => {
  it('returns null for a directory with no .colony/', () => {
    const repoRoot = mkdir('no-colony')
    expect(getRepoConfig(repoRoot)).toBeNull()
  })

  it('returns config for a directory with .colony/', () => {
    write('cached-repo/.colony/config.yaml', 'name: Cached\n')
    const repoRoot = path.join(tmpDir, 'cached-repo')
    const result = getRepoConfig(repoRoot)
    expect(result).not.toBeNull()
    expect(result!.config!.name).toBe('Cached')
  })

  it('returns the same object on second call (cache hit)', () => {
    write('cachetest/.colony/config.yaml', 'name: CacheTest\n')
    const repoRoot = path.join(tmpDir, 'cachetest')
    const first = getRepoConfig(repoRoot)
    const second = getRepoConfig(repoRoot)
    expect(first).toBe(second) // same object reference = cache hit
  })

  it('getAllRepoConfigs returns all cached configs', () => {
    write('repo-a/.colony/config.yaml', 'name: A\n')
    write('repo-b/.colony/config.yaml', 'name: B\n')
    const repoA = path.join(tmpDir, 'repo-a')
    const repoB = path.join(tmpDir, 'repo-b')
    getRepoConfig(repoA)
    getRepoConfig(repoB)
    const all = getAllRepoConfigs()
    const names = all.map(c => c.config?.name).sort()
    expect(names).toEqual(['A', 'B'])
  })

  it('clearRepoConfigCache removes a specific repo', () => {
    write('cached/.colony/config.yaml', 'name: Cacheable\n')
    const repoRoot = path.join(tmpDir, 'cached')
    const first = getRepoConfig(repoRoot)
    clearRepoConfigCache(repoRoot)
    const second = getRepoConfig(repoRoot)
    // After clearing, fresh load — still returns valid config but different object
    expect(first).not.toBe(second)
    expect(second!.config!.name).toBe('Cacheable')
  })
})
