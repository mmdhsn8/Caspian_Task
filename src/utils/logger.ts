export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getConfiguredLevel(): LogLevel {
  if (typeof process !== "undefined" && process.env.LOG_LEVEL) {
    const level = process.env.LOG_LEVEL.toLowerCase() as LogLevel;
    if (level in LOG_LEVELS) return level;
  }
  return "info";
}

export interface Logger {
  readonly name: string;
  readonly runId: string | null;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
  debug(message: string, ...meta: unknown[]): void;
}

function formatMeta(meta: unknown[]): string {
  if (meta.length === 0) return "";
  const serialized = meta
    .map((m: unknown) => {
      if (typeof m === "object" && m !== null) {
        try {
          const s = JSON.stringify(m);
          return typeof s === "string" ? s : "null";
        } catch {
          return Object.prototype.toString.call(m);
        }
      }
      return String(m);
    })
    .join(" ");
  if (serialized === "") return "";
  return " " + serialized;
}

function shouldLog(level: LogLevel, configured: LogLevel): boolean {
  return LOG_LEVELS[level] <= LOG_LEVELS[configured];
}

export function createLogger(name: string, runId?: string | null): Logger {
  const configured = getConfiguredLevel();
  const prefix = runId ? "[" + name + " " + runId + "]" : "[" + name + "]";

  function log(level: LogLevel, message: string, meta: unknown[]): void {
    if (!shouldLog(level, configured)) return;

    const timestamp = new Date().toISOString();
    const formatted =
      timestamp +
      " " +
      prefix +
      " " +
      level.toUpperCase() +
      " " +
      message +
      formatMeta(meta);

    if (level === "error") {
      process.stderr.write(formatted + "\n");
    } else {
      process.stdout.write(formatted + "\n");
    }
  }

  return {
    name,
    runId: runId ?? null,
    info: (message: string, ...meta: unknown[]) => {
      log("info", message, meta);
    },
    warn: (message: string, ...meta: unknown[]) => {
      log("warn", message, meta);
    },
    error: (message: string, ...meta: unknown[]) => {
      log("error", message, meta);
    },
    debug: (message: string, ...meta: unknown[]) => {
      log("debug", message, meta);
    },
  };
}

export { getConfiguredLevel };
