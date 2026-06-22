import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

/**
 * Tiny dual logger: human-readable lines to the console AND appended to
 * `logs/bridge.log` so a backgrounded/launchd run leaves an audit trail.
 */
const logDir = resolve(config.authDir, "..", "logs");
mkdirSync(logDir, { recursive: true });
export const logFile = resolve(logDir, "bridge.log");
const stream = createWriteStream(logFile, { flags: "a" });

function write(level: string, args: unknown[]) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `${nowIso()} ${level.padEnd(5)} ${msg}`;
  // eslint-disable-next-line no-console
  (level === "ERROR" ? console.error : console.log)(line);
  stream.write(line + "\n");
}

function nowIso(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...a: unknown[]) => write("INFO", a),
  warn: (...a: unknown[]) => write("WARN", a),
  error: (...a: unknown[]) => write("ERROR", a),
};
