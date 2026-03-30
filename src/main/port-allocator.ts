/**
 * Port Allocator — dynamically finds conflict-free ports for environment instances.
 *
 * Templates declare named port slots (e.g. ["backend", "frontend"]).
 * allocatePorts() finds a free system port for each, spaced apart by 10.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import { colonyPaths } from '../shared/colony-paths'

const ENVIRONMENTS_DIR = colonyPaths.environments

const DYNAMIC_PORT_MIN = 8010
const DYNAMIC_PORT_MAX = 9999

function scanAllocatedPorts(dir: string): Set<number> {
  const ports = new Set<number>()
  if (!fs.existsSync(dir)) return ports

  try {
    for (const entry of fs.readdirSync(dir)) {
      const manifestPath = path.join(dir, entry, 'instance.json')
      if (!fs.existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        if (manifest.ports && typeof manifest.ports === 'object') {
          for (const val of Object.values(manifest.ports)) {
            if (typeof val === 'number') ports.add(val)
          }
        }
      } catch { /* invalid json, skip */ }
    }
  } catch { /* dir not readable */ }

  return ports
}

/**
 * Check if a port is actually in use on the system by attempting to bind it.
 * Checks both IPv4 (127.0.0.1) and IPv6 (::1) — a port bound on either is considered in use.
 */
export function isPortInUse(port: number): Promise<boolean> {
  const tryBind = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(true))
      server.once('listening', () => {
        server.close()
        resolve(false)
      })
      server.listen(port, host)
    })

  return Promise.all([tryBind('127.0.0.1'), tryBind('::1')]).then(
    ([v4, v6]) => v4 || v6
  )
}

/**
 * Find a single free port starting from `startFrom`, skipping ports that are
 * already allocated by Colony or in use on the system.
 */
async function findFreePort(startFrom: number, allocated: Set<number>): Promise<number> {
  let candidate = startFrom
  for (let attempt = 0; attempt < 100; attempt++) {
    if (candidate > DYNAMIC_PORT_MAX) candidate = DYNAMIC_PORT_MIN
    if (!allocated.has(candidate)) {
      const inUse = await isPortInUse(candidate)
      if (!inUse) return candidate
    }
    candidate++
  }
  console.error(`[port-allocator] could not find a free port after 100 attempts starting from ${startFrom}`)
  return candidate
}

/**
 * Allocate conflict-free ports for a list of named port slots.
 *
 * For each named slot we find the next available port on the system that is
 * also not claimed by any other Colony environment. Ports are spaced apart
 * by at least 10 to leave room for manual debugging or side-services.
 *
 * @param names - e.g. ["backend", "frontend"]
 * @returns Map of name -> port, e.g. { backend: 8030, frontend: 8040 }
 */
export async function allocatePorts(names: string[]): Promise<Record<string, number>> {
  if (names.length === 0) return {}

  const allocated = scanAllocatedPorts(ENVIRONMENTS_DIR)
  const result: Record<string, number> = {}

  let cursor = DYNAMIC_PORT_MIN
  for (const name of names) {
    const port = await findFreePort(cursor, allocated)
    result[name] = port
    allocated.add(port)
    cursor = port + 10
  }

  console.log(`[port-allocator] allocated ports: ${JSON.stringify(result)}`)
  return result
}

/**
 * Check if a specific port is in use by any registered environment.
 */
export function isPortAllocated(port: number): boolean {
  return scanAllocatedPorts(ENVIRONMENTS_DIR).has(port)
}
