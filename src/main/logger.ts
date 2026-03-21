const logBuffer: string[] = []
const MAX_LINES = 2000

const origLog = console.log
const origError = console.error
const origWarn = console.warn

function timestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function capture(level: string, args: unknown[]): void {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  logBuffer.push(`[${timestamp()}] [${level}] ${msg}`)
  if (logBuffer.length > MAX_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LINES)
  }
}

export function initLogger(): void {
  console.log = (...args: unknown[]) => {
    capture('LOG', args)
    origLog.apply(console, args)
  }
  console.error = (...args: unknown[]) => {
    capture('ERR', args)
    origError.apply(console, args)
  }
  console.warn = (...args: unknown[]) => {
    capture('WRN', args)
    origWarn.apply(console, args)
  }
}

export function getLogs(): string {
  return logBuffer.join('\n')
}

export function clearLogs(): void {
  logBuffer.length = 0
}
