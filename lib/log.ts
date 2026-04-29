// Structured JSON logging — one line per event so Vercel log search works.
// Each request gets a `reqId` so all logs from one HTTP call can be grouped.

import crypto from "crypto";

type Level = "info" | "warn" | "error";

interface LogFields {
  [k: string]: unknown;
}

function emit(level: Level, route: string, event: string, fields: LogFields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    route,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function newReqId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export interface Logger {
  reqId: string;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
}

export function makeLogger(route: string, reqId: string = newReqId()): Logger {
  return {
    reqId,
    info: (event, fields = {}) => emit("info", route, event, { reqId, ...fields }),
    warn: (event, fields = {}) => emit("warn", route, event, { reqId, ...fields }),
    error: (event, fields = {}) => emit("error", route, event, { reqId, ...fields }),
  };
}

/** Pull a useful message + name out of any thrown value. */
export function errInfo(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}
