type StageWithError = {
  error?: string
  subStages?: StageWithError[]
}

type EntryWithStages = {
  stages?: StageWithError[]
}

/**
 * Walk stages (recursing into subStages for parallel actions) and return
 * the first non-empty error string found, or null if none.
 */
export function firstErrorOf(entry: EntryWithStages): string | null {
  if (!entry.stages || entry.stages.length === 0) return null
  for (const stage of entry.stages) {
    if (stage.error) return stage.error
    if (stage.subStages && stage.subStages.length > 0) {
      const nested = firstErrorOf({ stages: stage.subStages })
      if (nested) return nested
    }
  }
  return null
}
