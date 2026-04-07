import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
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

// Mock fs operations
vi.mock('fs', { spy: true })

describe('approval-rules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCache()
    // Reset fs mocks
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  afterEach(() => {
    clearCache()
  })

  describe('loadApprovalRules', () => {
    it('returns empty array when rules file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const rules = loadApprovalRules()
      expect(rules).toEqual([])
    })

    it('reads and parses rules from file', () => {
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
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
      const rules = loadApprovalRules()
      expect(rules).toEqual(mockRules)
    })

    it('returns cached rules on second call', () => {
      const mockRules: ApprovalRule[] = []
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
      loadApprovalRules()
      const rules = loadApprovalRules()
      expect(rules).toEqual(mockRules)
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1)
    })
  })

  describe('saveApprovalRules', () => {
    it('creates governance directory if missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const rules: ApprovalRule[] = []
      saveApprovalRules(rules)
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled()
    })

    it('writes rules to file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
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
      saveApprovalRules(rules)
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    })

    it('clears cache after saving', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const rules: ApprovalRule[] = []
      saveApprovalRules(rules)
      clearCache()
      expect(loadApprovalRules()).toEqual([])
    })
  })

  describe('createRule', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    })

    it('generates a new rule with id and enabled:true', () => {
      const rule = createRule('Test', 'file_pattern', '*.md', 'auto_approve')
      expect(rule.id).toBeDefined()
      expect(rule.name).toBe('Test')
      expect(rule.type).toBe('file_pattern')
      expect(rule.condition).toBe('*.md')
      expect(rule.action).toBe('auto_approve')
      expect(rule.enabled).toBe(true)
      expect(rule.createdAt).toBeDefined()
    })

    it('persists rule to storage', () => {
      createRule('Test', 'risk_level', 'high', 'require_approval')
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    })
  })

  describe('updateRule', () => {
    it('returns false if rule not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const found = updateRule('nonexistent', { enabled: false })
      expect(found).toBe(false)
    })

    it('merges partial updates and saves', () => {
      const mockRule: ApprovalRule = {
        id: 'rule-1',
        name: 'Original',
        type: 'cost_threshold',
        condition: '< 0.10',
        action: 'auto_approve',
        enabled: true,
        createdAt: '2026-04-07T00:00:00Z',
      }
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([mockRule]))
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
      const found = updateRule('rule-1', { enabled: false })
      expect(found).toBe(true)
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    })
  })

  describe('deleteRule', () => {
    it('returns false if rule not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const found = deleteRule('nonexistent')
      expect(found).toBe(false)
    })

    it('removes rule from list and saves', () => {
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
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
      const found = deleteRule('rule-1')
      expect(found).toBe(true)
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    })
  })

  describe('matchRules', () => {
    it('returns null when no rules exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const rule = matchRules('launch-session', 0.02, [])
      expect(rule).toBeNull()
    })

    it('skips disabled rules', () => {
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
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
      const rule = matchRules('launch-session', 0.02, [])
      expect(rule).toBeNull()
    })

    describe('file_pattern matching', () => {
      it('matches single glob pattern', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('diff_review', 0.02, ['README.md'])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match mismatched glob pattern', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('diff_review', 0.02, ['script.ts'])
        expect(rule).toBeNull()
      })

      it('matches comma-separated glob patterns', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('diff_review', 0.02, ['notes.txt'])
        expect(rule).toEqual(mockRules[0])
      })
    })

    describe('cost_threshold matching', () => {
      it('matches cost < threshold', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('plan', 0.01, [])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match cost above threshold', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('maker-checker', 0.15, [])
        expect(rule).toBeNull()
      })

      it('matches cost >= threshold', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('maker-checker', 0.05, [])
        expect(rule).toEqual(mockRules[0])
      })
    })

    describe('risk_level matching', () => {
      it('matches low risk action against low condition', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('wait_for_session', 0, [])
        expect(rule).toEqual(mockRules[0])
      })

      it('does not match medium action against low condition', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('diff_review', 0.02, [])
        expect(rule).toBeNull()
      })

      it('matches pipe-separated risk levels', () => {
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
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
        const rule = matchRules('diff_review', 0.02, [])
        expect(rule).toEqual(mockRules[0])
      })
    })

    it('returns first matching rule (precedence)', () => {
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
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRules))
      const rule = matchRules('plan', 0.01, [])
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
