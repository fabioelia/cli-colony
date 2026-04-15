import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron and settings before importing the module
vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))

const mockGetSettings = vi.fn()
vi.doMock('../settings', () => ({ getSettings: mockGetSettings }))

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

describe('fetchTicket', () => {
  let fetchTicket: (key: string) => Promise<import('../../shared/types').JiraTicket>

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/mock/home') } }))
    vi.doMock('../settings', () => ({ getSettings: mockGetSettings }))
    globalThis.fetch = mockFetch
    mockGetSettings.mockReset()
    mockFetch.mockReset()
    const mod = await import('../jira')
    fetchTicket = mod.fetchTicket
  })

  it('throws "Jira not configured" when settings are missing', async () => {
    mockGetSettings.mockResolvedValue({})
    await expect(fetchTicket('NP-123')).rejects.toThrow('Jira not configured')
  })

  it('fetches ticket and flattens ADF description', async () => {
    mockGetSettings.mockResolvedValue({
      jiraDomain: 'acme.atlassian.net',
      jiraEmail: 'user@acme.com',
      jiraApiToken: 'token123',
    })
    const adfDescription = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Fix the login crash' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Affects iOS 17+' }],
        },
      ],
    }
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        key: 'NP-123',
        fields: { summary: 'Fix login crash on iOS', description: adfDescription },
      }),
    })

    const ticket = await fetchTicket('NP-123')

    expect(ticket.key).toBe('NP-123')
    expect(ticket.summary).toBe('Fix login crash on iOS')
    expect(ticket.description).toContain('Fix the login crash')
    expect(ticket.description).toContain('Affects iOS 17+')
    expect(ticket.url).toBe('https://acme.atlassian.net/browse/NP-123')

    const call = mockFetch.mock.calls[0]
    expect(call[0]).toContain('/rest/api/3/issue/NP-123')
    expect(call[1].headers.Authorization).toMatch(/^Basic /)
  })

  it('throws "Jira auth failed" on 401 response', async () => {
    mockGetSettings.mockResolvedValue({
      jiraDomain: 'acme.atlassian.net',
      jiraEmail: 'user@acme.com',
      jiraApiToken: 'wrongtoken',
    })
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    })

    await expect(fetchTicket('NP-123')).rejects.toThrow('Jira auth failed')
  })
})
