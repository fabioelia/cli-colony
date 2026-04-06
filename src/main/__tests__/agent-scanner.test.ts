/**
 * Tests for src/main/agent-scanner.ts
 *
 * Tests scanAgents (personal + project agent discovery, dedup logic)
 * and createAgent (slug generation, dir creation, duplicate guard, template).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

const MOCK_HOME = '/mock/home'
const PERSONAL_AGENTS_DIR = '/mock/home/.claude/agents'
const PROJECTS_DIR = '/mock/home/projects'

// Per-test control of mock file system state
let mockExistsSyncMap: Record<string, boolean> = {}
let mockReaddirMap: Record<string, string[]> = {}
let mockReadFileMap: Record<string, string> = {}
let mockProjectDirs: string[] = []

const mockFs = {
  existsSync: vi.fn((p: string) => mockExistsSyncMap[p] ?? false),
  readdirSync: vi.fn((dir: string, opts?: any) => {
    if (opts?.withFileTypes) {
      return mockProjectDirs.map((name) => ({ name, isDirectory: () => true }))
    }
    return mockReaddirMap[dir] || []
  }),
  readFileSync: vi.fn((p: string) => {
    if (mockReadFileMap[p] !== undefined) return mockReadFileMap[p]
    throw new Error(`ENOENT: ${p}`)
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}

// Helper to build a minimal agent markdown file
function agentMd(name: string, opts: { description?: string; tools?: string; model?: string } = {}): string {
  const lines = ['---', `name: ${name}`]
  if (opts.description) lines.push(`description: ${opts.description}`)
  if (opts.tools) lines.push(`tools: ${opts.tools}`)
  if (opts.model) lines.push(`model: ${opts.model}`)
  lines.push('---', '', '## Role', '', 'Agent role here.')
  return lines.join('\n')
}

describe('agent-scanner', () => {
  let mod: typeof import('../agent-scanner')

  beforeEach(async () => {
    vi.resetModules()

    // Reset state
    mockExistsSyncMap = {}
    mockReaddirMap = {}
    mockReadFileMap = {}
    mockProjectDirs = []

    mockFs.existsSync.mockClear()
    mockFs.readdirSync.mockClear()
    mockFs.readFileSync.mockClear()
    mockFs.writeFileSync.mockClear()
    mockFs.mkdirSync.mockClear()

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue(MOCK_HOME) },
    }))

    vi.doMock('fs', () => mockFs)

    mod = await import('../agent-scanner')
  })

  // ---------------------------------------------------------------------------
  // scanAgents — personal agents
  // ---------------------------------------------------------------------------

  describe('scanAgents — personal agents', () => {
    it('returns empty array when personal agents dir does not exist', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = false
      mockExistsSyncMap[PROJECTS_DIR] = false
      const agents = mod.scanAgents()
      expect(agents).toEqual([])
    })

    it('returns empty array when personal agents dir is empty', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = []
      mockExistsSyncMap[PROJECTS_DIR] = false
      const agents = mod.scanAgents()
      expect(agents).toEqual([])
    })

    it('parses a single personal agent file correctly', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = ['my-agent.md']
      const filePath = join(PERSONAL_AGENTS_DIR, 'my-agent.md')
      mockReadFileMap[filePath] = agentMd('My Agent', { description: 'Does things', model: 'sonnet' })
      mockExistsSyncMap[PROJECTS_DIR] = false

      const agents = mod.scanAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('My Agent')
      expect(agents[0].description).toBe('Does things')
      expect(agents[0].model).toBe('sonnet')
      expect(agents[0].scope).toBe('personal')
      expect(agents[0].id).toBe('personal:personal:My Agent')
    })

    it('splits tools field on commas and trims whitespace', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = ['tool-agent.md']
      const filePath = join(PERSONAL_AGENTS_DIR, 'tool-agent.md')
      mockReadFileMap[filePath] = agentMd('Tool Agent', { tools: 'Read, Edit, Bash' })
      mockExistsSyncMap[PROJECTS_DIR] = false

      const agents = mod.scanAgents()
      expect(agents[0].tools).toEqual(['Read', 'Edit', 'Bash'])
    })

    it('produces empty tools array when tools field is absent', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = ['no-tools.md']
      const filePath = join(PERSONAL_AGENTS_DIR, 'no-tools.md')
      mockReadFileMap[filePath] = agentMd('No Tools Agent')
      mockExistsSyncMap[PROJECTS_DIR] = false

      const agents = mod.scanAgents()
      expect(agents[0].tools).toEqual([])
    })

    it('skips agent files that have no name in frontmatter', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = ['no-name.md', 'named.md']
      mockReadFileMap[join(PERSONAL_AGENTS_DIR, 'no-name.md')] = '---\ndescription: Has no name\n---\n'
      mockReadFileMap[join(PERSONAL_AGENTS_DIR, 'named.md')] = agentMd('Named Agent')
      mockExistsSyncMap[PROJECTS_DIR] = false

      const agents = mod.scanAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Named Agent')
    })

    it('skips non-.md files in the agents directory', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = true
      mockReaddirMap[PERSONAL_AGENTS_DIR] = ['agent.md', 'README.txt', '.DS_Store']
      mockReadFileMap[join(PERSONAL_AGENTS_DIR, 'agent.md')] = agentMd('My Agent')
      mockExistsSyncMap[PROJECTS_DIR] = false

      const agents = mod.scanAgents()
      expect(agents).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // scanAgents — project agents via projectPaths
  // ---------------------------------------------------------------------------

  describe('scanAgents — project agents via projectPaths', () => {
    it('scans agents from explicit projectPaths', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = false
      mockExistsSyncMap[PROJECTS_DIR] = false

      const projAgentsDir = '/my-project/.claude/agents'
      mockExistsSyncMap[projAgentsDir] = true
      mockReaddirMap[projAgentsDir] = ['coder.md']
      mockReadFileMap[join(projAgentsDir, 'coder.md')] = agentMd('Coder Agent', { description: 'Writes code' })

      const agents = mod.scanAgents(['/my-project'])
      expect(agents).toHaveLength(1)
      expect(agents[0].scope).toBe('project')
      expect(agents[0].projectName).toBe('my-project')
      expect(agents[0].id).toBe('project:my-project:Coder Agent')
    })
  })

  // ---------------------------------------------------------------------------
  // scanAgents — auto-scan ~/projects/* dedup
  // ---------------------------------------------------------------------------

  describe('scanAgents — auto-scan and dedup', () => {
    it('does not add duplicate project when already in projectPaths', () => {
      const projPath = `${PROJECTS_DIR}/newton`
      const projAgentsDir = `${projPath}/.claude/agents`

      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = false
      mockExistsSyncMap[PROJECTS_DIR] = true
      mockProjectDirs = ['newton']

      // Both explicit projectPaths and auto-scan point to same project
      mockExistsSyncMap[projAgentsDir] = true
      mockReaddirMap[projAgentsDir] = ['backend.md']
      mockReadFileMap[join(projAgentsDir, 'backend.md')] = agentMd('Backend Agent')

      // explicit path also provided
      const agents = mod.scanAgents([projPath])
      // Should only appear once even though auto-scan would find it too
      const backendAgents = agents.filter((a) => a.name === 'Backend Agent')
      expect(backendAgents).toHaveLength(1)
    })

    it('adds agents from ~/projects/* that are not in explicit projectPaths', () => {
      mockExistsSyncMap[PERSONAL_AGENTS_DIR] = false
      mockExistsSyncMap[PROJECTS_DIR] = true
      mockProjectDirs = ['my-app']

      const autoAgentsDir = `${PROJECTS_DIR}/my-app/.claude/agents`
      mockExistsSyncMap[autoAgentsDir] = true
      mockReaddirMap[autoAgentsDir] = ['helper.md']
      mockReadFileMap[join(autoAgentsDir, 'helper.md')] = agentMd('Helper Agent')

      const agents = mod.scanAgents()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Helper Agent')
      expect(agents[0].projectName).toBe('my-app')
    })
  })

  // ---------------------------------------------------------------------------
  // createAgent
  // ---------------------------------------------------------------------------

  describe('createAgent', () => {
    it('returns null when scope=project and no projectPath provided', () => {
      const result = mod.createAgent('My Agent', 'project')
      expect(result).toBeNull()
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('generates correct slug for a simple name', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'my-agent.md')] = false

      mod.createAgent('My Agent', 'personal')

      const [filePath, content] = mockFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(filePath).toBe(join(dir, 'my-agent.md'))
      expect(content).toContain('name: My Agent')
    })

    it('strips leading and trailing hyphens from slug', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'code-review.md')] = false

      mod.createAgent('--- Code Review ---', 'personal')

      const [filePath] = mockFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(filePath).toContain('code-review.md')
    })

    it('converts special chars to hyphens in slug', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'pr-reviewer.md')] = false

      mod.createAgent('PR Reviewer!', 'personal')

      const [filePath] = mockFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(filePath).toContain('pr-reviewer.md')
    })

    it('returns null when file already exists (duplicate guard)', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'existing.md')] = true

      const result = mod.createAgent('existing', 'personal')
      expect(result).toBeNull()
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('creates the agents directory when it does not exist', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = false
      mockExistsSyncMap[join(dir, 'new-agent.md')] = false

      mod.createAgent('New Agent', 'personal')

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true })
    })

    it('substitutes {{name}} placeholder in template content', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'fancy-agent.md')] = false

      mod.createAgent('Fancy Agent', 'personal')

      const [, content] = mockFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(content).toContain('name: Fancy Agent')
      expect(content).not.toContain('{{name}}')
    })

    it('returns AgentDef with correct fields for a personal agent', () => {
      const dir = join(MOCK_HOME, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'test-agent.md')] = false

      const result = mod.createAgent('Test Agent', 'personal')

      expect(result).not.toBeNull()
      expect(result!.name).toBe('Test Agent')
      expect(result!.scope).toBe('personal')
      expect(result!.id).toBe('personal:personal:Test Agent')
      expect(result!.model).toBe('sonnet')
      expect(result!.tools).toEqual(['Read', 'Edit', 'Bash', 'Glob', 'Grep'])
    })

    it('returns AgentDef with correct fields for a project agent', () => {
      const projPath = '/my-project'
      const dir = join(projPath, '.claude', 'agents')
      mockExistsSyncMap[dir] = true
      mockExistsSyncMap[join(dir, 'proj-agent.md')] = false

      const result = mod.createAgent('Proj Agent', 'project', projPath)

      expect(result).not.toBeNull()
      expect(result!.scope).toBe('project')
      expect(result!.projectName).toBe('my-project')
      expect(result!.filePath).toBe(join(dir, 'proj-agent.md'))
    })
  })
})
