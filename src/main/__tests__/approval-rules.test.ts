import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadApprovalRules,
  saveApprovalRules,
  createRule,
  updateRule,
  deleteRule,
  matchRules,
  estimateActionCost,
  clearCache,
} from '../approval-rules'
import { ApprovalRule } from '../../shared/types'

// Mock the colonyPaths module
vi.doMock('../../shared/colony-paths', () => ({
  colonyPaths: {
    governance: '/tmp/test-governance',
    approvalRulesJson: '/tmp/test-governance/approval-rules.json',
  },
}))

// Mock fs.promises
const mockFsp = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
}))

vi.mock('fs', () => ({
  promises: mockFsp,
}))

describe('approval-rules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
    // Default: readFile rejects with ENOENT (file does not exist)
    mockFsp.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFsp.writeFile.mockResolvedValue(undefined)
    mockFsp.mkdir.mockResolvedValue(undefined)
  })

  afterEach(() => {
    clearCache()
  })

  describe('loadApprovalRules', () => {
    it('returns empty array when rules file does not exist', async () => {
      const rules = await loadApprovalRules()
      expect(rules).toEqual([])
    })

    it('reads and parses rules from file', async () => {
      const mockRules: ApprovalRule[] = [
        {
          id: 'rule-1',
          name: 'Auto-Approve Formatting',
          type: 'file_pattern',
          condition: '*.md,*.txt',
          action: 'auto_approve',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
      const rules = await loadApprovalRules()
      expect(rules).toEqual(mockRules)
    })

    it('returns cached rules on second call', async () => {
      const mockRules: ApprovalRule[] = []
      mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
      await loadApprovalRules()
      const rules = await loadApprovalRules()
      expect(rules).toEqual(mockRules)
      expect(mockFsp.readFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('saveApprovalRules', () => {
    it('creates governance directory if missing', async () => {
      const rules: ApprovalRule[] = []
      await saveApprovalRules(rules)
      expect(mockFsp.mkdir).toHaveBeenCalled()
    })

    it('writes rules to file', async () => {
      const rules: ApprovalRule[] = [
        {
          id: 'rule-1',
          name: 'Test Rule',
          type: 'cost_threshold',
          condition: '< 0.10',
          action: 'auto_approve',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
      ]
      await saveApprovalRules(rules)
      expect(mockFsp.writeFile).toHaveBeenCalled()
    })

    it('clears cache after saving', async () => {
      const rules: ApprovalRule[] = []
      await saveApprovalRules(rules)
      clearCache()
      expect(await loadApprovalRules()).toEqual([])
    })
  })

  describe('createRule', () => {
    beforeEach(() => {
      mockFsp.writeFile.mockResolvedValue(undefined)
      mockFsp.mkdir.mockResolvedValue(undefined)
    })

    it('generates a new rule with id and enabled:true', async () => {
      const rule = await createRule('Test', 'file_pattern', '*.md', 'auto_approve')
      expect(rule.id).toBeDefined()
      expect(rule.name).toBe('Test')
      expect(rule.type).toBe('file_pattern')
      expect(rule.condition).toBe('*.md')
      expect(rule.action).toBe('auto_approve')
      expect(rule.enabled).toBe(true)
      expect(rule.createdAt).toBeDefined()
    })

    it('persists rule to storage', async () => {
      await createRule('Test', 'risk_level', 'high', 'require_approval')
      expect(mockFsp.writeFile).toHaveBeenCalled()
    })
  })

  describe('updateRule', () => {
    it('returns false if rule not found', async () => {
      const found = await updateRule('nonexistent', { enabled: false })
      expect(found).toBe(false)
    })

    it('merges partial updates and saves', async () => {
      const mockRule: ApprovalRule = {
        id: 'rule-1',
        name: 'Original',
        type: 'cost_threshold',
        condition: '< 0.10',
        action: 'auto_approve',
        enabled: true,
        createdAt: '2026-04-07T00:00:00Z',
      }
      mockFsp.readFile.mockResolvedValue(JSON.stringify([mockRule]))
      mockFsp.writeFile.mockResolvedValue(undefined)
      const found = await updateRule('rule-1', { enabled: false })
      expect(found).toBe(true)
      expect(mockFsp.writeFile).toHaveBeenCalled()
    })
  })

  describe('deleteRule', () => {
    it('returns false if rule not found', async () => {
      const found = await deleteRule('nonexistent')
      expect(found).toBe(false)
    })

    it('removes rule from list and saves', async () => {
      const mockRules: ApprovalRule[] = [
        {
          id: 'rule-1',
          name: 'Rule 1',
          type: 'file_pattern',
          condition: '*.md',
          action: 'auto_approve',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
        {
          id: 'rule-2',
          name: 'Rule 2',
          type: 'cost_threshold',
          condition: '< 0.10',
          action: 'auto_approve',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
      mockFsp.writeFile.mockResolvedValue(undefined)
      const found = await deleteRule('rule-1')
      expect(found).toBe(true)
      expect(mockFsp.writeFile).toHaveBeenCalled()
    })
  })

  describe('matchRules', () => {
    it('returns null when no rules exist', async () => {
      const rule = await matchRules('launch-session', 0.02, [])
      expect(rule).toBeNull()
    })

    it('skips disabled rules', async () => {
      const mockRules: ApprovalRule[] = [
        {
          id: 'rule-1',
          name: 'Disabled',
          type: 'cost_threshold',
          condition: '< 0.10',
          action: 'auto_approve',
          enabled: false,
          createdAt: '2026-04-07T00:00:00Z',
        },
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
      const rule = await matchRules('launch-session', 0.02, [])
      expect(rule).toBeNull()
    })

    describe('file_pattern matching', () => {
      it('matches single glob pattern', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Markdown only',
            type: 'file_pattern',
            condition: '*.md',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('diff_review', 0.02, ['README.md'])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match mismatched glob pattern', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Markdown only',
            type: 'file_pattern',
            condition: '*.md',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('diff_review', 0.02, ['script.ts'])
        expect(rule).toBeNull()
      })

      it('matches comma-separated glob patterns', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Text files',
            type: 'file_pattern',
            condition: '*.md,*.txt',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('diff_review', 0.02, ['notes.txt'])
        expect(rule).toEqual(mockRules[0])
      })
    })

    describe('cost_threshold matching', () => {
      it('matches cost < threshold', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Cheap actions',
            type: 'cost_threshold',
            condition: '< 0.10',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('plan', 0.01, [])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match cost above threshold', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Cheap actions',
            type: 'cost_threshold',
            condition: '< 0.10',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('maker-checker', 0.15, [])
        expect(rule).toBeNull()
      })

      it('matches cost >= threshold', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Expensive actions',
            type: 'cost_threshold',
            condition: '>= 0.05',
            action: 'require_approval',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('maker-checker', 0.05, [])
        expect(rule).toEqual(mockRules[0])
      })
    })

    describe('risk_level matching', () => {
      it('matches low risk action against low condition', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Low risk auto-approve',
            type: 'risk_level',
            condition: 'low',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('wait_for_session', 0, [])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match medium action against low condition', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Low risk only',
            type: 'risk_level',
            condition: 'low',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('diff_review', 0.02, [])
        expect(rule).toBeNull()
      })

      it('matches pipe-separated risk levels', async () => {
        const mockRules: ApprovalRule[] = [
          {
            id: 'rule-1',
            name: 'Medium or low',
            type: 'risk_level',
            condition: 'low|medium',
            action: 'auto_approve',
            enabled: true,
            createdAt: '2026-04-07T00:00:00Z',
          },
        ]
        mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
        const rule = await matchRules('diff_review', 0.02, [])
        expect(rule).toEqual(mockRules[0])
      })
    })

    it('returns first matching rule (precedence)', async () => {
      const mockRules: ApprovalRule[] = [
        {
          id: 'rule-1',
          name: 'First',
          type: 'cost_threshold',
          condition: '< 1.0',
          action: 'auto_approve',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
        {
          id: 'rule-2',
          name: 'Second',
          type: 'cost_threshold',
          condition: '< 0.5',
          action: 'require_approval',
          enabled: true,
          createdAt: '2026-04-07T00:00:00Z',
        },
      ]
      mockFsp.readFile.mockResolvedValue(JSON.stringify(mockRules))
      const rule = await matchRules('plan', 0.01, [])
      expect(rule?.id).toBe('rule-1')
    })
  })

  describe('estimateActionCost', () => {
    it('returns correct cost for known action types', () => {
      expect(estimateActionCost('wait_for_session')).toBe(0)
      expect(estimateActionCost('plan')).toBe(0.01)
      expect(estimateActionCost('diff_review')).toBe(0.02)
      expect(estimateActionCost('launch-session')).toBe(0.02)
      expect(estimateActionCost('maker-checker')).toBe(0.05)
    })

    it('returns default cost for unknown action types', () => {
      expect(estimateActionCost('unknown-action')).toBe(0.02)
    })
  })
})
