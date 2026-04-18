/**
 * Token estimation and context window tracking.
 * Uses approximation (1 token ≈ 4 chars) for performance.
 * Tracks system prompt, history, and artifacts separately.
 */

import { ContextUsage, ContextUsageBreakdown } from '../shared/types'

// Model-specific max token limits (context window sizes)
const MODEL_MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-haiku-4-5-20251001': 100_000,
  'claude-haiku-3.5': 100_000,
  // Fallback to conservative default if model is unknown
  default: 200_000,
}

// Approximation: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4

interface ContextState {
  sessionId: string
  modelId: string
  createdAt: string
  systemPromptTokens: number
  historyTokens: number
  artifactsTokens: number
  otherTokens: number
  lastUpdatedAt: string
  dismissedAlerts: Set<number>  // track dismissed alert thresholds (80, 95)
}

// In-memory store of context states per session
const contextStates = new Map<string, ContextState>()

/**
 * Tokenize a string using approximation (1 token ≈ 4 chars).
 */
export function tokenizeApproximate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Get max tokens for a given model ID.
 */
export function getModelMaxTokens(modelId: string): number {
  return MODEL_MAX_TOKENS[modelId] || MODEL_MAX_TOKENS.default
}

/**
 * Initialize context tracking for a new session.
 */
export function initializeContext(
  sessionId: string,
  modelId: string,
  systemPromptText?: string
): ContextUsage {
  const now = new Date().toISOString()
  const systemPromptTokens = systemPromptText ? tokenizeApproximate(systemPromptText) : 0

  const state: ContextState = {
    sessionId,
    modelId,
    createdAt: now,
    systemPromptTokens,
    historyTokens: 0,
    artifactsTokens: 0,
    otherTokens: 0,
    lastUpdatedAt: now,
    dismissedAlerts: new Set(),
  }

  contextStates.set(sessionId, state)

  return buildContextUsage(state)
}

/**
 * Update context with new history (e.g., user prompt added).
 */
export function addHistoryTokens(sessionId: string, historyText: string): ContextUsage | null {
  const state = contextStates.get(sessionId)
  if (!state) return null

  const added = tokenizeApproximate(historyText)
  state.historyTokens += added
  state.lastUpdatedAt = new Date().toISOString()

  return buildContextUsage(state)
}

/**
 * Update context with artifacts (e.g., handoff output appended).
 */
export function addArtifactTokens(sessionId: string, artifactText: string): ContextUsage | null {
  const state = contextStates.get(sessionId)
  if (!state) return null

  const added = tokenizeApproximate(artifactText)
  state.artifactsTokens += added
  state.lastUpdatedAt = new Date().toISOString()

  return buildContextUsage(state)
}

/**
 * Get current context usage for a session.
 */
export function getContextUsage(sessionId: string): ContextUsage | null {
  const state = contextStates.get(sessionId)
  if (!state) return null
  return buildContextUsage(state)
}

/**
 * Record a dismissed alert so we don't spam the user.
 */
export function dismissAlert(sessionId: string, threshold: number): void {
  const state = contextStates.get(sessionId)
  if (state) {
    state.dismissedAlerts.add(threshold)
  }
}

/**
 * Check if an alert for a threshold has been dismissed.
 */
export function isAlertDismissed(sessionId: string, threshold: number): boolean {
  const state = contextStates.get(sessionId)
  if (!state) return false
  return state.dismissedAlerts.has(threshold)
}

/**
 * Clear dismissed alerts when usage drops below threshold (so alert can fire again if user goes back up).
 */
export function resetDismissedAlerts(sessionId: string): void {
  const state = contextStates.get(sessionId)
  if (state) {
    state.dismissedAlerts.clear()
  }
}

/**
 * Remove context tracking for a session (e.g., on session exit).
 */
export function removeContext(sessionId: string): void {
  contextStates.delete(sessionId)
}

/**
 * Get context usage for all tracked sessions.
 */
export function getAllContextUsage(): ContextUsage[] {
  const results: ContextUsage[] = []
  for (const state of contextStates.values()) {
    results.push(buildContextUsage(state))
  }
  return results
}

/**
 * Get all tracked context states (for testing/debugging).
 */
export function getAllContextStates(): ContextState[] {
  return Array.from(contextStates.values())
}

/**
 * Clear all context states (for testing).
 */
export function clearAllContextStates(): void {
  contextStates.clear()
}

// Internal helper to build the ContextUsage response.
function buildContextUsage(state: ContextState): ContextUsage {
  const breakdown: ContextUsageBreakdown = {
    systemPrompt: state.systemPromptTokens,
    history: state.historyTokens,
    artifacts: state.artifactsTokens,
    other: state.otherTokens,
  }

  const totalTokens =
    breakdown.systemPrompt + breakdown.history + breakdown.artifacts + breakdown.other
  const maxTokens = getModelMaxTokens(state.modelId)
  const percentage = Math.round((totalTokens / maxTokens) * 100)

  return {
    sessionId: state.sessionId,
    tokens: totalTokens,
    maxTokens,
    percentage,
    breakdown,
    lastUpdatedAt: state.lastUpdatedAt,
  }
}
