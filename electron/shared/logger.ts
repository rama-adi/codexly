/**
 * Lightweight structured logger for the Electron main process.
 *
 * Logs are emitted as single lines: `<iso-time> <LEVEL> [scope] message | {context}`.
 * Every log carries an optional structured context object so failures can be
 * diagnosed without re-deriving state. Errors are serialized with their name,
 * message, stack and any `code`/`cause` so opaque bridge failures (e.g. the
 * "overlay cannot perform this action" authorization error) show exactly which
 * command and role were involved.
 *
 * The threshold is controlled by `CODEXLY_LOG_LEVEL` (`debug`|`info`|`warn`|
 * `error`); it defaults to `debug` outside production and `info` in production.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

export interface Logger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, error?: unknown, context?: LogContext): void
  /** Returns a logger whose scope is nested under this one. */
  child(scope: string): Logger
  /** Times an async operation, logging its start, success (with duration) and failure. */
  track<T>(message: string, run: () => Promise<T>, context?: LogContext): Promise<T>
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function resolveThreshold(): number {
  const raw = process.env['CODEXLY_LOG_LEVEL']?.toLowerCase()
  if (raw && raw in LEVEL_ORDER) {
    return LEVEL_ORDER[raw as LogLevel]
  }
  return process.env.NODE_ENV === 'production' ? LEVEL_ORDER.info : LEVEL_ORDER.debug
}

const threshold = resolveThreshold()

/** Serializes an unknown thrown value into a plain, log-friendly object. */
export function serializeErrorForLog(error: unknown): LogContext {
  if (error instanceof Error) {
    const serialized: LogContext = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
    const withCode = error as { code?: unknown; cause?: unknown }
    if (withCode.code !== undefined) serialized.code = withCode.code
    if (withCode.cause !== undefined) serialized.cause = safeCause(withCode.cause)
    return serialized
  }
  return { value: safeStringify(error) }
}

function safeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message }
  }
  return safeStringify(cause)
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatContext(context: LogContext | undefined): string {
  if (!context) return ''
  const entries = Object.entries(context).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return ''
  const seen = new WeakSet<object>()
  try {
    return ` | ${JSON.stringify(Object.fromEntries(entries), (_key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    })}`
  } catch {
    return ` | ${String(entries)}`
  }
}

function emit(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < threshold) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${formatContext(context)}`
  const sink =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  sink(line)
}

function createLoggerForScope(scope: string): Logger {
  return {
    debug: (message, context) => emit('debug', scope, message, context),
    info: (message, context) => emit('info', scope, message, context),
    warn: (message, context) => emit('warn', scope, message, context),
    error: (message, error, context) =>
      emit('error', scope, message, {
        ...(error !== undefined ? { error: serializeErrorForLog(error) } : {}),
        ...context,
      }),
    child: (childScope) => createLoggerForScope(`${scope}:${childScope}`),
    async track(message, run, context) {
      const startedAt = Date.now()
      emit('debug', scope, `${message} — start`, context)
      try {
        const result = await run()
        emit('debug', scope, `${message} — ok`, {
          ...context,
          durationMs: Date.now() - startedAt,
        })
        return result
      } catch (error) {
        emit('error', scope, `${message} — failed`, {
          ...context,
          durationMs: Date.now() - startedAt,
          error: serializeErrorForLog(error),
        })
        throw error
      }
    },
  }
}

/** Root application logger. Create scoped children with `.child(scope)`. */
export const logger: Logger = createLoggerForScope('codexly')
