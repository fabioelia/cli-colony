import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock colony-paths before any module imports (hoisted)
vi.mock('../../shared/colony-paths', () => ({
  colonyPaths: {
    environments: '/mock/environments',
  },
}))

// Mock fs module
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue('{}'),
  }
})

// Mock net module — vi.spyOn doesn't work on ESM named exports.
// vi.hoisted() ensures mockCreateServer is defined before the hoisted vi.mock factory runs.
const serverListeners: Array<{ error?: () => void; listening?: () => void }> = []
const mockCreateServer = vi.hoisted(() => vi.fn())

vi.mock('net', () => ({
  createServer: mockCreateServer,
}))

import * as fs from 'fs'
import { isPortInUse, allocatePorts, isPortAllocated } from '../port-allocator'

function makeFreeServer() {
  const handlers: Record<string, () => void> = {}
  const server = {
    once: (event: string, cb: () => void) => { handlers[event] = cb; return server },
    close: vi.fn(),
    listen: vi.fn(() => {
      // Fire 'listening' asynchronously (port is free)
      Promise.resolve().then(() => handlers['listening']?.())
      return server
    }),
  }
  return server
}

function makeBlockedServer() {
  const handlers: Record<string, () => void> = {}
  const server = {
    once: (event: string, cb: () => void) => { handlers[event] = cb; return server },
    close: vi.fn(),
    listen: vi.fn(() => {
      // Fire 'error' asynchronously (port is in use)
      Promise.resolve().then(() => handlers['error']?.())
      return server
    }),
  }
  return server
}

describe('isPortInUse', () => {
  afterEach(() => {
    serverListeners.length = 0
    mockCreateServer.mockReset()
  })

  it('returns false when both v4 and v6 bind succeed', async () => {
    mockCreateServer.mockImplementation(() => makeFreeServer())
    const result = await isPortInUse(8080)
    expect(result).toBe(false)
  })

  it('returns true when one bind fails', async () => {
    let callCount = 0
    mockCreateServer.mockImplementation(() => {
      callCount++
      return callCount === 1 ? makeBlockedServer() : makeFreeServer()
    })
    const result = await isPortInUse(8080)
    expect(result).toBe(true)
  })

  it('returns true when both binds fail', async () => {
    mockCreateServer.mockImplementation(() => makeBlockedServer())
    const result = await isPortInUse(8080)
    expect(result).toBe(true)
  })
})

describe('isPortAllocated', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
  })

  it('returns false when environments dir does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(isPortAllocated(8030)).toBe(false)
  })

  it('returns false when no environment has that port', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/mock/environments' || p === '/mock/environments/env1/instance.json'
    })
    vi.mocked(fs.readdirSync).mockReturnValue(['env1'] as unknown as ReturnType<typeof fs.readdirSync>)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ports: { backend: 8010 } }))
    expect(isPortAllocated(8030)).toBe(false)
  })

  it('returns true when an environment has that port', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/mock/environments' || p === '/mock/environments/env1/instance.json'
    })
    vi.mocked(fs.readdirSync).mockReturnValue(['env1'] as unknown as ReturnType<typeof fs.readdirSync>)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ports: { backend: 8030 } }))
    expect(isPortAllocated(8030)).toBe(true)
  })

  it('tolerates invalid JSON in manifests', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/mock/environments' || p === '/mock/environments/bad/instance.json'
    })
    vi.mocked(fs.readdirSync).mockReturnValue(['bad'] as unknown as ReturnType<typeof fs.readdirSync>)
    vi.mocked(fs.readFileSync).mockReturnValue('not json')
    expect(() => isPortAllocated(8030)).not.toThrow()
    expect(isPortAllocated(8030)).toBe(false)
  })
})

describe('allocatePorts', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    // All ports appear free
    mockCreateServer.mockImplementation(() => makeFreeServer())
  })

  afterEach(() => {
    mockCreateServer.mockReset()
  })

  it('returns empty object for empty names array', async () => {
    const result = await allocatePorts([])
    expect(result).toEqual({})
  })

  it('allocates a single port', async () => {
    const result = await allocatePorts(['backend'])
    expect(result).toHaveProperty('backend')
    expect(typeof result.backend).toBe('number')
    expect(result.backend).toBeGreaterThanOrEqual(8010)
  })

  it('allocates multiple ports spaced by at least 10', async () => {
    const result = await allocatePorts(['backend', 'frontend', 'worker'])
    expect(Object.keys(result)).toHaveLength(3)
    const ports = Object.values(result)
    for (let i = 1; i < ports.length; i++) {
      expect(ports[i]).toBeGreaterThanOrEqual(ports[i - 1] + 10)
    }
  })

  it('assigns correct names to ports', async () => {
    const result = await allocatePorts(['alpha', 'beta'])
    expect(result).toHaveProperty('alpha')
    expect(result).toHaveProperty('beta')
    expect(result.alpha).not.toBe(result.beta)
  })

  it('skips already-allocated ports from manifests', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/mock/environments' || p === '/mock/environments/e1/instance.json'
    })
    vi.mocked(fs.readdirSync).mockReturnValue(['e1'] as unknown as ReturnType<typeof fs.readdirSync>)
    // Port 8010 is already in use by another environment
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ports: { backend: 8010 } }))

    const result = await allocatePorts(['service'])
    expect(result.service).not.toBe(8010)
    expect(result.service).toBeGreaterThan(8010)
  })
})
