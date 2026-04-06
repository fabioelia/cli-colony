/**
 * Tests for webhook-server signature validation helpers and pipeline-engine webhook integration.
 *
 * The HTTP server itself is not unit tested here (requires a real port),
 * but the core validation logic is extracted into pure helpers and tested.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'
import { IncomingMessage } from 'http'

// Hoist electron mock so it is in place before any module-level code that calls app.getPath()
vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home') },
}))

// ---- Import helpers directly from webhook-server ----
import { verifyGitHubSignature, verifyGenericToken } from '../webhook-server'

// ---- GitHub HMAC-SHA256 validation ----

describe('verifyGitHubSignature', () => {
  const secret = 'mysecrettoken'
  const body = Buffer.from(JSON.stringify({ action: 'opened', number: 42 }))

  function makeValidHeader(): string {
    const mac = createHmac('sha256', secret).update(body).digest('hex')
    return `sha256=${mac}`
  }

  it('passes with correct HMAC-SHA256 signature', () => {
    const header = makeValidHeader()
    expect(verifyGitHubSignature(secret, body, header)).toBe(true)
  })

  it('fails with wrong signature value', () => {
    expect(verifyGitHubSignature(secret, body, 'sha256=deadbeef')).toBe(false)
  })

  it('fails with wrong secret', () => {
    const mac = createHmac('sha256', 'wrongsecret').update(body).digest('hex')
    expect(verifyGitHubSignature(secret, body, `sha256=${mac}`)).toBe(false)
  })

  it('fails when header is undefined', () => {
    expect(verifyGitHubSignature(secret, body, undefined)).toBe(false)
  })

  it('fails when header is missing sha256= prefix', () => {
    const mac = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyGitHubSignature(secret, body, mac)).toBe(false)
  })

  it('fails when body is different from signed content', () => {
    const header = makeValidHeader()
    const differentBody = Buffer.from('{"action":"closed"}')
    expect(verifyGitHubSignature(secret, differentBody, header)).toBe(false)
  })

  it('passes with empty body if header matches empty body HMAC', () => {
    const emptyBody = Buffer.from('')
    const mac = createHmac('sha256', secret).update(emptyBody).digest('hex')
    expect(verifyGitHubSignature(secret, emptyBody, `sha256=${mac}`)).toBe(true)
  })
})

// ---- Generic bearer token validation ----

function makeMockRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('verifyGenericToken', () => {
  const secret = 'my-colony-token-abc'

  it('passes with correct Authorization: Bearer header', () => {
    const req = makeMockRequest({ authorization: `Bearer ${secret}` })
    expect(verifyGenericToken(secret, req)).toBe(true)
  })

  it('fails with wrong bearer token', () => {
    const req = makeMockRequest({ authorization: 'Bearer wrongtoken' })
    expect(verifyGenericToken(secret, req)).toBe(false)
  })

  it('passes with correct X-Colony-Token header', () => {
    const req = makeMockRequest({ 'x-colony-token': secret })
    expect(verifyGenericToken(secret, req)).toBe(true)
  })

  it('fails with wrong X-Colony-Token', () => {
    const req = makeMockRequest({ 'x-colony-token': 'badtoken' })
    expect(verifyGenericToken(secret, req)).toBe(false)
  })

  it('fails with no auth headers', () => {
    const req = makeMockRequest({})
    expect(verifyGenericToken(secret, req)).toBe(false)
  })

  it('fails when bearer prefix is missing', () => {
    const req = makeMockRequest({ authorization: secret })
    expect(verifyGenericToken(secret, req)).toBe(false)
  })

  it('prefers Authorization header over X-Colony-Token when both present', () => {
    const req = makeMockRequest({ authorization: `Bearer ${secret}`, 'x-colony-token': 'wrongtoken' })
    expect(verifyGenericToken(secret, req)).toBe(true)
  })
})

// ---- fireWebhookPipeline integration ----

const MOCK_ROOT = '/mock/.claude-colony'
const PIPELINES_DIR = `${MOCK_ROOT}/pipelines`
const STATE_PATH = `${MOCK_ROOT}/pipeline-state.json`

const WEBHOOK_YAML = `
name: My CI Webhook
description: Fires on GitHub PR webhook
enabled: true

trigger:
  type: webhook
  source: github
  secret: mysecret
  event: pull_request

condition:
  type: always

action:
  type: launch-session
  prompt: Handle PR webhook

dedup:
  key: webhook-run
  ttl: 60
`

const mockBroadcast = vi.fn()
const mockGetAllRepoConfigs = vi.fn(() => [])

function buildFsMock(fileNames: string[], fileContents: Record<string, string>, stateJson?: string) {
  return {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return true
      if (p === STATE_PATH) return stateJson !== undefined
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: string, _enc?: string) => {
      if (p === STATE_PATH) return stateJson ?? '{}'
      const key = Object.keys(fileContents).find(k => p.endsWith(k))
      if (key) return fileContents[key]
      throw new Error(`Unexpected readFileSync: ${p}`)
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockImplementation((p: string) => {
      if (p === PIPELINES_DIR) return fileNames
      return []
    }),
    appendFileSync: vi.fn(),
    statSync: vi.fn().mockImplementation((p: string) => {
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    }),
  }
}

describe('fireWebhookPipeline', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns ok:false for unknown slug', async () => {
    const fsMock = buildFsMock(['webhook.yaml'], { 'webhook.yaml': WEBHOOK_YAML })

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: MOCK_ROOT, pipelines: PIPELINES_DIR, schedulerLog: `${MOCK_ROOT}/scheduler.log` },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({ createInstance: vi.fn(), getAllInstances: vi.fn().mockResolvedValue([]) }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({ getRepos: vi.fn().mockReturnValue([]), fetchPRs: vi.fn(), fetchChecks: vi.fn(), gh: vi.fn() }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn() }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))

    const { loadPipelines, fireWebhookPipeline } = await import('../pipeline-engine')
    loadPipelines()

    const result = fireWebhookPipeline('nonexistent-slug', { test: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('nonexistent-slug')
  })

  it('returns ok:true for matching slug and calls runPoll', async () => {
    const fsMock = buildFsMock(['webhook.yaml'], { 'webhook.yaml': WEBHOOK_YAML })
    const mockRunPoll = vi.fn().mockResolvedValue(undefined)

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: MOCK_ROOT, pipelines: PIPELINES_DIR, schedulerLog: `${MOCK_ROOT}/scheduler.log` },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({ createInstance: vi.fn(), getAllInstances: vi.fn().mockResolvedValue([]) }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({ getRepos: vi.fn().mockReturnValue([]), fetchPRs: vi.fn().mockResolvedValue([]), fetchChecks: vi.fn(), gh: vi.fn().mockResolvedValue('') }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn() }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))

    const { loadPipelines, fireWebhookPipeline } = await import('../pipeline-engine')
    loadPipelines()

    // The slug for "My CI Webhook" should be "my-ci-webhook"
    const result = fireWebhookPipeline('my-ci-webhook', { action: 'opened', pull_request: { title: 'Fix bug', number: 1 } })
    expect(result.ok).toBe(true)
  })

  it('getWebhookTriggers returns webhook pipelines with correct slugs', async () => {
    const fsMock = buildFsMock(['webhook.yaml'], { 'webhook.yaml': WEBHOOK_YAML })

    vi.doMock('electron', () => ({
      app: { getPath: vi.fn().mockReturnValue('/mock/home') },
    }))
    vi.doMock('../../shared/colony-paths', () => ({
      colonyPaths: { root: MOCK_ROOT, pipelines: PIPELINES_DIR, schedulerLog: `${MOCK_ROOT}/scheduler.log` },
    }))
    vi.doMock('fs', () => fsMock)
    vi.doMock('../broadcast', () => ({ broadcast: mockBroadcast }))
    vi.doMock('../repo-config-loader', () => ({ getAllRepoConfigs: mockGetAllRepoConfigs }))
    vi.doMock('../instance-manager', () => ({ createInstance: vi.fn(), getAllInstances: vi.fn().mockResolvedValue([]) }))
    vi.doMock('../daemon-client', () => ({ getDaemonClient: vi.fn() }))
    vi.doMock('../send-prompt-when-ready', () => ({ sendPromptWhenReady: vi.fn() }))
    vi.doMock('../github', () => ({ getRepos: vi.fn().mockReturnValue([]), fetchPRs: vi.fn(), fetchChecks: vi.fn(), gh: vi.fn() }))
    vi.doMock('../session-router', () => ({ findBestRoute: vi.fn() }))
    vi.doMock('../activity-manager', () => ({ appendActivity: vi.fn() }))
    vi.doMock('../notifications', () => ({ notify: vi.fn() }))

    const { loadPipelines, getWebhookTriggers } = await import('../pipeline-engine')
    loadPipelines()

    const triggers = getWebhookTriggers()
    expect(triggers).toHaveLength(1)
    expect(triggers[0].name).toBe('My CI Webhook')
    expect(triggers[0].slug).toBe('my-ci-webhook')
    expect(triggers[0].trigger.type).toBe('webhook')
    expect(triggers[0].trigger.source).toBe('github')
    expect(triggers[0].trigger.secret).toBe('mysecret')
  })
})
