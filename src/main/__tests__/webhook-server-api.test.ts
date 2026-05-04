/**
 * Integration tests for webhook-server REST API routes (/api/*).
 * Starts a real HTTP server on a random port to test the full request/response cycle.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import { createHmac } from 'crypto'

// --- Mocks (hoisted before module imports) ---

const mockGetAllInstances = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockCreateInstance = vi.hoisted(() => vi.fn())
const mockKillInstance = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockGetSetting = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const mockDaemonRouterObj = vi.hoisted(() => ({
  getInstanceBuffer: vi.fn().mockResolvedValue(''),
  removeInstance: vi.fn().mockResolvedValue(undefined),
  steerInstance: vi.fn().mockResolvedValue(true),
}))
const mockGetPipelineList = vi.hoisted(() => vi.fn().mockReturnValue([]))
const mockTriggerPollNow = vi.hoisted(() => vi.fn().mockReturnValue(false))
const mockGetHistory = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockGetPersonaList = vi.hoisted(() => vi.fn().mockReturnValue([]))
const mockRunPersona = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/home'), getVersion: vi.fn().mockReturnValue('1.2.3') },
}))
vi.mock('../settings', () => ({ getSetting: mockGetSetting }))
vi.mock('../instance-manager', () => ({
  getAllInstances: mockGetAllInstances,
  createInstance: mockCreateInstance,
  killInstance: mockKillInstance,
}))
vi.mock('../daemon-router', () => ({ getDaemonRouter: () => mockDaemonRouterObj }))
const mockFireWebhookPipeline = vi.hoisted(() => vi.fn().mockReturnValue({ ok: true }))
const mockGetWebhookTriggers = vi.hoisted(() => vi.fn().mockReturnValue([]))
const mockPreviewPipeline = vi.hoisted(() => vi.fn().mockResolvedValue({ wouldFire: false, matches: [], conditionLog: [] }))
const mockValidatePipelineYaml = vi.hoisted(() => vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [], def: { name: 'My Pipe', trigger: { type: 'cron' }, action: { type: 'launch-session' } } }))

vi.mock('../pipeline-engine', () => ({
  getPipelineList: mockGetPipelineList,
  triggerPollNow: mockTriggerPollNow,
  fireWebhookPipeline: mockFireWebhookPipeline,
  getWebhookTriggers: mockGetWebhookTriggers,
  getHistory: mockGetHistory,
  previewPipeline: mockPreviewPipeline,
  validatePipelineYaml: mockValidatePipelineYaml,
}))
vi.mock('../persona-manager', () => ({
  getPersonaList: mockGetPersonaList,
  runPersona: mockRunPersona,
  addWhisper: vi.fn(),
}))
vi.mock('../broadcast', () => ({ addBroadcastListener: vi.fn() }))

import { startWebhookServer, stopWebhookServer } from '../webhook-server'

// --- Helpers ---

let port = 0

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
  })
}

interface RequestResult {
  status: number
  body: unknown
  headers: http.IncomingHttpHeaders
}

function apiRequest(options: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string
}): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const bodyBuf = options.body ? Buffer.from(options.body, 'utf8') : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length.toString()
    Object.assign(headers, options.headers || {})
    const req = http.request(
      { hostname: '127.0.0.1', port, method: options.method || 'GET', path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown
          try { body = JSON.parse(text) } catch { body = text }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        })
      },
    )
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

const INST = { id: 'inst-1', name: 'My Session', status: 'running', tokenUsage: { cost: 0.05 }, createdAt: null }

beforeAll(async () => {
  port = await getFreePort()
  startWebhookServer(port)
  await new Promise(r => setTimeout(r, 50))
})

afterAll(() => {
  stopWebhookServer()
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSetting.mockResolvedValue(null)
  mockGetAllInstances.mockResolvedValue([])
  mockDaemonRouterObj.getInstanceBuffer.mockResolvedValue('')
  mockDaemonRouterObj.removeInstance.mockResolvedValue(undefined)
  mockDaemonRouterObj.steerInstance.mockResolvedValue(true)
  mockGetHistory.mockResolvedValue([])
  mockFireWebhookPipeline.mockReturnValue({ ok: true })
  mockGetWebhookTriggers.mockReturnValue([])
})

// --- Auth ---

describe('API auth enforcement', () => {
  it('passes when no apiToken configured', async () => {
    const res = await apiRequest({ path: '/api/status' })
    expect(res.status).toBe(200)
  })

  it('returns 401 when apiToken configured and no credentials provided', async () => {
    mockGetSetting.mockResolvedValue('secret-token')
    const res = await apiRequest({ path: '/api/status' })
    expect(res.status).toBe(401)
    expect((res.body as Record<string, unknown>).error).toBe('Unauthorized')
  })

  it('passes with correct Authorization: Bearer token', async () => {
    mockGetSetting.mockResolvedValue('secret-token')
    const res = await apiRequest({ path: '/api/status', headers: { Authorization: 'Bearer secret-token' } })
    expect(res.status).toBe(200)
  })

  it('passes with correct X-Colony-Token header', async () => {
    mockGetSetting.mockResolvedValue('secret-token')
    const res = await apiRequest({ path: '/api/status', headers: { 'X-Colony-Token': 'secret-token' } })
    expect(res.status).toBe(200)
  })

  it('returns 401 with wrong token', async () => {
    mockGetSetting.mockResolvedValue('secret-token')
    const res = await apiRequest({ path: '/api/status', headers: { Authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
  })
})

// --- GET /api/status ---

describe('GET /api/status', () => {
  it('returns ok:true with version and uptime', async () => {
    const res = await apiRequest({ path: '/api/status' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.version).toBe('1.2.3')
    expect(typeof body.uptime).toBe('number')
  })
})

// --- GET /api/sessions ---

describe('GET /api/sessions', () => {
  it('returns empty list when no instances', async () => {
    const res = await apiRequest({ path: '/api/sessions' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).sessions).toEqual([])
  })

  it('maps instance fields to session shape', async () => {
    mockGetAllInstances.mockResolvedValue([{
      id: 'inst-1', name: 'Test Session', status: 'running',
      tokenUsage: { cost: 0.05 }, createdAt: new Date(Date.now() - 5000).toISOString(),
    }])
    const res = await apiRequest({ path: '/api/sessions' })
    expect(res.status).toBe(200)
    const sessions = (res.body as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('inst-1')
    expect(sessions[0].name).toBe('Test Session')
    expect(sessions[0].status).toBe('running')
    expect(sessions[0].cost).toBe(0.05)
    expect(typeof sessions[0].uptime).toBe('number')
    expect((sessions[0].uptime as number)).toBeGreaterThan(0)
  })

  it('sets uptime:0 when createdAt is null', async () => {
    mockGetAllInstances.mockResolvedValue([{ id: 'i', name: 'S', status: 'stopped', tokenUsage: { cost: 0 }, createdAt: null }])
    const res = await apiRequest({ path: '/api/sessions' })
    const sessions = (res.body as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    expect(sessions[0].uptime).toBe(0)
  })
})

// --- GET /api/sessions/:id ---

describe('GET /api/sessions/:id', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({ path: '/api/sessions/nonexistent' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toBe('Session not found')
  })

  it('returns session by id', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({ path: '/api/sessions/inst-1' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).session).toMatchObject({ id: 'inst-1', name: 'My Session' })
  })

  it('returns session by name (URL-decoded)', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({ path: '/api/sessions/My%20Session' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).session).toMatchObject({ id: 'inst-1' })
  })
})

// --- POST /api/sessions ---

describe('POST /api/sessions', () => {
  it('creates a session with prompt and returns 201', async () => {
    mockCreateInstance.mockResolvedValue({ id: 'new-1', name: 'My New Session' })
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions',
      body: JSON.stringify({ prompt: 'Run the tests', name: 'My New Session' }),
    })
    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBe('new-1')
    expect(body.name).toBe('My New Session')
    expect(mockCreateInstance).toHaveBeenCalledWith(expect.objectContaining({ args: ['-p', 'Run the tests'] }))
  })

  it('creates a session without prompt (no -p arg)', async () => {
    mockCreateInstance.mockResolvedValue({ id: 'new-2', name: 'Unnamed' })
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const opts = mockCreateInstance.mock.calls[0][0] as Record<string, unknown>
    expect(opts.args).toBeUndefined()
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await apiRequest({ method: 'POST', path: '/api/sessions', body: 'not-json{' })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toBe('Invalid JSON body')
  })

  it('returns 400 when createInstance throws', async () => {
    mockCreateInstance.mockRejectedValue(new Error('Invalid working directory'))
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions',
      body: JSON.stringify({ prompt: 'test' }),
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toBe('Invalid working directory')
  })
})

// --- POST /api/sessions/:id/stop ---

describe('POST /api/sessions/:id/stop', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({ method: 'POST', path: '/api/sessions/ghost/stop' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toBe('Session not found')
  })

  it('kills the session and returns ok:true', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({ method: 'POST', path: '/api/sessions/inst-1/stop' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockKillInstance).toHaveBeenCalledWith('inst-1')
  })
})

// --- GET /api/sessions/:id/output ---

describe('GET /api/sessions/:id/output', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({ path: '/api/sessions/ghost/output' })
    expect(res.status).toBe(404)
  })

  it('returns buffer content', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    mockDaemonRouterObj.getInstanceBuffer.mockResolvedValue('$ npm test\n✓ all pass')
    const res = await apiRequest({ path: '/api/sessions/inst-1/output' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).output).toBe('$ npm test\n✓ all pass')
  })

  it('returns empty string when buffer unavailable', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    mockDaemonRouterObj.getInstanceBuffer.mockRejectedValue(new Error('no buffer'))
    const res = await apiRequest({ path: '/api/sessions/inst-1/output' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).output).toBe('')
  })
})

// --- DELETE /api/sessions/:id ---

describe('DELETE /api/sessions/:id', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({ method: 'DELETE', path: '/api/sessions/ghost' })
    expect(res.status).toBe(404)
  })

  it('returns 409 when session is still running', async () => {
    mockGetAllInstances.mockResolvedValue([{ ...INST, status: 'running' }])
    const res = await apiRequest({ method: 'DELETE', path: '/api/sessions/inst-1' })
    expect(res.status).toBe(409)
    expect((res.body as Record<string, unknown>).error).toContain('stop it first')
  })

  it('removes a stopped session and returns ok:true', async () => {
    mockGetAllInstances.mockResolvedValue([{ ...INST, status: 'stopped' }])
    const res = await apiRequest({ method: 'DELETE', path: '/api/sessions/inst-1' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockDaemonRouterObj.removeInstance).toHaveBeenCalledWith('inst-1')
  })

  it('returns 500 when removeInstance throws', async () => {
    mockGetAllInstances.mockResolvedValue([{ ...INST, status: 'stopped' }])
    mockDaemonRouterObj.removeInstance.mockRejectedValue(new Error('FS error'))
    const res = await apiRequest({ method: 'DELETE', path: '/api/sessions/inst-1' })
    expect(res.status).toBe(500)
    expect((res.body as Record<string, unknown>).error).toBe('FS error')
  })
})

// --- POST /api/sessions/:id/steer ---

describe('POST /api/sessions/:id/steer', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/ghost/steer',
      body: JSON.stringify({ prompt: 'hi' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 when prompt is missing', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/inst-1/steer',
      body: JSON.stringify({ other: 'field' }),
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toContain('prompt')
  })

  it('returns 400 for invalid JSON', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/inst-1/steer',
      body: '{bad json',
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toBe('Invalid JSON body')
  })

  it('calls steerInstance and returns ok:true', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/inst-1/steer',
      body: JSON.stringify({ prompt: 'Do something now' }),
    })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockDaemonRouterObj.steerInstance).toHaveBeenCalledWith('inst-1', 'Do something now')
  })

  it('returns 500 when steerInstance returns false', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    mockDaemonRouterObj.steerInstance.mockResolvedValue(false)
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/inst-1/steer',
      body: JSON.stringify({ prompt: 'test' }),
    })
    expect(res.status).toBe(500)
    expect((res.body as Record<string, unknown>).ok).toBe(false)
  })
})

// --- POST /api/sessions/:id/whisper ---

describe('POST /api/sessions/:id/whisper', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/ghost/whisper',
      body: JSON.stringify({ prompt: 'hello' }),
    })
    expect(res.status).toBe(404)
  })

  it('delegates to steerInstance and returns ok', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    const res = await apiRequest({
      method: 'POST', path: '/api/sessions/inst-1/whisper',
      body: JSON.stringify({ prompt: 'whisper this' }),
    })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockDaemonRouterObj.steerInstance).toHaveBeenCalledWith('inst-1', 'whisper this')
  })
})

// --- GET /api/pipelines ---

describe('GET /api/pipelines', () => {
  it('returns empty list', async () => {
    const res = await apiRequest({ path: '/api/pipelines' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).pipelines).toEqual([])
  })

  it('returns pipeline list from engine', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'Automated PR Review', enabled: true }])
    const res = await apiRequest({ path: '/api/pipelines' })
    expect(res.status).toBe(200)
    const pipelines = (res.body as Record<string, unknown>).pipelines as Array<Record<string, unknown>>
    expect(pipelines).toHaveLength(1)
    expect(pipelines[0].name).toBe('Automated PR Review')
  })
})

// --- POST /api/pipelines/:name/trigger ---

describe('POST /api/pipelines/:name/trigger', () => {
  it('returns 404 when pipeline not found', async () => {
    mockTriggerPollNow.mockReturnValue(false)
    const res = await apiRequest({ method: 'POST', path: '/api/pipelines/no-such-pipe/trigger' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toContain('no-such-pipe')
  })

  it('triggers pipeline and returns ok:true', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    const res = await apiRequest({ method: 'POST', path: '/api/pipelines/my-pipeline/trigger' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockTriggerPollNow).toHaveBeenCalledWith('my-pipeline')
  })

  it('URL-decodes pipeline name', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    await apiRequest({ method: 'POST', path: '/api/pipelines/My%20Pipeline/trigger' })
    expect(mockTriggerPollNow).toHaveBeenCalledWith('My Pipeline')
  })

  it('passes overrides when body contains prompt/model', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/my-pipeline/trigger',
      body: JSON.stringify({ prompt: 'custom prompt', model: 'claude-opus-4-7', maxBudget: 5 }),
    })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).overrides).toMatchObject({ prompt: 'custom prompt', model: 'claude-opus-4-7', maxBudget: 5 })
    expect(mockTriggerPollNow).toHaveBeenCalledWith('my-pipeline', { prompt: 'custom prompt', model: 'claude-opus-4-7', maxBudget: 5 })
  })

  it('maps vars to templateVarOverrides', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    await apiRequest({
      method: 'POST',
      path: '/api/pipelines/my-pipeline/trigger',
      body: JSON.stringify({ vars: { branch: 'main', env: 'prod' } }),
    })
    expect(mockTriggerPollNow).toHaveBeenCalledWith('my-pipeline', { templateVarOverrides: { branch: 'main', env: 'prod' } })
  })

  it('clamps maxBudget to 0.01–100', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    await apiRequest({ method: 'POST', path: '/api/pipelines/my-pipeline/trigger', body: JSON.stringify({ maxBudget: 9999 }) })
    expect(mockTriggerPollNow).toHaveBeenCalledWith('my-pipeline', { maxBudget: 100 })
  })

  it('returns 400 when vars contains non-string value', async () => {
    mockTriggerPollNow.mockReturnValue(true)
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/my-pipeline/trigger',
      body: JSON.stringify({ vars: { count: 42 } }),
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toContain('vars.count')
  })

  it('returns 400 for invalid JSON body', async () => {
    const res = await apiRequest({ method: 'POST', path: '/api/pipelines/my-pipeline/trigger', body: 'not-json' })
    expect(res.status).toBe(400)
  })
})

// --- GET /api/personas ---

describe('GET /api/personas', () => {
  it('returns empty list when no personas', async () => {
    const res = await apiRequest({ path: '/api/personas' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).personas).toEqual([])
  })

  it('maps persona fields including active flag', async () => {
    mockGetPersonaList.mockReturnValue([
      { id: 'p1', name: 'Colony Developer', enabled: true, model: 'sonnet', schedule: '*/15 * * * *', lastRun: null, runCount: 42, activeSessionId: 'sess-42' },
      { id: 'p2', name: 'Colony QA', enabled: false, model: 'sonnet', schedule: '*/40 * * * *', lastRun: null, runCount: 5, activeSessionId: null },
    ])
    const res = await apiRequest({ path: '/api/personas' })
    expect(res.status).toBe(200)
    const personas = (res.body as Record<string, unknown>).personas as Array<Record<string, unknown>>
    expect(personas).toHaveLength(2)
    expect(personas[0].active).toBe(true)
    expect(personas[0].runCount).toBe(42)
    expect(personas[1].active).toBe(false)
  })
})

