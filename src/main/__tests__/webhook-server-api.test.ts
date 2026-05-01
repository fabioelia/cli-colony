/**
 * Integration tests for webhook-server REST API routes (/api/*).
 * Starts a real HTTP server on a random port to test the full request/response cycle.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'

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
vi.mock('../pipeline-engine', () => ({
  getPipelineList: mockGetPipelineList,
  triggerPollNow: mockTriggerPollNow,
  fireWebhookPipeline: vi.fn(),
  getWebhookTriggers: vi.fn().mockReturnValue([]),
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
