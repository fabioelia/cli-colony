import { Terminal } from '@xterm/xterm'

/**
 * TerminalProxy sits between raw PTY output and the visible xterm.js Terminal.
 *
 * Inspired by claude-chill's approach:
 * - Detects DEC synchronized output blocks (\x1b[?2026h / \x1b[?2026l)
 * - Buffers data during sync blocks, writes atomically when block ends
 * - Preserves user's scroll position during TUI redraws
 * - Throttles rapid writes outside sync blocks
 */

const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

export class TerminalProxy {
  private term: Terminal
  private inSyncBlock = false
  private syncBuffer = ''
  private pendingData = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private userScrolledUp = false

  // Throttle interval for batching writes outside sync blocks (ms)
  private readonly THROTTLE_MS = 8
  // Extra delay during sync blocks to catch all data
  private readonly SYNC_DELAY_MS = 32

  constructor(term: Terminal) {
    this.term = term

    // Track user scroll state — only consider "scrolled up" if more than 2 rows from the bottom
    // This prevents the proxy from fighting with the user when they scroll down to the bottom
    term.onScroll(() => {
      const distanceFromBottom = term.buffer.active.baseY - term.buffer.active.viewportY
      if (distanceFromBottom <= 1) {
        // User reached the bottom — release scroll lock
        this.userScrolledUp = false
      } else if (distanceFromBottom > 3) {
        // User is meaningfully scrolled up
        this.userScrolledUp = true
      }
      // Between 1-3 rows: keep current state (hysteresis to avoid flickering)
    })
  }

  /**
   * Called when user types — reset scroll tracking
   */
  onUserInput(): void {
    this.userScrolledUp = false
  }

  /**
   * Process incoming PTY data. Handles sync block detection and buffering.
   */
  write(data: string): void {
    // Scan for sync markers in the incoming data
    let remaining = data

    while (remaining.length > 0) {
      if (this.inSyncBlock) {
        // Look for sync end
        const endIdx = remaining.indexOf(SYNC_END)
        if (endIdx >= 0) {
          // Add everything up to and including the sync end
          this.syncBuffer += remaining.substring(0, endIdx + SYNC_END.length)
          remaining = remaining.substring(endIdx + SYNC_END.length)
          this.inSyncBlock = false
          // Flush the entire sync block atomically
          this.flushSyncBlock()
        } else {
          // Still in sync block, buffer everything
          this.syncBuffer += remaining
          remaining = ''
        }
      } else {
        // Look for sync start
        const startIdx = remaining.indexOf(SYNC_START)
        if (startIdx >= 0) {
          // Write everything before the sync start immediately
          if (startIdx > 0) {
            this.appendPending(remaining.substring(0, startIdx))
          }
          // Enter sync mode
          this.inSyncBlock = true
          this.syncBuffer = SYNC_START
          remaining = remaining.substring(startIdx + SYNC_START.length)
        } else {
          // No sync markers, throttled write
          this.appendPending(remaining)
          remaining = ''
        }
      }
    }
  }

  private appendPending(data: string): void {
    this.pendingData += data
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPending(), this.THROTTLE_MS)
    }
  }

  private flushPending(): void {
    this.flushTimer = null
    if (!this.pendingData) return

    const data = this.pendingData
    this.pendingData = ''

    if (this.userScrolledUp) {
      const savedY = this.term.buffer.active.viewportY
      this.term.write(data, () => {
        // Restore viewport after xterm processes the write
        requestAnimationFrame(() => {
          if (this.userScrolledUp) {
            this.term.scrollToLine(savedY)
          }
        })
      })
    } else {
      this.term.write(data)
    }
  }

  private flushSyncBlock(): void {
    if (!this.syncBuffer) return

    const data = this.syncBuffer
    this.syncBuffer = ''

    if (this.userScrolledUp) {
      const savedY = this.term.buffer.active.viewportY
      // Write the entire sync block atomically — xterm.js batches rendering
      // between the \x1b[?2026h and \x1b[?2026l markers
      this.term.write(data, () => {
        // Double-restore: once in callback, once in rAF to catch async rendering
        if (this.userScrolledUp) {
          this.term.scrollToLine(savedY)
          requestAnimationFrame(() => {
            if (this.userScrolledUp) {
              this.term.scrollToLine(savedY)
            }
          })
        }
      })
    } else {
      this.term.write(data)
    }
  }

  /**
   * Force-flush any pending data (e.g., when terminal is being disposed)
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.syncBuffer) {
      this.term.write(this.syncBuffer)
      this.syncBuffer = ''
    }
    if (this.pendingData) {
      this.term.write(this.pendingData)
      this.pendingData = ''
    }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