// --- POST /api/personas/:id/trigger ---

describe('POST /api/personas/:id/trigger', () => {
  it('returns 404 when persona not found', async () => {
    const res = await apiRequest({ method: 'POST', path: '/api/personas/ghost/trigger' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toContain('ghost')
  })

  it('triggers persona without message and returns 202', async () => {
    mockGetPersonaList.mockReturnValue([
      { id: 'p1', name: 'Colony Developer', enabled: true, model: 'sonnet', schedule: null, lastRun: null, runCount: 0, activeSessionId: null },
    ])
    const res = await apiRequest({ method: 'POST', path: '/api/personas/p1/trigger' })
    expect(res.status).toBe(202)
    expect((res.body as Record<string, unknown>).ok).toBe(true)
    expect(mockRunPersona).toHaveBeenCalledWith('p1', { type: 'manual' }, undefined)
  })

  it('passes message body to runPersona', async () => {
    mockGetPersonaList.mockReturnValue([
      { id: 'p1', name: 'Colony Developer', enabled: true, model: 'sonnet', schedule: null, lastRun: null, runCount: 0, activeSessionId: null },
    ])
    const res = await apiRequest({
      method: 'POST', path: '/api/personas/p1/trigger',
      body: JSON.stringify({ message: 'Focus on auth today' }),
    })
    expect(res.status).toBe(202)
    expect(mockRunPersona).toHaveBeenCalledWith('p1', { type: 'manual' }, 'Focus on auth today')
  })

  it('matches persona by name', async () => {
    mockGetPersonaList.mockReturnValue([
      { id: 'p1', name: 'Colony Developer', enabled: true, model: 'sonnet', schedule: null, lastRun: null, runCount: 0, activeSessionId: null },
    ])
    const res = await apiRequest({ method: 'POST', path: '/api/personas/Colony%20Developer/trigger' })
    expect(res.status).toBe(202)
    expect(mockRunPersona).toHaveBeenCalledWith('p1', { type: 'manual' }, undefined)
  })
})

// --- GET /api/events (SSE) ---

describe('GET /api/events SSE', () => {
  it('responds with text/event-stream and initial connected event', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/api/events' },
        (res) => {
          try {
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toBe('text/event-stream')
          } catch (e) { req.destroy(); reject(e); return }
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
            if (data.includes('connected')) {
              try { expect(data).toContain('"channel":"connected"'); req.destroy(); resolve() }
              catch (e) { req.destroy(); reject(e) }
            }
          })
        },
      )
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
      req.end()
    })
  })
})

