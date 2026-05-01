/**
 * Webhook + REST API HTTP server for Colony.
 *
 * Webhook routes: POST /webhook/<slug> → fire matching pipeline
 * REST API routes: /api/* → session/pipeline management + SSE event stream
 *
 * GitHub source: verifies X-Hub-Signature-256 (HMAC-SHA256 of raw body)
 * Generic source: verifies Authorization: Bearer <secret> or X-Colony-Token: <secret>
 * API routes: Bearer/X-Colony-Token required when `apiToken` setting is configured
 */

import { app } from 'electron'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { fireWebhookPipeline, getWebhookTriggers, getPipelineList, triggerPollNow } from './pipeline-engine'
import { getAllInstances, createInstance, killInstance } from './instance-manager'
import { getDaemonRouter } from './daemon-router'
import { getSetting } from './settings'
import { addBroadcastListener } from './broadcast'
import { getPersonaList, runPersona, addWhisper } from './persona-manager'

const PREFIX = '[webhook-server]'

let server: Server | null = null
let serverUrl: string | null = null

// SSE client tracking
const MAX_SSE_CLIENTS = 5
const _sseClients = new Set<ServerResponse>()

// Per-session SSE stream tracking: sessionId → Set of response objects
const MAX_STREAM_CLIENTS_PER_SESSION = 5
const _streamClients = new Map<string, Set<ServerResponse>>()

// Rate limiting for POST /api/sessions (5 per minute)
const _sessionCreateTimestamps: number[] = []
const SESSION_CREATE_RATE_LIMIT = 5
const SESSION_CREATE_WINDOW_MS = 60_000

// Relay all broadcast events to global SSE clients and per-session stream clients
addBroadcastListener((channel, ...args) => {
  if (_sseClients.size === 0 && _streamClients.size === 0) return
  if (_sseClients.size > 0) {
    const event = JSON.stringify({ channel, data: args.length === 1 ? args[0] : args })
    for (const res of _sseClients) {
      try {
        res.write(`data: ${event}\n\n`)
      } catch { /* client disconnected */ }
    }
  }
  if (channel === 'instance:output' && _streamClients.size > 0) {
    const payload = args[0] as { id: string; data: string }
    const clients = _streamClients.get(payload.id)
    if (clients && clients.size > 0) {
      const msg = `event: output\ndata: ${JSON.stringify({ text: payload.data })}\n\n`
      for (const res of clients) {
        try { res.write(msg) } catch { /* client disconnected */ }
      }
    }
  }
  if (channel === 'instance:exited' && _streamClients.size > 0) {
    const payload = args[0] as { id: string; exitCode?: number }
    const clients = _streamClients.get(payload.id)
    if (clients && clients.size > 0) {
      const msg = `event: exit\ndata: ${JSON.stringify({ code: payload.exitCode ?? null })}\n\n`
      for (const res of clients) {
        try { res.write(msg) } catch { /* already closed */ }
        try { res.end() } catch { /* already closed */ }
      }
      _streamClients.delete(payload.id)
    }
  }
})

function log(msg: string): void {
  console.log(`${PREFIX} ${msg}`)
}

const MAX_BODY_BYTES = 1_048_576 // 1 MB

/** Return raw body bytes from an incoming request. Rejects if body exceeds 1 MB. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('Body exceeds maximum size'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Verify GitHub HMAC-SHA256 signature.
 * Header: X-Hub-Signature-256: sha256=<hex>
 */
