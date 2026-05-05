interface RecapEntry {
  recap: string
  generatedAt: string
}

const _cache = new Map<string, RecapEntry>()

export function getCachedRecap(instanceId: string): RecapEntry | undefined {
  return _cache.get(instanceId)
}

export function setCachedRecap(instanceId: string, entry: RecapEntry): void {
  _cache.set(instanceId, entry)
}

export function clearRecap(instanceId: string): void {
  _cache.delete(instanceId)
}