// --- GET /api/sessions/:id/stream (SSE) ---

describe('GET /api/sessions/:id/stream SSE', () => {
  it('returns 404 when session not found', async () => {
    const res = await apiRequest({ path: '/api/sessions/ghost/stream' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toBe('Session not found')
  })

  it('responds with text/event-stream and sends initial buffer', async () => {
    mockGetAllInstances.mockResolvedValue([INST])
    mockDaemonRouterObj.getInstanceBuffer.mockResolvedValue('initial PTY output')
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: '/api/sessions/inst-1/stream' },
        (res) => {
          try {
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toBe('text/event-stream')
          } catch (e) { req.destroy(); reject(e); return }
          let data = ''
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString()
            if (data.includes('initial PTY output')) {
              try { expect(data).toContain('event: output'); req.destroy(); resolve() }
              catch (e) { req.destroy(); reject(e) }
            }
          })
        },
      )
      req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
      req.end()
    })
  })
})

// --- GET /api/openapi.json ---

describe('GET /api/openapi.json', () => {
  it('returns valid OpenAPI 3.0 spec', async () => {
    const res = await apiRequest({ path: '/api/openapi.json' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const spec = res.body as Record<string, unknown>
    expect(spec.openapi).toBe('3.0.3')
    expect((spec.info as Record<string, unknown>).title).toBe('Colony API')
    expect(spec.paths).toBeDefined()
  })

  it('includes all major endpoint paths', async () => {
    const res = await apiRequest({ path: '/api/openapi.json' })
    const paths = Object.keys((res.body as Record<string, unknown>).paths as Record<string, unknown>)
    expect(paths).toContain('/api/status')
    expect(paths).toContain('/api/sessions')
    expect(paths).toContain('/api/pipelines/{name}/trigger')
    expect(paths).toContain('/api/personas/{id}/trigger')
    expect(paths).toContain('/api/sessions/{id}/stream')
  })

  it('sets Access-Control-Allow-Origin header', async () => {
    const res = await apiRequest({ path: '/api/openapi.json' })
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })
})

// --- GET /api/docs ---

describe('GET /api/docs', () => {
  it('returns HTML page with Swagger UI', async () => {
    const res = await apiRequest({ path: '/api/docs' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body as string).toContain('swagger-ui')
    expect(res.body as string).toContain('/api/openapi.json')
  })
})

// --- Unknown routes ---

describe('Unknown /api/* routes', () => {
  it('returns 404 for unknown path', async () => {
    const res = await apiRequest({ path: '/api/unknown-endpoint' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toBe('Not Found')
  })
})

// --- GET /api/pipelines/:name/runs (#593) ---

const RUN_A = { firedAt: '2026-05-01T10:00:00Z', success: true, durationMs: 100 }
const RUN_B = { firedAt: '2026-05-01T12:00:00Z', success: false, durationMs: 200 }
const RUN_C = { firedAt: '2026-05-01T14:00:00Z', success: true, durationMs: 150 }

describe('GET /api/pipelines/:name/runs', () => {
  it('returns 404 when pipeline not found', async () => {
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/pipelines/missing/runs' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toContain('missing')
  })

  it('returns empty runs array when no history', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([])
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.pipeline).toBe('my-pipe')
    expect(body.runs).toEqual([])
  })

  it('returns runs newest-first', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([RUN_A, RUN_B, RUN_C])
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs' })
    expect(res.status).toBe(200)
    const runs = (res.body as Record<string, unknown>).runs as typeof RUN_A[]
    expect(runs[0].firedAt).toBe(RUN_C.firedAt)
    expect(runs[1].firedAt).toBe(RUN_B.firedAt)
    expect(runs[2].firedAt).toBe(RUN_A.firedAt)
  })

  it('respects ?limit parameter', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([RUN_A, RUN_B, RUN_C])
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs?limit=2' })
    expect(res.status).toBe(200)
    const runs = (res.body as Record<string, unknown>).runs as unknown[]
    expect(runs).toHaveLength(2)
    expect((runs[0] as typeof RUN_A).firedAt).toBe(RUN_C.firedAt)
  })

  it('clamps limit to max 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ firedAt: `2026-05-01T${String(i).padStart(2, '0')}:00:00Z`, success: true }))
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue(many)
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs?limit=99' })
    expect(res.status).toBe(200)
    expect(((res.body as Record<string, unknown>).runs as unknown[]).length).toBeLessThanOrEqual(20)
  })

  it('URL-decodes pipeline name', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([RUN_A])
    const res = await apiRequest({ path: '/api/pipelines/my%20pipe/runs' })
    expect(res.status).toBe(200)
    expect(mockGetHistory).toHaveBeenCalledWith('my pipe')
  })
})