export function verifyGitHubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(header, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Constant-time string comparison. Returns false for different lengths (no timing leak on length). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify generic bearer token.
 * Accepts: Authorization: Bearer <secret>  or  X-Colony-Token: <secret>
 */
export function verifyGenericToken(secret: string, req: IncomingMessage): boolean {
  const authHeader = req.headers['authorization']
  if (authHeader) {
    if (safeEqual(authHeader, `Bearer ${secret}`)) return true
  }
  const colonyToken = req.headers['x-colony-token']
  if (typeof colonyToken === 'string' && safeEqual(colonyToken, secret)) return true
  return false
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Check API auth — required only when `apiToken` setting is configured. */
async function checkApiAuth(req: IncomingMessage): Promise<boolean> {
  const token = await getSetting('apiToken')
  if (!token) return true
  return verifyGenericToken(token, req)
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/'
  const method = req.method || 'GET'

  if (!await checkApiAuth(req)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }

  // GET /api/events — SSE stream
  if (method === 'GET' && url === '/api/events') {
    if (_sseClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { error: 'Too many SSE connections' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('data: {"channel":"connected"}\n\n')
    _sseClients.add(res)
    req.on('close', () => _sseClients.delete(res))
    return
  }

  // GET /api/status
  if (method === 'GET' && url === '/api/status') {
    sendJson(res, 200, { ok: true, version: app.getVersion(), uptime: Math.floor(process.uptime()) })
    return
  }

  // GET /api/sessions
  if (method === 'GET' && url === '/api/sessions') {
    const instances = await getAllInstances()
    const now = Date.now()
    const sessions = instances.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      cost: i.tokenUsage.cost,
      uptime: i.createdAt ? now - new Date(i.createdAt).getTime() : 0,
    }))
    sendJson(res, 200, { sessions })
    return
  }

  // POST /api/sessions/:id/steer — must be checked before GET /api/sessions/:id
  const steerMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/steer$/)
  if (method === 'POST' && steerMatch) {
    const idOrName = decodeURIComponent(steerMatch[1])
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown } = {}
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = parsed.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      sendJson(res, 400, { error: 'Missing required field: prompt' })
      return
    }
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const ok = await getDaemonRouter().steerInstance(inst.id, prompt)
    sendJson(res, ok ? 200 : 500, { ok })
    return
  }

  // GET /api/sessions/:id/stream — SSE stream of PTY output for a specific session
  const streamMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/stream$/)
  if (method === 'GET' && streamMatch) {
    const idOrName = decodeURIComponent(streamMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const existing = _streamClients.get(inst.id)
    if (existing && existing.size >= MAX_STREAM_CLIENTS_PER_SESSION) {
      sendJson(res, 503, { error: 'Too many stream connections for this session' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Send current buffer as initial burst
    let initialBuffer = ''
    try {
      initialBuffer = await getDaemonRouter().getInstanceBuffer(inst.id)
    } catch { /* no buffer — ok */ }
    const MAX_INITIAL_CHUNK = 65_536
    if (initialBuffer.length > 0) {
      let offset = 0
      while (offset < initialBuffer.length) {
        const chunk = initialBuffer.slice(offset, offset + MAX_INITIAL_CHUNK)
        res.write(`event: output\ndata: ${JSON.stringify({ text: chunk })}\n\n`)
        offset += MAX_INITIAL_CHUNK
      }
    }
    if (!_streamClients.has(inst.id)) _streamClients.set(inst.id, new Set())
    _streamClients.get(inst.id)!.add(res)
    // Keepalive ping every 30s
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n') } catch { clearInterval(keepalive) }
    }, 30_000)
    req.on('close', () => {
      clearInterval(keepalive)
      const set = _streamClients.get(inst.id)
      if (set) {
        set.delete(res)
        if (set.size === 0) _streamClients.delete(inst.id)
      }
    })
    return
  }

  // GET /api/sessions/:id
  const sessionMatch = url.match(/^\/api\/sessions\/([^/?#]+)$/)
  if (method === 'GET' && sessionMatch) {
    const idOrName = decodeURIComponent(sessionMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    sendJson(res, 200, { session: inst })
    return
  }

  // GET /api/pipelines
  if (method === 'GET' && url === '/api/pipelines') {
    const pipelines = getPipelineList()
    sendJson(res, 200, { pipelines })
    return
  }

  // POST /api/pipelines/:name/trigger
  const pipelineMatch = url.match(/^\/api\/pipelines\/([^/?#]+)\/trigger$/)
  if (method === 'POST' && pipelineMatch) {
    const name = decodeURIComponent(pipelineMatch[1])
    let overrides: import('./pipeline-engine').RunOverrides | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
        overrides = {}
        if (typeof parsed.prompt === 'string') overrides.prompt = parsed.prompt
        if (typeof parsed.model === 'string') overrides.model = parsed.model
        if (typeof parsed.workingDirectory === 'string') overrides.workingDirectory = parsed.workingDirectory
        if (typeof parsed.maxBudget === 'number') {
          overrides.maxBudget = Math.min(100, Math.max(0.01, parsed.maxBudget))
        }
        if (parsed.vars !== undefined) {
          if (typeof parsed.vars !== 'object' || parsed.vars === null || Array.isArray(parsed.vars)) {
            sendJson(res, 400, { error: 'vars must be an object with string values' })
            return
          }
          const vars = parsed.vars as Record<string, unknown>
          for (const [k, v] of Object.entries(vars)) {
            if (typeof v !== 'string') {
              sendJson(res, 400, { error: `vars.${k} must be a string` })
              return
            }
          }
          overrides.templateVarOverrides = vars as Record<string, string>
        }
        if (Object.keys(overrides).length === 0) overrides = undefined
      }
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const ok = overrides ? triggerPollNow(name, overrides) : triggerPollNow(name)
    if (!ok) {
      sendJson(res, 404, { error: `Pipeline not found: ${name}` })
      return
    }
    sendJson(res, 200, { ok: true, pipeline: name, overrides: overrides ?? {} })
    return
  }

  // GET /api/personas
  if (method === 'GET' && url === '/api/personas') {
    const personas = getPersonaList().map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      model: p.model,
      schedule: p.schedule,
      lastRun: p.lastRun,
      runCount: p.runCount,
      active: p.activeSessionId !== null,
    }))
    sendJson(res, 200, { personas })
    return
  }

  // POST /api/personas/:id/trigger
  const personaTriggerMatch = url.match(/^\/api\/personas\/([^/?#]+)\/trigger$/)
  if (method === 'POST' && personaTriggerMatch) {
    const idOrName = decodeURIComponent(personaTriggerMatch[1])
    const personas = getPersonaList()
    const persona = personas.find((p) => p.id === idOrName || p.name === idOrName)
    if (!persona) {
      sendJson(res, 404, { error: `Persona not found: ${idOrName}` })
      return
    }
    let message: string | undefined
    try {
      const body = await readBody(req)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown }
        if (typeof parsed.message === 'string') message = parsed.message
      }
    } catch { /* empty body or non-JSON — run without message */ }
    runPersona(persona.id, { type: 'manual' }, message).catch((err) => {
      log(`runPersona(${persona.id}) failed: ${err}`)
    })
    sendJson(res, 202, { ok: true, persona: persona.id })
    return
  }

  // POST /api/sessions — create a new session
  if (method === 'POST' && url === '/api/sessions') {
    const now = Date.now()
    _sessionCreateTimestamps.splice(0, _sessionCreateTimestamps.length,
      ..._sessionCreateTimestamps.filter(t => now - t < SESSION_CREATE_WINDOW_MS))
    if (_sessionCreateTimestamps.length >= SESSION_CREATE_RATE_LIMIT) {
      sendJson(res, 429, { error: 'Rate limit exceeded: max 5 sessions per minute' })
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown; model?: unknown; permissionMode?: unknown; workingDirectory?: unknown; name?: unknown } = {}
    try {
      if (body.length > 0) parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : undefined
    const model = typeof parsed.model === 'string' ? parsed.model : undefined
    const permissionMode = typeof parsed.permissionMode === 'string' ? parsed.permissionMode as 'autonomous' | 'auto' | 'supervised' : undefined
    const workingDirectory = typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : undefined
    const name = typeof parsed.name === 'string' ? parsed.name : undefined
    let inst
    try {
      const opts: Parameters<typeof createInstance>[0] = { name, model, permissionMode, workingDirectory }
      if (prompt) opts.args = ['-p', prompt]
      inst = await createInstance(opts)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message || 'Failed to create session' })
      return
    }
    _sessionCreateTimestamps.push(now)
    sendJson(res, 201, { id: inst.id, name: inst.name })
    return
  }

  // POST /api/sessions/:id/stop — stop a running session
  const stopMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/stop$/)
  if (method === 'POST' && stopMatch) {
    const idOrName = decodeURIComponent(stopMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    await killInstance(inst.id)
    sendJson(res, 200, { ok: true })
    return
  }

  // GET /api/sessions/:id/output — return PTY buffer content (last 100KB)
  const outputMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/output$/)
  if (method === 'GET' && outputMatch) {
    const idOrName = decodeURIComponent(outputMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    let output = ''
    try {
      output = await getDaemonRouter().getInstanceBuffer(inst.id)
    } catch { /* return empty if buffer unavailable */ }
    const MAX_OUTPUT_BYTES = 100_000
    if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
      output = output.slice(-MAX_OUTPUT_BYTES)
    }
    sendJson(res, 200, { output })
    return
  }

  // DELETE /api/sessions/:id — remove a stopped session
  const deleteSessionMatch = url.match(/^\/api\/sessions\/([^/?#]+)$/)
  if (method === 'DELETE' && deleteSessionMatch) {
    const idOrName = decodeURIComponent(deleteSessionMatch[1])
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    if (inst.status === 'running') {
      sendJson(res, 409, { error: 'Session is still running — stop it first' })
      return
    }
    try {
      await getDaemonRouter().removeInstance(inst.id)
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message || 'Failed to remove session' })
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }

  // POST /api/sessions/:id/whisper — alias for steer; also writes to persona Notes if session is a persona
  const whisperMatch = url.match(/^\/api\/sessions\/([^/?#]+)\/whisper$/)
  if (method === 'POST' && whisperMatch) {
    const idOrName = decodeURIComponent(whisperMatch[1])
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const status = (err as Error).message?.includes('maximum size') ? 413 : 400
      sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
      return
    }
    let parsed: { prompt?: unknown } = {}
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    const prompt = parsed.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      sendJson(res, 400, { error: 'Missing required field: prompt' })
      return
    }
    const instances = await getAllInstances()
    const inst = instances.find((i) => i.id === idOrName || i.name === idOrName)
    if (!inst) {
      sendJson(res, 404, { error: 'Session not found' })
      return
    }
    const ok = await getDaemonRouter().steerInstance(inst.id, prompt)
    sendJson(res, ok ? 200 : 500, { ok })
    return
  }

  // GET /api/openapi.json — OpenAPI 3.0 spec (update this when adding new endpoints)
  if (method === 'GET' && url === '/api/openapi.json') {
    const port = serverUrl ? new URL(serverUrl).port : '7474'
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Colony API', version: app.getVersion(), description: 'REST API for Colony session, pipeline, and persona management.' },
      servers: [
        { url: `http://127.0.0.1:${port}`, description: 'Local Colony server' },
        { url: `http://0.0.0.0:${port}`, description: 'All interfaces' },
      ],
      components: {
        securitySchemes: {
          BearerToken: { type: 'http', scheme: 'bearer', description: 'API token configured in Colony Settings → Webhook & API' },
          ColonyToken: { type: 'apiKey', in: 'header', name: 'X-Colony-Token' },
        },
        schemas: {
          Session: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' },
              status: { type: 'string', enum: ['running', 'waiting', 'stopped'] },
              cost: { type: 'number' }, uptime: { type: 'number', description: 'Milliseconds since session start' },
            },
          },
          Pipeline: {
            type: 'object',
            properties: {
              name: { type: 'string' }, enabled: { type: 'boolean' },
              schedule: { type: 'string' }, lastFired: { type: 'string', nullable: true },
            },
          },
          Persona: {
            type: 'object',
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' },
              model: { type: 'string' }, schedule: { type: 'string', nullable: true },
              lastRun: { type: 'string', nullable: true }, runCount: { type: 'number' }, active: { type: 'boolean' },
            },
          },
          Error: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
      security: [{ BearerToken: [] }, { ColonyToken: [] }],
      paths: {
        '/api/status': {
          get: {
            summary: 'Health check', operationId: 'getStatus', tags: ['System'],
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, uptime: { type: 'number' } } } } } } },
          },
        },
        '/api/openapi.json': {
          get: { summary: 'OpenAPI spec', operationId: 'getOpenApiSpec', tags: ['System'], responses: { '200': { description: 'OpenAPI 3.0 JSON spec' } } },
        },
        '/api/docs': {
          get: { summary: 'Interactive API docs (Swagger UI)', operationId: 'getDocs', tags: ['System'], responses: { '200': { description: 'HTML page' } } },
        },
        '/api/events': {
          get: {
            summary: 'Global SSE event stream', operationId: 'getEvents', tags: ['Events'],
            description: 'Server-Sent Events stream. Each event is a JSON object: `{ channel: string, data: any }`. Max 5 concurrent connections.',
            responses: {
              '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string', example: 'data: {"channel":"instance:output","data":{"id":"abc","data":"hello"}}\n\n' } } } },
              '503': { description: 'Too many connections', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            },
          },
        },
        '/api/sessions': {
          get: {
            summary: 'List sessions', operationId: 'listSessions', tags: ['Sessions'],
            responses: { '200': { description: 'Session list', content: { 'application/json': { schema: { type: 'object', properties: { sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } } } } } },
          },
          post: {
            summary: 'Create session', operationId: 'createSession', tags: ['Sessions'],
            description: 'Rate limited to 5 per minute.',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Prompt to run with -p flag' }, model: { type: 'string' }, permissionMode: { type: 'string', enum: ['autonomous', 'auto', 'supervised'] }, workingDirectory: { type: 'string' }, name: { type: 'string' } } } } } },
            responses: {
              '201': { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
              '429': { description: 'Rate limit exceeded' },
            },
          },
        },
        '/api/sessions/{id}': {
          get: {
            summary: 'Get session', operationId: 'getSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Session ID or name' }],
            responses: { '200': { description: 'Session detail' }, '404': { description: 'Not found' } },
          },
          delete: {
            summary: 'Delete stopped session', operationId: 'deleteSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Deleted' }, '409': { description: 'Session still running' } },
          },
        },
        '/api/sessions/{id}/stop': {
          post: {
            summary: 'Stop session', operationId: 'stopSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Stopped' } },
          },
        },
        '/api/sessions/{id}/steer': {
          post: {
            summary: 'Send prompt to session (steer)', operationId: 'steerSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/api/sessions/{id}/whisper': {
          post: {
            summary: 'Whisper to session (alias for steer)', operationId: 'whisperSession', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/api/sessions/{id}/output': {
          get: {
            summary: 'Get session PTY output (last 100KB)', operationId: 'getSessionOutput', tags: ['Sessions'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Output buffer', content: { 'application/json': { schema: { type: 'object', properties: { output: { type: 'string' } } } } } } },
          },
        },
        '/api/sessions/{id}/stream': {
          get: {
            summary: 'Stream session output (SSE)', operationId: 'streamSession', tags: ['Sessions'],
            description: 'Server-Sent Events. Events: `output` (text chunks), `exit` (session ended). Sends buffered output on connect. Max 5 connections per session.',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string', example: 'event: output\ndata: {"text":"hello"}\n\nevent: exit\ndata: {"code":0}\n\n' } } } } },
          },
        },
        '/api/pipelines': {
          get: {
            summary: 'List pipelines', operationId: 'listPipelines', tags: ['Pipelines'],
            responses: { '200': { description: 'Pipeline list', content: { 'application/json': { schema: { type: 'object', properties: { pipelines: { type: 'array', items: { $ref: '#/components/schemas/Pipeline' } } } } } } } },
          },
        },
        '/api/pipelines/{name}/trigger': {
          post: {
            summary: 'Trigger pipeline', operationId: 'triggerPipeline', tags: ['Pipelines'],
            parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              description: 'All fields optional. Empty body triggers with defaults.',
              content: { 'application/json': { schema: { type: 'object', properties: {
                prompt: { type: 'string', description: 'Override the pipeline action prompt' },
                model: { type: 'string', description: 'Override the model (e.g. claude-opus-4-7)' },
                workingDirectory: { type: 'string', description: 'Override the working directory' },
                maxBudget: { type: 'number', description: 'Override max budget in USD (clamped 0.01–100)' },
                vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Template variable overrides for {{varName}} placeholders in pipeline YAML' },
              } } } },
            },
            responses: {
              '200': { description: 'Triggered', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, pipeline: { type: 'string' }, overrides: { type: 'object' } } } } } },
              '404': { description: 'Pipeline not found' },
            },
          },
        },
        '/api/personas': {
          get: {
            summary: 'List personas', operationId: 'listPersonas', tags: ['Personas'],
            responses: { '200': { description: 'Persona list', content: { 'application/json': { schema: { type: 'object', properties: { personas: { type: 'array', items: { $ref: '#/components/schemas/Persona' } } } } } } } },
          },
        },
        '/api/personas/{id}/trigger': {
          post: {
            summary: 'Trigger persona', operationId: 'triggerPersona', tags: ['Personas'],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', description: 'Optional whisper message to inject' } } } } } },
            responses: { '202': { description: 'Accepted (runs async)' }, '404': { description: 'Persona not found' } },
          },
        },
      },
    }
    const payload = JSON.stringify(spec, null, 2)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Access-Control-Allow-Origin': '*' })
    res.end(payload)
    return
  }

  // GET /api/docs — Swagger UI interactive docs
  if (method === 'GET' && url === '/api/docs') {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Colony API Docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>
  body { margin: 0; }
  #auth-bar { padding: 10px 20px; background: #1a1a2e; display: flex; align-items: center; gap: 10px; }
  #auth-bar label { color: #ccc; font: 13px monospace; }
  #token-input { flex: 1; max-width: 400px; padding: 6px 10px; border: 1px solid #444; border-radius: 4px; background: #0d0d1a; color: #fff; font: 13px monospace; }
  #apply-btn { padding: 6px 14px; background: #4CAF50; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
<div id="auth-bar">
  <label>API Token:</label>
  <input id="token-input" type="password" placeholder="Leave empty if no auth configured" />
  <button id="apply-btn">Apply</button>
</div>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  const ui = SwaggerUIBundle({
    url: '/api/openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    requestInterceptor(req) {
      const token = document.getElementById('token-input').value.trim();
      if (token) req.headers['Authorization'] = 'Bearer ' + token;
      return req;
    }
  });
  document.getElementById('apply-btn').onclick = () => ui.authActions.logout([]);
