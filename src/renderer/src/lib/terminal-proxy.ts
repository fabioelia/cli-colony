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
  // Suppress scroll tracking during our own programmatic scrollToLine/scrollToBottom calls
  // to prevent onScroll from incorrectly flipping userScrolledUp
  private suppressScrollTracking = false

  // Throttle interval for batching writes outside sync blocks (ms)
  // Set to 0 for immediate rendering of keystroke echoes
  private readonly THROTTLE_MS = 0

  // Rolling suffix buffer for chunk-safe sync marker detection
  // Keeps the last (SYNC_END.length - 1) bytes to detect markers split across chunks
  private rollingBuff = ''

  constructor(term: Terminal) {
    this.term = term

    // Track user scroll state — only consider "scrolled up" if more than 2 rows from the bottom
    // This prevents the proxy from fighting with the user when they scroll down to the bottom
    term.onScroll(() => {
      if (this.suppressScrollTracking) return
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
   * Called when user types — reset scroll tracking and snap to bottom
   */
  onUserInput(): void {
    // Only scroll if actually scrolled up; avoid sync layout on every keystroke
    if (this.userScrolledUp) {
      this.suppressScrollTracking = true
      this.term.scrollToBottom()
      this.suppressScrollTracking = false
      this.userScrolledUp = false
    }
  }

  /**
   * Process incoming PTY data. Handles sync block detection and buffering.
   * Chunk-safe: detects markers even when split across multiple write() calls.
   */
  write(data: string): void {
    let remaining = data

    while (remaining.length > 0) {
      if (this.inSyncBlock) {
        // Look for sync end — search with rolling buffer to catch split markers
        const searchBuf = this.rollingBuff + remaining
        const endIdx = searchBuf.indexOf(SYNC_END)
        if (endIdx >= 0) {
          // Found end marker. Account for rolling buffer offset.
          const endIdxInRemaining = endIdx - this.rollingBuff.length
          if (endIdxInRemaining >= 0) {
            // End marker is in the remaining data
            this.syncBuffer += remaining.substring(0, endIdxInRemaining + SYNC_END.length)
            remaining = remaining.substring(endIdxInRemaining + SYNC_END.length)
            this.inSyncBlock = false
            this.flushSyncBlock()
          } else {
            // End marker is in the rolling buffer — shouldn't happen, but buffer and continue
            this.syncBuffer += remaining
            remaining = ''
          }
        } else {
          // Still in sync block, buffer everything
          this.syncBuffer += remaining
          remaining = ''
        }
      } else {
        // Look for sync start — search with rolling buffer to catch split markers
        const searchBuf = this.rollingBuff + remaining
        const startIdx = searchBuf.indexOf(SYNC_START)
        if (startIdx >= 0) {
          // Found start marker. Account for rolling buffer offset.
          const startIdxInRemaining = startIdx - this.rollingBuff.length
          if (startIdxInRemaining >= 0) {
            // Start marker is in the remaining data
            if (startIdxInRemaining > 0) {
              this.appendPending(remaining.substring(0, startIdxInRemaining))
            }
            this.inSyncBlock = true
            this.syncBuffer = SYNC_START
            remaining = remaining.substring(startIdxInRemaining + SYNC_START.length)
          } else {
            // Start marker is in the rolling buffer — shouldn't happen, but flush what we have
            this.appendPending(remaining)
            remaining = ''
          }
        } else {
          // No sync markers, throttled write
          this.appendPending(remaining)
          remaining = ''
        }
      }
    }

    // Update rolling buffer with the last (SYNC_END.length - 1) bytes of the original data
    // to detect markers split across chunks
    if (data.length >= SYNC_END.length - 1) {
      this.rollingBuff = data.substring(data.length - (SYNC_END.length - 1))
    } else {
      this.rollingBuff = (this.rollingBuff + data).slice(-(SYNC_END.length - 1))
    }
  }

  private appendPending(data: string): void {
    this.pendingData += data
    if (this.THROTTLE_MS === 0) {
      // Flush immediately for responsive keystroke echo
      this.flushPending()
    } else if (!this.flushTimer) {
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
        requestAnimationFrame(() => {
          if (this.userScrolledUp) {
            this.suppressScrollTracking = true
            this.term.scrollToLine(savedY)
            this.suppressScrollTracking = false
          }
        })
      })
    } else {
      // Trust xterm's internal scheduler — term.write() handles repainting via RAF automatically
      this.term.write(data)
    }
  }

  private flushSyncBlock(): void {
    if (!this.syncBuffer) return

    const data = this.syncBuffer
    this.syncBuffer = ''

    if (this.userScrolledUp) {
      const savedY = this.term.buffer.active.viewportY
      this.term.write(data, () => {
        if (this.userScrolledUp) {
          this.suppressScrollTracking = true
          this.term.scrollToLine(savedY)
          this.suppressScrollTracking = false
          requestAnimationFrame(() => {
            if (this.userScrolledUp) {
              this.suppressScrollTracking = true
              this.term.scrollToLine(savedY)
              this.suppressScrollTracking = false
            }
          })
        }
      })
    } else {
      // Trust xterm's internal scheduler
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
    this.syncBuffer = ''
    this.pendingData = ''
  }
}
