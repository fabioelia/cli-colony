import { describe, it, expect, beforeEach } from 'vitest'
import {
  tokenizeApproximate,
  getModelMaxTokens,
  initializeContext,
  addHistoryTokens,
  addArtifactTokens,
  getContextUsage,
  dismissAlert,
  isAlertDismissed,
  resetDismissedAlerts,
  removeContext,
  getAllContextStates,
  clearAllContextStates,
} from '../context-counter'

describe('context-counter', () => {
  beforeEach(() => {
    clearAllContextStates()
  })

  describe('tokenizeApproximate', () => {
    it('should estimate tokens using 1 token ≈ 4 chars', () => {
      expect(tokenizeApproximate('hello')).toBe(2) // 5 chars → 2 tokens (ceil)
      expect(tokenizeApproximate('hello world')).toBe(3) // 11 chars → 3 tokens
      expect(tokenizeApproximate('a')).toBe(1)
      expect(tokenizeApproximate('abcd')).toBe(1)
      expect(tokenizeApproximate('abcde')).toBe(2)
      expect(tokenizeApproximate('')).toBe(0)
    })

    it('should handle long strings', () => {
      const longString = 'x'.repeat(1000)
      expect(tokenizeApproximate(longString)).toBe(250)
    })
  })

  describe('getModelMaxTokens', () => {
    it('should return correct max tokens for known models', () => {
      expect(getModelMaxTokens('claude-opus-4-6')).toBe(1_000_000)
      expect(getModelMaxTokens('claude-opus-4')).toBe(200_000)
      expect(getModelMaxTokens('claude-sonnet-4-6')).toBe(200_000)
      expect(getModelMaxTokens('claude-3-5-sonnet')).toBe(200_000)
      expect(getModelMaxTokens('claude-haiku-4-5-20251001')).toBe(100_000)
      expect(getModelMaxTokens('claude-haiku-3.5')).toBe(100_000)
    })

    it('should return default max tokens for unknown models', () => {
      expect(getModelMaxTokens('unknown-model')).toBe(200_000)
    })
  })

  describe('initializeContext', () => {
    it('should initialize context for a new session', () => {
      const longSystemPrompt = 'system '.repeat(5000) // ~35,000 chars = ~8,750 tokens
      const usage = initializeContext('sess1', 'claude-opus-4-6', longSystemPrompt)

      expect(usage.sessionId).toBe('sess1')
      expect(usage.maxTokens).toBe(1_000_000)
      expect(usage.tokens).toBeGreaterThan(0)
      expect(usage.percentage).toBeGreaterThan(0)
      expect(usage.breakdown.systemPrompt).toBeGreaterThan(0)
      expect(usage.breakdown.history).toBe(0)
      expect(usage.breakdown.artifacts).toBe(0)
    })

    it('should initialize without system prompt', () => {
      const usage = initializeContext('sess2', 'claude-3-5-sonnet')

      expect(usage.sessionId).toBe('sess2')
      expect(usage.maxTokens).toBe(200_000)
      expect(usage.breakdown.systemPrompt).toBe(0)
    })

    it('should store context state in memory', () => {
      initializeContext('sess3', 'claude-opus-4')
      const states = getAllContextStates()

      expect(states).toHaveLength(1)
      expect(states[0].sessionId).toBe('sess3')
    })
  })

  describe('addHistoryTokens', () => {
    it('should add history tokens to existing context', () => {
      initializeContext('sess1', 'claude-opus-4', 'sys')

      const usage1 = addHistoryTokens('sess1', 'user message here')
      expect(usage1?.breakdown.history).toBeGreaterThan(0)
      expect(usage1?.tokens).toBeGreaterThan(1)

      const usage2 = addHistoryTokens('sess1', 'more history')
      expect(usage2?.breakdown.history).toBeGreaterThan(usage1!.breakdown.history)
      expect(usage2?.tokens).toBeGreaterThan(usage1!.tokens)
    })

    it('should return null for non-existent session', () => {
      const result = addHistoryTokens('nonexistent', 'text')
      expect(result).toBeNull()
    })

    it('should accumulate history tokens', () => {
      initializeContext('sess1', 'claude-opus-4', '')

      const baseline = getContextUsage('sess1')
      addHistoryTokens('sess1', 'a'.repeat(100))
      const after = getContextUsage('sess1')

      expect(after!.tokens).toBeGreaterThan(baseline!.tokens)
    })
  })

  describe('addArtifactTokens', () => {
    it('should add artifact tokens to existing context', () => {
      initializeContext('sess1', 'claude-opus-4', 'sys')

      const usage1 = addArtifactTokens('sess1', 'artifact content')
      expect(usage1?.breakdown.artifacts).toBeGreaterThan(0)

      const usage2 = addArtifactTokens('sess1', 'more artifact')
      expect(usage2?.breakdown.artifacts).toBeGreaterThan(usage1!.breakdown.artifacts)
    })

    it('should return null for non-existent session', () => {
      const result = addArtifactTokens('nonexistent', 'text')
      expect(result).toBeNull()
    })

    it('should track artifacts separately from history', () => {
      initializeContext('sess1', 'claude-opus-4', '')

      addHistoryTokens('sess1', 'history content')
      const afterHistory = getContextUsage('sess1')

      addArtifactTokens('sess1', 'artifact content')
      const afterArtifacts = getContextUsage('sess1')

      expect(afterArtifacts!.breakdown.history).toBe(afterHistory!.breakdown.history)
      expect(afterArtifacts!.breakdown.artifacts).toBeGreaterThan(0)
    })
  })

  describe('getContextUsage', () => {
    it('should return null for non-existent session', () => {
      expect(getContextUsage('nonexistent')).toBeNull()
    })

    it('should return current usage for existing session', () => {
      initializeContext('sess1', 'claude-opus-4', 'sys')
      const usage = getContextUsage('sess1')

      expect(usage).not.toBeNull()
      expect(usage?.sessionId).toBe('sess1')
      expect(usage?.maxTokens).toBe(200_000)
      expect(usage?.percentage).toBeGreaterThanOrEqual(0)
      expect(usage?.percentage).toBeLessThanOrEqual(100)
    })

    it('should calculate percentage correctly', () => {
      initializeContext('sess1', 'claude-opus-4', 'x'.repeat(100_000))
      const usage = getContextUsage('sess1')

      // 100,000 chars ≈ 25,000 tokens out of 200,000 max = 12.5% → 13%
      expect(usage!.percentage).toBeGreaterThanOrEqual(10)
      expect(usage!.percentage).toBeLessThanOrEqual(20)
    })
  })

  describe('dismissAlert', () => {
    it('should track dismissed alerts', () => {
      initializeContext('sess1', 'claude-opus-4')

      expect(isAlertDismissed('sess1', 80)).toBe(false)
      dismissAlert('sess1', 80)
      expect(isAlertDismissed('sess1', 80)).toBe(true)
    })

    it('should allow multiple alerts to be dismissed', () => {
      initializeContext('sess1', 'claude-opus-4')

      dismissAlert('sess1', 80)
      dismissAlert('sess1', 95)

      expect(isAlertDismissed('sess1', 80)).toBe(true)
      expect(isAlertDismissed('sess1', 95)).toBe(true)
    })

    it('should not affect other sessions', () => {
      initializeContext('sess1', 'claude-opus-4')
      initializeContext('sess2', 'claude-opus-4')

      dismissAlert('sess1', 80)

      expect(isAlertDismissed('sess1', 80)).toBe(true)
      expect(isAlertDismissed('sess2', 80)).toBe(false)
    })
  })

  describe('resetDismissedAlerts', () => {
    it('should clear dismissed alerts', () => {
      initializeContext('sess1', 'claude-opus-4')
      dismissAlert('sess1', 80)
      dismissAlert('sess1', 95)

      expect(isAlertDismissed('sess1', 80)).toBe(true)
      expect(isAlertDismissed('sess1', 95)).toBe(true)

      resetDismissedAlerts('sess1')

      expect(isAlertDismissed('sess1', 80)).toBe(false)
      expect(isAlertDismissed('sess1', 95)).toBe(false)
    })
  })

  describe('removeContext', () => {
    it('should remove context from tracking', () => {
      initializeContext('sess1', 'claude-opus-4')
      expect(getContextUsage('sess1')).not.toBeNull()

      removeContext('sess1')
      expect(getContextUsage('sess1')).toBeNull()
    })

    it('should not affect other sessions', () => {
      initializeContext('sess1', 'claude-opus-4')
      initializeContext('sess2', 'claude-opus-4')

      removeContext('sess1')

      expect(getContextUsage('sess1')).toBeNull()
      expect(getContextUsage('sess2')).not.toBeNull()
    })
  })

  describe('multiple sessions', () => {
    it('should track multiple sessions independently', () => {
      initializeContext('sess1', 'claude-opus-4', 'short')
      initializeContext('sess2', 'claude-opus-4-6', 'much longer system prompt text here')

      const usage1 = getContextUsage('sess1')
      const usage2 = getContextUsage('sess2')

      expect(usage1?.maxTokens).toBe(200_000)
      expect(usage2?.maxTokens).toBe(1_000_000)
      expect(usage2!.breakdown.systemPrompt).toBeGreaterThan(usage1!.breakdown.systemPrompt)
    })

    it('should update each session independently', () => {
      initializeContext('sess1', 'claude-opus-4', '')
      initializeContext('sess2', 'claude-opus-4', '')

      const baseline1 = getContextUsage('sess1')!.tokens
      const baseline2 = getContextUsage('sess2')!.tokens

      addHistoryTokens('sess1', 'text for session 1')
      const after1 = getContextUsage('sess1')!.tokens

      expect(after1).toBeGreaterThan(baseline1)
      expect(getContextUsage('sess2')!.tokens).toBe(baseline2)
    })
  })
})
