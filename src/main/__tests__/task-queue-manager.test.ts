/**
 * Tests for src/main/task-queue-manager.ts
 *
 * Uses real fs with temp directories. Mocks electron (used only by listOutputRuns
 * for tilde expansion) and colony-paths to point at the temp directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tmpDir: string
let mockQueueDir: string
let mockTaskWorkspace: string

describe('task-queue-manager', () => {
  let mod: typeof import('../task-queue-manager')

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tqm-test-'))
    mockQueueDir = path.join(tmpDir, 'task-queues')
    mockTaskWorkspace = path.join(tmpDir, 'task-workspace')
    fs.mkdirSync(mockQueueDir, { recursive: true })
    fs.mkdirSync(mockTaskWorkspace, { recursive: true })

    vi.resetModules()

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue(tmpDir) },
    }))

    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: {
        taskWorkspace: mockTaskWorkspace,
        taskQueues: mockQueueDir,
      },
    }))

    mod = await import('../task-queue-manager')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ---- listQueues ----

  describe('listQueues()', () => {
    it('returns empty array when queue dir is empty', () => {
      expect(mod.listQueues()).toEqual([])
    })

    it('returns .yaml files', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'my-queue.yaml'), 'name: My Queue', 'utf-8')
      const queues = mod.listQueues()
      expect(queues).toHaveLength(1)
      expect(queues[0].name).toBe('my-queue.yaml')
    })

    it('returns .yml files', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'another.yml'), 'name: Another', 'utf-8')
      const queues = mod.listQueues()
      expect(queues).toHaveLength(1)
      expect(queues[0].name).toBe('another.yml')
    })

    it('excludes .memory.md files', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'queue.yaml'), 'name: Queue', 'utf-8')
      fs.writeFileSync(path.join(mockQueueDir, 'queue.memory.md'), '# Memory', 'utf-8')
      const queues = mod.listQueues()
      expect(queues).toHaveLength(1)
      expect(queues[0].name).toBe('queue.yaml')
    })

    it('excludes non-yaml files', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'notes.txt'), 'text', 'utf-8')
      fs.writeFileSync(path.join(mockQueueDir, 'data.json'), '{}', 'utf-8')
      expect(mod.listQueues()).toEqual([])
    })

    it('returns content of each queue file', () => {
      const content = 'name: My Queue\ntasks: []'
      fs.writeFileSync(path.join(mockQueueDir, 'test.yaml'), content, 'utf-8')
      const queues = mod.listQueues()
      expect(queues[0].content).toBe(content)
    })

    it('returns correct path for each queue', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'test.yaml'), '', 'utf-8')
      const queues = mod.listQueues()
      expect(queues[0].path).toBe(path.join(mockQueueDir, 'test.yaml'))
    })
  })

  // ---- saveQueue / deleteQueue ----

  describe('saveQueue() / deleteQueue()', () => {
    it('saveQueue writes content to queue dir', () => {
      const filePath = mod.saveQueue('my-queue.yaml', 'name: Test')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('name: Test')
    })

    it('deleteQueue returns true and removes existing file', () => {
      fs.writeFileSync(path.join(mockQueueDir, 'to-delete.yaml'), '', 'utf-8')
      const result = mod.deleteQueue('to-delete.yaml')
      expect(result).toBe(true)
      expect(fs.existsSync(path.join(mockQueueDir, 'to-delete.yaml'))).toBe(false)
    })

    it('deleteQueue returns false when file does not exist', () => {
      expect(mod.deleteQueue('nonexistent.yaml')).toBe(false)
    })
  })

  // ---- getQueueMemory / saveQueueMemory ----

  describe('getQueueMemory() / saveQueueMemory()', () => {
    it('getQueueMemory returns empty string when memory file does not exist', () => {
      expect(mod.getQueueMemory('my-queue.yaml')).toBe('')
    })

    it('getQueueMemory returns content of existing memory file', () => {
      const memPath = path.join(mockQueueDir, 'my-queue.memory.md')
      fs.writeFileSync(memPath, '# Queue Memory', 'utf-8')
      expect(mod.getQueueMemory('my-queue.yaml')).toBe('# Queue Memory')
    })

    it('getQueueMemory strips .yaml extension when building memory path', () => {
      const memPath = path.join(mockQueueDir, 'sprint.memory.md')
      fs.writeFileSync(memPath, 'sprint memory', 'utf-8')
      expect(mod.getQueueMemory('sprint.yaml')).toBe('sprint memory')
    })

    it('getQueueMemory strips .yml extension when building memory path', () => {
      const memPath = path.join(mockQueueDir, 'sprint.memory.md')
      fs.writeFileSync(memPath, 'sprint memory yml', 'utf-8')
      expect(mod.getQueueMemory('sprint.yml')).toBe('sprint memory yml')
    })

    it('saveQueueMemory writes content to correct memory path', () => {
      mod.saveQueueMemory('my-queue.yaml', '# New Memory')
      const memPath = path.join(mockQueueDir, 'my-queue.memory.md')
      expect(fs.readFileSync(memPath, 'utf-8')).toBe('# New Memory')
    })

    it('saveQueueMemory returns true on success', () => {
      expect(mod.saveQueueMemory('q.yaml', 'content')).toBe(true)
    })

    it('round-trips memory content', () => {
      const content = '## Notes\nRemember to check XYZ.'
      mod.saveQueueMemory('flow.yaml', content)
      expect(mod.getQueueMemory('flow.yaml')).toBe(content)
    })
  })

  // ---- listOutputRuns ----

  describe('listOutputRuns()', () => {
    it('returns empty array when directory does not exist', () => {
      expect(mod.listOutputRuns(path.join(tmpDir, 'nonexistent'))).toEqual([])
    })

    it('returns empty array for empty directory', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      expect(mod.listOutputRuns(outDir)).toEqual([])
    })

    it('groups subdirectories as named runs', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      const runDir = path.join(outDir, 'run-001')
      fs.mkdirSync(runDir)
      fs.writeFileSync(path.join(runDir, 'output.md'), 'results', 'utf-8')

      const runs = mod.listOutputRuns(outDir)
      expect(runs).toHaveLength(1)
      expect(runs[0].name).toBe('run-001')
      expect(runs[0].files).toHaveLength(1)
      expect(runs[0].files[0].name).toBe('output.md')
    })

    it('groups root-level files into _root run', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      fs.writeFileSync(path.join(outDir, 'summary.md'), 'top-level', 'utf-8')

      const runs = mod.listOutputRuns(outDir)
      expect(runs).toHaveLength(1)
      expect(runs[0].name).toBe('_root')
      expect(runs[0].files).toHaveLength(1)
      expect(runs[0].files[0].name).toBe('summary.md')
    })

    it('expands ~ to home directory', () => {
      const outDir = path.join(tmpDir, 'tilde-test')
      fs.mkdirSync(outDir)
      fs.writeFileSync(path.join(outDir, 'file.md'), 'hello', 'utf-8')

      // The mock returns tmpDir for app.getPath('home')
      const tildeArg = `~/${path.relative(tmpDir, outDir)}`
      const runs = mod.listOutputRuns(tildeArg)
      expect(runs).toHaveLength(1)
      expect(runs[0].files[0].name).toBe('file.md')
    })

    it('sorts runs in reverse alphabetical order', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      for (const name of ['2024-01-01', '2024-01-03', '2024-01-02']) {
        const d = path.join(outDir, name)
        fs.mkdirSync(d)
        fs.writeFileSync(path.join(d, 'f.md'), '', 'utf-8')
      }

      const runs = mod.listOutputRuns(outDir)
      expect(runs.map(r => r.name)).toEqual(['2024-01-03', '2024-01-02', '2024-01-01'])
    })

    it('skips subdirectories with no files', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      fs.mkdirSync(path.join(outDir, 'empty-run'))

      expect(mod.listOutputRuns(outDir)).toEqual([])
    })

    it('includes file size in the result', () => {
      const outDir = path.join(tmpDir, 'outputs')
      fs.mkdirSync(outDir)
      const runDir = path.join(outDir, 'run-1')
      fs.mkdirSync(runDir)
      fs.writeFileSync(path.join(runDir, 'data.txt'), 'hello', 'utf-8')

      const runs = mod.listOutputRuns(outDir)
      expect(runs[0].files[0].size).toBe(5)
    })
  })
})
