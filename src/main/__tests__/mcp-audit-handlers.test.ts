/**
 * Tests for src/main/ipc/mcp-audit-handlers.ts
 *
 * Strategy: vi.resetModules() + vi.doMock() + dynamic import per test to get
 * a fresh module with clean state. Mocks electron (app.getPath) and fs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_HOME = '/mock/home'
const MOCK_AUDIT_PATH = `${MOCK_HOME}/.claude-colony/mcp-audit.json`

// Shared fs.promises mock — reset per test
const mockFsp = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}

function setupMocks(fileExists: boolean, fileContent?: string) {
  mockFsp.readFile.mockReset().mockImplementation(async (p: string, _enc?: string) => {
    if (p === MOCK_AUDIT_PATH) {
      if (!fileExists) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return fileContent ?? '[]'
    }
    throw new Error(`Unexpected readFile: ${p}`)
  })
  mockFsp.writeFile.mockReset().mockResolvedValue(undefined)
  mockFsp.mkdir.mockReset().mockResolvedValue(undefined)
  mockFsp.unlink.mockReset().mockResolvedValue(undefined)

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn().mockReturnValue(MOCK_HOME) },
    ipcMain: { handle: vi.fn() },
  }))
  vi.doMock('fs', () => ({
    promises: mockFsp,
  }))
}

describe('mcp-audit-handlers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('getAuditLog() returns [] when file does not exist', async () => {
    setupMocks(false)
    const mod = await import('../ipc/mcp-audit-handlers')
    const result = await mod.getAuditLog()
    expect(result).toEqual([])
  })

  it('appendAuditEntry() writes entry and trims to 500', async () => {
    // Seed 499 existing entries
    const existing = Array.from({ length: 499 }, (_, i) => ({
      ts: 1000 + i,
      sessionId: `s${i}`,
      sessionName: `Session ${i}`,
      serverName: 'my-server',
      toolName: 'my-tool',
      outcome: 'auto' as const,
    }))
    setupMocks(true, JSON.stringify(existing))

    const mod = await import('../ipc/mcp-audit-handlers')
    await mod.appendAuditEntry({
      sessionId: 'new-session',
      sessionName: 'New Session',
      serverName: 'test-server',
      toolName: 'test-tool',
      outcome: 'approved',
    })

    expect(mockFsp.writeFile).toHaveBeenCalledOnce()
    const [writePath, writeContent] = mockFsp.writeFile.mock.calls[0]
    expect(writePath).toBe(MOCK_AUDIT_PATH)
    const written = JSON.parse(writeContent as string)
    // 499 + 1 = 500, stays at 500
    expect(written).toHaveLength(500)
    // The newest entry is the last one written
    expect(written[499].sessionId).toBe('new-session')
    expect(written[499].outcome).toBe('approved')
    expect(typeof written[499].ts).toBe('number')
  })

  it('appendAuditEntry() trims to 500 when over limit', async () => {
    // Seed 502 existing entries (over limit)
    const existing = Array.from({ length: 502 }, (_, i) => ({
      ts: 1000 + i,
      sessionId: `s${i}`,
      sessionName: `Session ${i}`,
      serverName: 'srv',
      toolName: 'tool',
      outcome: 'auto' as const,
    }))
    setupMocks(true, JSON.stringify(existing))

    const mod = await import('../ipc/mcp-audit-handlers')
    await mod.appendAuditEntry({
      sessionId: 'extra',
      sessionName: 'Extra',
      serverName: 'srv',
      toolName: 'tool',
      outcome: 'denied',
    })

    const [, writeContent] = mockFsp.writeFile.mock.calls[0]
    const written = JSON.parse(writeContent as string)
    // 502 + 1 = 503, trimmed to 500
    expect(written).toHaveLength(500)
    // Oldest entries are dropped; the newest entry should be last
    expect(written[499].sessionId).toBe('extra')
  })

  it('clearAuditLog() deletes the file when it exists', async () => {
    setupMocks(true)
    const mod = await import('../ipc/mcp-audit-handlers')
    await mod.clearAuditLog()
    expect(mockFsp.unlink).toHaveBeenCalledWith(MOCK_AUDIT_PATH)
  })

  it('clearAuditLog() does not throw when file does not exist', async () => {
    setupMocks(false)
    mockFsp.unlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const mod = await import('../ipc/mcp-audit-handlers')
    await mod.clearAuditLog()
    // Should not throw — ENOENT is silently ignored
  })

  it('getAuditLog() returns newest first, max 100', async () => {
    // Create 150 entries with ascending ts values
    const entries = Array.from({ length: 150 }, (_, i) => ({
      ts: 1000 + i,
      sessionId: `s${i}`,
      sessionName: `Session ${i}`,
      serverName: 'srv',
      toolName: 'tool',
      outcome: 'auto' as const,
    }))
    setupMocks(true, JSON.stringify(entries))

    const mod = await import('../ipc/mcp-audit-handlers')
    const result = await mod.getAuditLog()

    // Should return max 100 entries
    expect(result).toHaveLength(100)
    // Should be newest first (highest ts first)
    expect(result[0].ts).toBe(1000 + 149)
    expect(result[99].ts).toBe(1000 + 50)
  })
})
