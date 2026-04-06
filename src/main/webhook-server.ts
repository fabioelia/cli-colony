/**
 * Webhook HTTP server for Colony.
 *
 * Listens on 127.0.0.1:<port> and routes POST /webhook/<slug>
 * to the matching pipeline via fireWebhookPipeline().
 *
 * GitHub source: verifies X-Hub-Signature-256 (HMAC-SHA256 of raw body)
 * Generic source: verifies Authorization: Bearer <secret> or X-Colony-Token: <secret>
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { fireWebhookPipeline, getWebhookTriggers } from './pipeline-engine'

const PREFIX = '[webhook-server]'

let server: Server | null = null
let serverUrl: string | null = null

function log(msg: string): void {
  console.log(`${PREFIX} ${msg}`)
}

/** Return raw body bytes from an incoming request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
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

/**
 * Verify generic bearer token.
 * Accepts: Authorization: Bearer <secret>  or  X-Colony-Token: <secret>
 */
export function verifyGenericToken(secret: string, req: IncomingMessage): boolean {
  const authHeader = req.headers['authorization']
  if (authHeader) {
    if (authHeader === `Bearer ${secret}`) return true
  }
  const colonyToken = req.headers['x-colony-token']
  if (typeof colonyToken === 'string' && colonyToken === secret) return true
  return false
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/'
  log(`${req.method} ${url}`)

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
    log(`Failed to read body: ${err}`)
    sendJson(res, 400, { error: 'Failed to read request body' })
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