// --- GET /api/pipelines/:name/runs/latest (#593) ---

describe('GET /api/pipelines/:name/runs/latest', () => {
  it('returns 404 when pipeline not found', async () => {
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/pipelines/missing/runs/latest' })
    expect(res.status).toBe(404)
  })

  it('returns 404 when no runs recorded', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([])
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs/latest' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toContain('No runs')
  })

  it('returns last element (most recent run)', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'my-pipe', enabled: true }])
    mockGetHistory.mockResolvedValue([RUN_A, RUN_B, RUN_C])
    const res = await apiRequest({ path: '/api/pipelines/my-pipe/runs/latest' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.pipeline).toBe('my-pipe')
    expect((body.run as typeof RUN_C).firedAt).toBe(RUN_C.firedAt)
  })
})

// --- GET /api/health (#594) ---

const HEALTHY_PERSONA = {
  id: 'p1', name: 'Dev', enabled: true, activeSessionId: null,
  lastRun: null, runCount: 5,
  healthScore: { consecutiveFailures: 0, successRate: 1, lastCheck: null },
}

describe('GET /api/health', () => {
  it('returns 200 with required top-level keys', async () => {
    mockGetPersonaList.mockReturnValue([HEALTHY_PERSONA])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBeDefined()
    expect(body.personas).toBeDefined()
    expect(body.pipelines).toBeDefined()
    expect(body.sessions).toBeDefined()
    expect(body.uptime_seconds).toBeTypeOf('number')
    expect(body.version).toBe('1.2.3')
  })

  it('sets Cache-Control: max-age=10', async () => {
    mockGetPersonaList.mockReturnValue([])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect(res.headers['cache-control']).toBe('max-age=10')
  })

  it('sets Access-Control-Allow-Origin: *', async () => {
    mockGetPersonaList.mockReturnValue([])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('reports healthy status when no consecutive failures', async () => {
    mockGetPersonaList.mockReturnValue([HEALTHY_PERSONA])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect((res.body as Record<string, unknown>).status).toBe('healthy')
  })

  it('reports degraded when 1-2 consecutive failures', async () => {
    const degraded = { ...HEALTHY_PERSONA, healthScore: { consecutiveFailures: 1, successRate: 0.5, lastCheck: null } }
    mockGetPersonaList.mockReturnValue([degraded])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect((res.body as Record<string, unknown>).status).toBe('degraded')
  })

  it('reports unhealthy when 3+ consecutive failures', async () => {
    const unhealthy = { ...HEALTHY_PERSONA, healthScore: { consecutiveFailures: 3, successRate: 0, lastCheck: null } }
    mockGetPersonaList.mockReturnValue([unhealthy])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    expect((res.body as Record<string, unknown>).status).toBe('unhealthy')
  })

  it('personas payload includes totals + enabled + active counts', async () => {
    const active = { ...HEALTHY_PERSONA, id: 'p2', activeSessionId: 'sess-1' }
    const disabled = { ...HEALTHY_PERSONA, id: 'p3', enabled: false }
    mockGetPersonaList.mockReturnValue([HEALTHY_PERSONA, active, disabled])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    const personas = (res.body as Record<string, unknown>).personas as Record<string, unknown>
    expect(personas.total).toBe(3)
    expect(personas.enabled).toBe(2)
    expect(personas.active).toBe(1)
    expect(Array.isArray(personas.details)).toBe(true)
  })

  it('pipelines payload includes totals + enabled counts', async () => {
    mockGetPersonaList.mockReturnValue([])
    mockGetPipelineList.mockReturnValue([
      { name: 'p1', enabled: true, lastFiredAt: null, fireCount: 0 },
      { name: 'p2', enabled: false, lastFiredAt: null, fireCount: 0 },
    ])
    mockGetHistory.mockResolvedValue([])
    const res = await apiRequest({ path: '/api/health' })
    const pipelines = (res.body as Record<string, unknown>).pipelines as Record<string, unknown>
    expect(pipelines.total).toBe(2)
    expect(pipelines.enabled).toBe(1)
    expect(Array.isArray(pipelines.details)).toBe(true)
  })

  it('sessions payload includes running/stopped/errored', async () => {
    mockGetAllInstances.mockResolvedValue([
      { id: '1', status: 'running' },
      { id: '2', status: 'running' },
      { id: '3', status: 'exited' },
    ])
    mockGetPersonaList.mockReturnValue([])
    mockGetPipelineList.mockReturnValue([])
    const res = await apiRequest({ path: '/api/health' })
    const sessions = (res.body as Record<string, unknown>).sessions as Record<string, unknown>
    expect(sessions.running).toBe(2)
    expect(sessions.stopped).toBe(1)
    expect(sessions.errored).toBe(0)
  })
})

// --- POST /webhook/:slug — extractGitHubVars enrichment (#592) ---

function makeGithubSig(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
}

const GITHUB_TRIGGER = {
  name: 'github-pipe',
  slug: 'gh-hook',
  trigger: { type: 'webhook', source: 'github', secret: 'test-secret' },
}

async function postWebhook(eventType: string, payload: object): Promise<{ status: number; body: unknown }> {
  const bodyStr = JSON.stringify(payload)
  const sig = makeGithubSig(GITHUB_TRIGGER.trigger.secret, bodyStr)
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(bodyStr, 'utf8')
    const req = http.request(
      {
        hostname: '127.0.0.1', port, method: 'POST',
        path: `/webhook/${GITHUB_TRIGGER.slug}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length.toString(),
          'x-github-event': eventType,
          'x-hub-signature-256': sig,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown
          try { body = JSON.parse(text) } catch { body = text }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

describe('POST /webhook/:slug — extractGitHubVars enrichment', () => {
  beforeEach(() => {
    mockGetWebhookTriggers.mockReturnValue([GITHUB_TRIGGER])
  })

  it('enriches push event with github_event, github_repo, github_branch, github_commit, github_pusher', async () => {
    const payload = {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app' },
      sender: { login: 'fabio' },
      head_commit: { id: 'abc123', message: 'fix: something' },
      pusher: { name: 'fabio' },
    }
    await postWebhook('push', payload)
    expect(mockFireWebhookPipeline).toHaveBeenCalledOnce()
    const overrides = mockFireWebhookPipeline.mock.calls[0][2]
    const vars = overrides?.templateVarOverrides
    expect(vars?.github_event).toBe('push')
    expect(vars?.github_repo).toBe('acme/app')
    expect(vars?.github_sender).toBe('fabio')
    expect(vars?.github_branch).toBe('main')
    expect(vars?.github_commit).toBe('abc123')
    expect(vars?.github_commit_message).toBe('fix: something')
    expect(vars?.github_pusher).toBe('fabio')
  })

  it('enriches push event with tag: prefix for tag refs', async () => {
    const payload = {
      ref: 'refs/tags/v1.2.3',
      repository: { full_name: 'acme/app' },
      sender: { login: 'bot' },
      head_commit: { id: 'def456', message: 'chore: release' },
      pusher: { name: 'bot' },
    }
    await postWebhook('push', payload)
    const vars = mockFireWebhookPipeline.mock.calls[0][2]?.templateVarOverrides
    expect(vars?.github_branch).toBe('tag:v1.2.3')
  })

  it('enriches pull_request event with pr fields', async () => {
    const payload = {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      sender: { login: 'dev' },
      pull_request: {
        number: 42,
        title: 'feat: new thing',
        html_url: 'https://github.com/acme/app/pull/42',
        head: { ref: 'feat/new-thing' },
        base: { ref: 'main' },
        user: { login: 'dev' },
      },
    }
    await postWebhook('pull_request', payload)
    const vars = mockFireWebhookPipeline.mock.calls[0][2]?.templateVarOverrides
    expect(vars?.github_event).toBe('pull_request')
    expect(vars?.github_action).toBe('opened')
    expect(vars?.github_pr_number).toBe('42')
    expect(vars?.github_pr_title).toBe('feat: new thing')
    expect(vars?.github_pr_branch).toBe('feat/new-thing')
    expect(vars?.github_pr_base).toBe('main')
    expect(vars?.github_pr_author).toBe('dev')
    expect(vars?.github_pr_url).toBe('https://github.com/acme/app/pull/42')
  })

  it('enriches issues event with issue fields', async () => {
    const payload = {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      sender: { login: 'reporter' },
      issue: {
        number: 99,
        title: 'Bug: something broken',
        user: { login: 'reporter' },
      },
    }
    await postWebhook('issues', payload)
    const vars = mockFireWebhookPipeline.mock.calls[0][2]?.templateVarOverrides
    expect(vars?.github_event).toBe('issues')
    expect(vars?.github_action).toBe('opened')
    expect(vars?.github_issue_number).toBe('99')
    expect(vars?.github_issue_title).toBe('Bug: something broken')
    expect(vars?.github_issue_author).toBe('reporter')
  })

  it('passes no overrides for unknown event types', async () => {
    const payload = { repository: { full_name: 'acme/app' }, sender: { login: 'bot' } }
    await postWebhook('star', payload)
    const overrides = mockFireWebhookPipeline.mock.calls[0][2]
    // github_event + github_repo + github_sender are always extracted — so overrides exist
    // but no event-specific fields
    const vars = overrides?.templateVarOverrides
    expect(vars?.github_event).toBe('star')
    expect(vars?.github_pr_number).toBeUndefined()
    expect(vars?.github_issue_number).toBeUndefined()
    expect(vars?.github_branch).toBeUndefined()
  })

  it('truncates commit_message to 200 chars', async () => {
    const longMsg = 'x'.repeat(300)
    const payload = {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/app' },
      sender: { login: 'bot' },
      head_commit: { id: 'aaa', message: longMsg },
      pusher: { name: 'bot' },
    }
    await postWebhook('push', payload)
    const vars = mockFireWebhookPipeline.mock.calls[0][2]?.templateVarOverrides
    expect(vars?.github_commit_message?.length).toBe(200)
  })
})

describe('POST /api/pipelines/validate (#597)', () => {
  it('returns 200 valid=true for valid YAML', async () => {
    mockValidatePipelineYaml.mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: [],
      def: { name: 'My Pipe', trigger: { type: 'cron' }, action: { type: 'launch-session' } },
    })
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/validate',
      body: JSON.stringify({ yaml: 'name: My Pipe\nenabled: true' }),
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.valid).toBe(true)
    expect(body.pipeline).toMatchObject({ name: 'My Pipe', trigger: { type: 'cron' } })
    expect(body.errors).toBeUndefined()
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  it('returns 200 valid=false with errors for invalid YAML', async () => {
    mockValidatePipelineYaml.mockReturnValueOnce({
      valid: false,
      errors: ['Missing required field: name'],
      warnings: [],
      def: null,
    })
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/validate',
      body: JSON.stringify({ yaml: 'enabled: true' }),
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.valid).toBe(false)
    expect(body.pipeline).toBeNull()
    expect(Array.isArray(body.errors)).toBe(true)
    expect((body.errors as string[])[0]).toContain('name')
  })

  it('returns 400 when body is not valid JSON', async () => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/validate',
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toMatch(/JSON/)
  })

  it('returns 400 when yaml field is missing from body', async () => {
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/validate',
      body: JSON.stringify({ content: 'oops' }),
    })
    expect(res.status).toBe(400)
    expect((res.body as Record<string, unknown>).error).toMatch(/yaml.*string/i)
  })

  it('includes warnings when validatePipelineYaml emits them', async () => {
    mockValidatePipelineYaml.mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: ['trigger.repos auto may be slow'],
      def: { name: 'Warn Pipe', trigger: { type: 'git-poll' }, action: { type: 'launch-session' } },
    })
    const res = await apiRequest({
      method: 'POST',
      path: '/api/pipelines/validate',
      body: JSON.stringify({ yaml: 'name: Warn Pipe\nenabled: true' }),
    })
    const body = res.body as Record<string, unknown>
    expect(body.valid).toBe(true)
    expect((body.warnings as string[]).length).toBeGreaterThan(0)
  })
})

describe('GET /api/pipelines/:name/preview (#596)', () => {
  it('returns 404 when pipeline is not in list', async () => {
    mockGetPipelineList.mockReturnValueOnce([])
    const res = await apiRequest({ path: '/api/pipelines/Unknown%20Pipe/preview' })
    expect(res.status).toBe(404)
    expect((res.body as Record<string, unknown>).error).toMatch(/not found/i)
  })

  it('returns 200 with preview result for known pipeline', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'My Pipe', enabled: true, schedule: null }])
    mockPreviewPipeline.mockResolvedValueOnce({
      wouldFire: true,
      matches: [{ repo: 'acme/app', pr: 42 }],
      conditionLog: ['[08:00:00] Would fire'],
    })
    const res = await apiRequest({ path: '/api/pipelines/My%20Pipe/preview' })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.pipeline).toBe('My Pipe')
    expect(body.wouldFire).toBe(true)
    expect(Array.isArray(body.conditionLog)).toBe(true)
  })

  it('returns 500 when previewPipeline throws', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'Boom Pipe', enabled: true, schedule: null }])
    mockPreviewPipeline.mockRejectedValueOnce(new Error('gh auth failed'))
    const res = await apiRequest({ path: '/api/pipelines/Boom%20Pipe/preview' })
    expect(res.status).toBe(500)
    expect((res.body as Record<string, unknown>).error).toMatch(/Preview failed/)
  })

  it('URL-decodes pipeline name', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'My Pipe', enabled: true, schedule: null }])
    mockPreviewPipeline.mockResolvedValueOnce({ wouldFire: false, matches: [], conditionLog: [] })
    await apiRequest({ path: '/api/pipelines/My%20Pipe/preview' })
    expect(mockPreviewPipeline).toHaveBeenCalledWith('My Pipe')
  })
})

describe('PipelineRunEntry.webhookDeliveries in run history (#595)', () => {
  it('run history passes through webhookDeliveries array', async () => {
    const delivery = {
      url: 'https://hooks.example.com/notify',
      status: 200,
      attempt: 1,
      latencyMs: 42,
      ok: true,
    }
    mockGetPipelineList.mockReturnValue([{ name: 'Hook Pipe', enabled: true, schedule: null }])
    mockGetHistory.mockResolvedValueOnce([
      {
        startedAt: '2026-05-04T00:00:00Z',
        success: true,
        durationMs: 1000,
        triggeredBy: 'cron',
        webhookDeliveries: [delivery],
      },
    ])
    const res = await apiRequest({ path: '/api/pipelines/Hook%20Pipe/runs' })
    expect(res.status).toBe(200)
    const body = res.body as { runs: Array<Record<string, unknown>> }
    expect(body.runs[0].webhookDeliveries).toEqual([delivery])
  })

  it('run history omits webhookDeliveries when field absent', async () => {
    mockGetPipelineList.mockReturnValue([{ name: 'Hook Pipe', enabled: true, schedule: null }])
    mockGetHistory.mockResolvedValueOnce([
      { startedAt: '2026-05-04T00:00:00Z', success: true, durationMs: 500, triggeredBy: 'cron' },
    ])
    const res = await apiRequest({ path: '/api/pipelines/Hook%20Pipe/runs' })
    expect(res.status).toBe(200)
    const body = res.body as { runs: Array<Record<string, unknown>> }
    expect(body.runs[0].webhookDeliveries).toBeUndefined()
  })
})
