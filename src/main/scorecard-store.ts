import { promises as fsp } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import type { ScoreCard } from '../shared/types'

interface StoredEntry {
  diffHash: string
  card: ScoreCard
  updatedAt: number
}

type ScoreCardStore = Record<string, StoredEntry>

const MAX_ENTRIES = 50

async function readStore(): Promise<ScoreCardStore> {
  try {
    const raw = await fsp.readFile(colonyPaths.scorecards, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeStore(store: ScoreCardStore): Promise<void> {
  await fsp.writeFile(colonyPaths.scorecards, JSON.stringify(store, null, 2), 'utf-8')
}

/** Return the cached ScoreCard for an instance if the stored diffHash matches. */
export async function getScoreCard(instanceId: string, diffHash: string): Promise<ScoreCard | null> {
  const store = await readStore()
  const entry = store[instanceId]
  if (!entry || entry.diffHash !== diffHash) return null
  return entry.card
}

/** Persist a ScoreCard keyed by instanceId + diffHash. Enforces LRU cap. */
export async function saveScoreCard(instanceId: string, diffHash: string, card: ScoreCard): Promise<void> {
  const store = await readStore()
  store[instanceId] = { diffHash, card, updatedAt: Date.now() }

  // LRU: keep newest MAX_ENTRIES entries
  const entries = Object.entries(store)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    const trimmed: ScoreCardStore = {}
    for (const [id, entry] of entries.slice(0, MAX_ENTRIES)) trimmed[id] = entry
    await writeStore(trimmed)
  } else {
    await writeStore(store)
  }
}

/** Remove the persisted entry for an instance (user dismissed). */
export async function clearScoreCard(instanceId: string): Promise<void> {
  const store = await readStore()
  if (!store[instanceId]) return
  delete store[instanceId]
  await writeStore(store)
}

/** Prune orphaned entries (sessions no longer in the provided active set).
 *  Called once at startup after instance list is available.
 */
export async function pruneScorecards(activeInstanceIds: Set<string>): Promise<void> {
  const store = await readStore()
  let changed = false
  for (const id of Object.keys(store)) {
    if (!activeInstanceIds.has(id)) {
      delete store[id]
      changed = true
    }
  }
  // Also enforce LRU cap
  const entries = Object.entries(store)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    const trimmed: ScoreCardStore = {}
    for (const [id, entry] of entries.slice(0, MAX_ENTRIES)) trimmed[id] = entry
    await writeStore(trimmed)
  } else if (changed) {
    await writeStore(store)
  }
}
