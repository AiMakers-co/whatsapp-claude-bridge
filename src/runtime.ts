import { existsSync, readFileSync } from "node:fs";
import { pendingSendsFile } from "./outbound.js";

/**
 * In-memory runtime state for observability (dashboard / control API).
 * Purely additive: nothing here influences message handling — it's a ring
 * buffer of recent tasks plus a few connection counters.
 */

export interface TaskRecord {
  jid: string;
  chatName?: string;
  kind: "group" | "mention" | "job";
  preview: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error" | "timeout" | "cancelled";
  costUsd?: number;
  provider: string;
}

const TASKS_LIMIT = 100; // ring buffer size

// pendingSendsCount is called per dashboard poll — cache the line count ~2s
// so it never turns into a hot filesystem read.
let pendingCache = 0;
let pendingCacheAt = 0;

export const runtime = {
  startedAt: Date.now(),
  reconnects: 0,
  lastConnectedAt: undefined as number | undefined,
  loggedOut: false,
  tasks: [] as TaskRecord[],
  pendingSendsCount(): number {
    const now = Date.now();
    if (now - pendingCacheAt < 2000) return pendingCache;
    pendingCacheAt = now;
    try {
      pendingCache = existsSync(pendingSendsFile)
        ? readFileSync(pendingSendsFile, "utf8").split("\n").filter(Boolean).length
        : 0;
    } catch {
      pendingCache = 0;
    }
    return pendingCache;
  },
};

/** Record a task starting; returns the record to pass to taskFinished(). */
export function taskStarted(init: {
  jid: string;
  chatName?: string;
  kind: "group" | "mention" | "job";
  preview: string;
  provider: string;
}): TaskRecord {
  const rec: TaskRecord = { ...init, startedAt: Date.now(), status: "running" };
  runtime.tasks.push(rec);
  if (runtime.tasks.length > TASKS_LIMIT) runtime.tasks.shift();
  return rec;
}

/** Close out a task record (sets endedAt, applies status/cost patch). */
export function taskFinished(rec: TaskRecord, patch: Partial<TaskRecord>): void {
  Object.assign(rec, { endedAt: Date.now() }, patch);
}
