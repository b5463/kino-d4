/**
 * The worker's log, and why it is not `console`.
 *
 * A worker that prints with `console.log` has exactly one volume: everything.
 * On a party night that is a line per derivative per capture — thousands of
 * lines through a container's stdout — and the one line somebody actually needs
 * (the render that failed) is in the middle of them with no field to grep on.
 * `LOG_LEVEL` is what a deployment turns down; `console` has no such knob.
 *
 * One JSON object per line, because the destination is a log collector and not
 * a terminal: `{"level":"error","msg":"export failed","jobKey":"…"}` can be
 * filtered on `jobKey` where `[worker] export failed …` can only be grepped.
 *
 * ## Why not pino
 *
 * The API uses pino and this is deliberately the same *level* vocabulary — the
 * two processes should be turned down by the same `LOG_LEVEL` value. It is not
 * the same library because adding pino to `apps/worker/package.json` means
 * moving `package-lock.json`, and what pino would buy here is transports and
 * child loggers that a worker with four log sites does not use. If the worker
 * ever needs redaction or a transport, this file is the seam to replace.
 *
 * ## What never goes in
 *
 * No credentials and no environment dumps. A field is a value somebody named on
 * purpose; `process.env` is not one, and neither is a connection string —
 * `loadWorkerConfig` already refuses to print a variable's value and this must
 * not become the way round it.
 */

/** Pino's level names, so `LOG_LEVEL` means the same thing in both processes. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Pino's own numbering, so a level threshold compares the same way. */
const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Named values attached to a line. Ids, counts, keys — never secrets. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * An `Error` as fields.
 *
 * The message and the error's own `name` always; the stack only at `debug`,
 * because a stack per failed frame decode is what makes a party's log unusable
 * — and the message plus the job key is what identifies the failure anyway.
 */
export function errorFields(err: unknown, withStack: boolean): LogFields {
  if (!(err instanceof Error)) return { err: String(err) };
  return {
    err: err.message,
    errName: err.name,
    ...(withStack && err.stack !== undefined ? { stack: err.stack } : {}),
  };
}

function write(stream: NodeJS.WriteStream, level: LogLevel, message: string, fields?: LogFields) {
  const line: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    proc: 'worker',
    msg: message,
    ...fields,
  };
  // A field that cannot be serialised must not take the process down over a
  // log line, so the whole record falls back to a plain string.
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ level, proc: 'worker', msg: message, fields: '[unserialisable]' });
  }
  stream.write(`${text}\n`);
}

/**
 * Builds a logger at `level`. Errors and warnings go to stderr, the rest to
 * stdout, so a container's error stream carries only the lines somebody is
 * paged about.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = SEVERITY[level];
  const at = (
    lineLevel: LogLevel,
    stream: NodeJS.WriteStream,
  ): ((message: string, fields?: LogFields) => void) => {
    if (SEVERITY[lineLevel] < threshold) return () => {};
    return (message, fields) => {
      write(stream, lineLevel, message, fields);
    };
  };

  return {
    level,
    debug: at('debug', process.stdout),
    info: at('info', process.stdout),
    warn: at('warn', process.stderr),
    error: at('error', process.stderr),
  };
}

/* --------------------------------------------------------- the process log -- */

let processLogger: Logger = createLogger('info');

/**
 * Points the module-level `log` at a configured logger.
 *
 * Modules import `log` at load time, before `main()` has read the environment,
 * so the binding has to be indirect: `configureLogger` swaps what the accessors
 * below delegate to. Until it is called the worker logs at `info`, which is what
 * a crash during configuration should still print.
 */
export function configureLogger(level: LogLevel): Logger {
  processLogger = createLogger(level);
  return processLogger;
}

export const log: Logger = {
  get level(): LogLevel {
    return processLogger.level;
  },
  debug: (message, fields) => {
    processLogger.debug(message, fields);
  },
  info: (message, fields) => {
    processLogger.info(message, fields);
  },
  warn: (message, fields) => {
    processLogger.warn(message, fields);
  },
  error: (message, fields) => {
    processLogger.error(message, fields);
  },
};