</script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
    res.end(html)
    return
  }

  sendJson(res, 404, { error: 'Not Found' })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/'
  log(`${req.method} ${url}`)

  // Route /api/* to the REST API handler
  if (url.startsWith('/api/')) {
    await handleApiRequest(req, res)
    return
  }

  // Only handle POST /webhook/<slug>
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = url.match(/^\/webhook\/([^/?#]+)/)
  if (!match) {
    sendJson(res, 404, { error: 'Not Found' })
    return
  }

  const slug = match[1]

  // Find the matching webhook trigger
  const triggers = getWebhookTriggers()
  const triggerEntry = triggers.find((t) => t.slug === slug)

  if (!triggerEntry) {
    log(`Unknown slug: ${slug}`)
    sendJson(res, 404, { error: `No webhook pipeline found for slug: ${slug}` })
    return
  }

  const { trigger } = triggerEntry
  const secret = trigger.secret || ''
  const source = trigger.source || 'generic'

  // Read raw body BEFORE signature verification
  let body: Buffer
  try {
    body = await readBody(req)
  } catch (err) {
    const status = (err as Error).message?.includes('maximum size') ? 413 : 400
    log(`Failed to read body: ${err}`)
    sendJson(res, status, { error: status === 413 ? 'Request body too large' : 'Failed to read request body' })
    return
  }

  // Verify signature / token
  let verified = false
  if (source === 'github') {
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined
    verified = verifyGitHubSignature(secret, body, sigHeader)
    if (!verified) {
      log(`GitHub signature verification failed for ${slug}`)
      sendJson(res, 400, { error: 'Invalid signature' })
      return
    }
  } else {
    // generic: bearer or x-colony-token
    if (secret) {
      verified = verifyGenericToken(secret, req)
      if (!verified) {
        log(`Generic token verification failed for ${slug}`)
        sendJson(res, 400, { error: 'Invalid token' })
        return
      }
    } else {
      // No secret configured — allow all (warn)
      verified = true
      log(`Warning: no secret configured for ${slug} — allowing unauthenticated request`)
    }
  }

  // Parse payload
  let payload: unknown = null
  try {
    const bodyStr = body.toString('utf8')
    if (bodyStr.trim()) {
      payload = JSON.parse(bodyStr)
    }
  } catch {
    // Non-JSON body — pass as raw string
    payload = body.toString('utf8')
  }

  // Fire the pipeline
  const result = fireWebhookPipeline(triggerEntry.name, payload)
  if (result.ok) {
    log(`Fired pipeline: ${triggerEntry.name}`)
    sendJson(res, 200, { ok: true, pipeline: triggerEntry.name })
  } else {
    log(`Failed to fire pipeline: ${triggerEntry.name}: ${result.error}`)
    sendJson(res, 400, { ok: false, error: result.error })
  }
}

export function startWebhookServer(port: number): void {
  if (server) {
    log('Server already running')
    return
  }

  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`Unhandled error: ${err}`)
      try {
        sendJson(res, 500, { error: 'Internal Server Error' })
      } catch { /* response already sent */ }
    })
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} already in use — webhook server NOT started. Use a different port in Settings.`)
    } else {
      log(`Server error: ${err.message}`)
    }
    server = null
    serverUrl = null
  })

  server.listen(port, '127.0.0.1', () => {
    serverUrl = `http://127.0.0.1:${port}`
    log(`Listening at ${serverUrl}`)
  })
}

export function stopWebhookServer(): void {
  if (!server) return
  server.close(() => {
    log('Server stopped')
  })
  server = null
  serverUrl = null
}

/** Returns the current server URL if running, or null. */
export function getWebhookServerUrl(): string | null {
  return serverUrl
}
