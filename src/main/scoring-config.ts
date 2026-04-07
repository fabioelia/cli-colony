export const DEFAULT_SCORING_PROMPT = `You are an LLM-as-Judge evaluating the quality of AI-assisted code changes.

Review the git diff below and return a JSON object with EXACTLY these fields:
{
  "confidence": <integer 1-5>,
  "scopeCreep": <boolean>,
  "testCoverage": <"none" | "partial" | "good">,
  "summary": "<2-3 sentences>"
}

Scoring rubric:
- confidence 5: Changes are clean, well-scoped, no regressions likely
- confidence 4: Mostly good, minor style or edge-case concerns
- confidence 3: Some concerns worth reviewing, possible unintended side-effects
- confidence 2: Notable issues — missing error handling, risky patterns, or unclear intent
- confidence 1: Significant problems — security risk, data loss potential, or broken logic
- scopeCreep: true if changes touch files/areas clearly outside the stated task
- testCoverage: "none" if zero test changes, "partial" if some tests added, "good" if coverage is thorough
- summary: concise human-readable verdict (no markdown, no newlines)

Respond with ONLY the JSON object. No prose, no markdown fences, no explanations.

Git diff:
`
