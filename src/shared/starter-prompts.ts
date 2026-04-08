/**
 * Seed prompts shown on the empty Sessions panel to give new users a
 * one-click path from "I just launched Colony" to "I see Claude doing
 * something useful against my code".
 *
 * Each entry renders as a card in `SessionEmptyState`. Clicking a card
 * opens the New Session dialog with `prompt` pre-filled. The "blank"
 * card uses an empty string so the dialog opens without a prompt.
 *
 * Keep this list short (4 cards) — it is the first thing a new user sees
 * and more options just means more decisions. Shape > wording.
 */

export interface StarterPrompt {
  /** Stable identifier — do not change once shipped (used by tests + analytics). */
  id: string
  /** Lucide icon name. Must already be imported somewhere in the renderer. */
  icon: string
  /** 1–3 word card title (14px semibold). */
  title: string
  /** 1–2 line card description (12px muted). */
  description: string
  /** Seed prompt text. Empty string opens a blank dialog. */
  prompt: string
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: 'explore',
    icon: 'Search',
    title: 'Explore this project',
    description: 'Get a guided tour of the codebase, its architecture, and main entry points.',
    prompt:
      "Read the codebase and summarize what this project does, its architecture, and the main entry points. Keep it concise — a few paragraphs.",
  },
  {
    id: 'refactor',
    icon: 'Wrench',
    title: 'Propose a refactor',
    description: 'Scout for one low-risk improvement and draft a diff — nothing applied yet.',
    prompt:
      "Find one small, low-risk improvement in this codebase and propose a diff. Don't apply it yet — show the diff and explain the trade-offs so I can approve it first.",
  },
  {
    id: 'fix-bug',
    icon: 'Bug',
    title: 'Fix a small bug',
    description: 'Comb recent git history for a papercut and open a PR with the fix.',
    prompt:
      "Look at recent git history and identify a small bug or rough edge. Open a PR with a fix — include a clear commit message and a one-paragraph PR description.",
  },
  {
    id: 'blank',
    icon: 'TerminalSquare',
    title: 'Start blank',
    description: 'Open the session dialog without a pre-filled prompt.',
    prompt: '',
  },
]
