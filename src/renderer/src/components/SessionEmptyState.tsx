import { useState, useEffect, useCallback, KeyboardEvent } from 'react'
import { Search, Wrench, Bug, TerminalSquare, FolderOpen } from 'lucide-react'
import { STARTER_PROMPTS, type StarterPrompt } from '../../../shared/starter-prompts'

/**
 * Map the Lucide icon name stored on a starter prompt to an actual component.
 * Keeps SessionEmptyState dependency-free — adding a new starter prompt only
 * requires extending this map (if the icon isn't already listed).
 */
const ICONS: Record<string, typeof Search> = {
  Search,
  Wrench,
  Bug,
  TerminalSquare,
}

interface Props {
  /**
   * Called when a card is clicked. `prompt` is the seed text (empty string for
   * the blank card). The parent is responsible for opening the New Session
   * dialog with the prompt pre-filled and queueing it to run once the session
   * is ready.
   */
  onSelectCard: (prompt: string, opts: { workingDirectory?: string }) => void
  /**
   * Seed for the working-directory chip. Defaults to the first directory in
   * the user's recent-directories list, or empty if none. If empty, the
   * component renders a "Pick a working directory" CTA instead of the cards.
   */
  defaultWorkingDirectory?: string
}

function basename(path: string): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export default function SessionEmptyState({ onSelectCard, defaultWorkingDirectory }: Props) {
  const [cwd, setCwd] = useState<string>(defaultWorkingDirectory || '')

  useEffect(() => {
    setCwd(defaultWorkingDirectory || '')
  }, [defaultWorkingDirectory])

  const handlePickDir = useCallback(async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setCwd(dir)
  }, [])

  // Cards need a working directory to produce a meaningful session.
  // Without one, we still render them — greyed out — so the user sees
  // what the options look like, but clicks land on the folder picker.
  const cardsEnabled = cwd.length > 0

  const handleCardActivate = useCallback(
    async (p: StarterPrompt) => {
      if (!cardsEnabled) {
        const dir = await window.api.dialog.openDirectory()
        if (!dir) return
        setCwd(dir)
        onSelectCard(p.prompt, { workingDirectory: dir })
        return
      }
      onSelectCard(p.prompt, { workingDirectory: cwd })
    },
    [cardsEnabled, cwd, onSelectCard],
  )

  const handleCardKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, p: StarterPrompt) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleCardActivate(p)
      }
    },
    [handleCardActivate],
  )

  return (
    <div className="session-empty-state">
      <div className="session-empty-state-header">
        {cwd ? (
          <>
            <h2>
              Working in <span className="session-empty-state-cwd">{basename(cwd)}</span>
            </h2>
            <p className="session-empty-state-subtitle" title={cwd}>
              Pick a starter prompt — Claude opens in{' '}
              <code>{cwd}</code> with the prompt pre-filled.
            </p>
            <button
              type="button"
              className="session-empty-state-change-dir"
              onClick={handlePickDir}
              title="Change working directory"
            >
              <FolderOpen size={12} /> Change directory
            </button>
          </>
        ) : (
          <>
            <h2>Pick a working directory to get started</h2>
            <p className="session-empty-state-subtitle">
              Claude needs a folder to reason about. Choose one, then pick a starter prompt below.
            </p>
            <button
              type="button"
              className="session-empty-state-pick-dir"
              onClick={handlePickDir}
              title="Open folder picker"
            >
              <FolderOpen size={14} /> Choose folder…
            </button>
          </>
        )}
      </div>

      <div className="starter-cards" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((p) => {
          const Icon = ICONS[p.icon] || TerminalSquare
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className={`starter-card ${cardsEnabled ? '' : 'disabled'}`}
              data-testid={`starter-card-${p.id}`}
              aria-disabled={!cardsEnabled}
              title={cardsEnabled ? p.title : 'Choose a folder first'}
              onClick={() => handleCardActivate(p)}
              onKeyDown={(e) => handleCardKey(e, p)}
            >
              <div className="starter-card-icon">
                <Icon size={20} />
              </div>
              <div className="starter-card-body">
                <div className="starter-card-title">{p.title}</div>
                <div className="starter-card-desc">{p.description}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
