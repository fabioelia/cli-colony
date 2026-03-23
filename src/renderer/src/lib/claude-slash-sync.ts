/**
 * When true (default), Colony sends Claude Code TUI slash commands (/rename, /color)
 * so the in-terminal session matches the sidebar. Users can disable in Settings.
 */
export async function shouldSyncClaudeSlashCommands(): Promise<boolean> {
  const s = await window.api.settings.getAll()
  return s.syncClaudeSlashCommands !== 'false'
}
