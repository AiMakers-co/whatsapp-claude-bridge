import { generateMessageID, jidNormalizedUser, type WASocket } from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { recordMessage, touchContact } from "./store.js";

/**
 * Resilient outbound send layer. sock.sendMessage rejects hard during
 * connection flaps (Boom: Connection Closed), and an unhandled rejection here
 * has killed the whole bridge before. safeSend() NEVER throws: it resolves the
 * CURRENT socket at every attempt (never a captured one), waits out
 * disconnects, retries, and as a last resort persists the message to
 * data/pending-sends.jsonl so it is delivered after the next successful
 * connect (or even after a process restart).
 *
 * Every logical message gets ONE pre-generated WhatsApp message id that is
 * remembered (sentIds) BEFORE the first attempt and reused across every retry
 * — WhatsApp dedupes by id server-side, so a send whose promise rejects after
 * the frame was actually delivered can neither double-deliver nor slip its
 * echo past the sentIds filter and run as a task.
 */

interface OutboundDeps {
  getSock: () => WASocket | undefined;
  isConnected: () => boolean;
  rememberSent: (id?: string | null) => void;
  /** True once WhatsApp permanently logged this session out (401). */
  loggedOut: () => boolean;
}

let deps: OutboundDeps | undefined;

/** Inject the live-socket getters once from index.ts (same pattern as api.ts). */
export function initOutbound(d: OutboundDeps): void {
  deps = d;
}

const dataDir = resolve(config.authDir, "..", "data");
export const pendingSendsFile = join(dataDir, "pending-sends.jsonl");

interface PendingSend {
  jid: string;
  text: string;
  ts: number; // unix ms when the send was queued
  /** Pre-generated WhatsApp message id, reused on every flush retry. */
  id?: string;
}

/** Total time safeSend waits for reconnection/retries before queueing. */
const SEND_WINDOW_MS = 3 * 60 * 1000;
/** Poll interval while waiting for the connection to come back. */
const POLL_MS = 2000;
/** Queued entries older than this are dropped, not delivered "(delayed)". */
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on the queue — beyond it the OLDEST entries are dropped. */
const QUEUE_MAX = 500;
/** Periodic drain pass while the queue is non-empty and we're connected. */
const DRAIN_INTERVAL_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * WhatsApp tolerates long text, but split to keep replies readable. Splits on
 * code-point boundaries: a chunk edge must never cut a surrogate pair in half
 * (a lone surrogate renders as U+FFFD in the delivered message).
 */
function chunk(text: string, size = 4000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end--; // high surrogate at the edge — back off
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * One raw attempt on the CURRENT socket with a caller-supplied message id.
 * Throws on failure. The caller must have called rememberSent(id) BEFORE the
 * first attempt with this id.
 */
async function sendOnce(jid: string, text: string, id: string): Promise<void> {
  if (!deps) throw new Error("outbound layer not initialised");
  const sock = deps.getSock();
  if (!sock || !deps.isConnected()) throw new Error("not connected");
  await sock.sendMessage(jid, { text }, { messageId: id });
  // Persist our own outgoing reply (echoes are filtered via sentIds, so
  // recording here is the only place this message is ever stored).
  recordMessage(jid, {
    ts: Math.floor(Date.now() / 1000),
    fromMe: true,
    sender: jidNormalizedUser(sock.user?.id ?? ""),
    senderName: "You",
    text,
  });
  touchContact(jid);
}

/** Retry within the window, waiting out disconnects. True = delivered. */
async function sendWithRetry(jid: string, text: string, id: string): Promise<boolean> {
  const deadline = Date.now() + SEND_WINDOW_MS;
  while (Date.now() < deadline) {
    // Permanently logged out (401): nothing will reconnect — fail fast to the
    // queue instead of burning the full window per chunk.
    if (deps?.loggedOut()) return false;
    // If we're disconnected, don't burn attempts — wait for the reconnect
    // loop (index.ts) to bring the socket back, then try again.
    if (!deps?.isConnected()) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      await sendOnce(jid, text, id);
      return true;
    } catch (e: any) {
      log.warn(`send to ${jid} failed (${e?.message ?? e}) — retrying...`);
      await sleep(POLL_MS);
    }
  }
  return false;
}

// ── On-disk queue (in-memory canonical copy, persisted synchronously) ───────
// All mutations go through the in-memory array and are persisted with a full
// atomic rewrite (tiny file, capped at QUEUE_MAX entries) — including after
// EACH successful flush send, so a crash mid-flush cannot re-send delivered
// entries on the next run.

let queue: PendingSend[] | undefined;

function loadQueue(): PendingSend[] {
  if (queue) return queue;
  queue = [];
  try {
    if (existsSync(pendingSendsFile)) {
      for (const line of readFileSync(pendingSendsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as PendingSend;
          if (e && typeof e.jid === "string" && typeof e.text === "string") queue.push(e);
        } catch {
          /* corrupt line — drop it */
        }
      }
    }
  } catch (e: any) {
    log.warn(`Could not read pending-sends queue: ${e?.message ?? e}`);
  }
  return queue;
}

function persistQueue(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${pendingSendsFile}.tmp`;
    writeFileSync(tmp, (queue ?? []).map((e) => JSON.stringify(e) + "\n").join(""));
    renameSync(tmp, pendingSendsFile);
  } catch (e: any) {
    log.error(`pending-sends queue persist failed: ${e?.message ?? e}`);
  }
}

/** Append a failed send to the queue (survives restarts). Never throws. */
function enqueuePending(jid: string, text: string, id: string): void {
  try {
    const q = loadQueue();
    q.push({ jid, text, ts: Date.now(), id });
    if (q.length > QUEUE_MAX) {
      const dropped = q.splice(0, q.length - QUEUE_MAX);
      for (const d of dropped) {
        log.error(
          `DROPPED oldest queued message to ${d.jid} (queue over ${QUEUE_MAX}): ${d.text.slice(0, 80)}`,
        );
      }
    }
    persistQueue();
    log.warn(`send to ${jid} queued to pending-sends.jsonl after retries exhausted`);
    scheduleDrain();
  } catch (e: any) {
    // Truly last-resort: nowhere left to put it — log the loss loudly.
    log.error(`DROPPED message to ${jid} (queue write failed: ${e?.message ?? e})`);
  }
}

// Periodic drain: entries can be queued while the connection is HEALTHY (a
// per-message failure that outlasts the window, or a flap ending right at the
// deadline) — the on-open flush alone would strand them until the next
// reconnect, potentially forever on a stable link.
let drainTimer: NodeJS.Timeout | undefined;

function scheduleDrain(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    if (loadQueue().length === 0) {
      clearInterval(drainTimer);
      drainTimer = undefined;
      return;
    }
    if (deps?.isConnected()) void flushPending();
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

/**
 * Send `text` to `jid`, chunked, resilient. NEVER throws — a message that
 * can't be delivered within the retry window lands in the pending queue and
 * is flushed on the next successful connect (or by the drain timer).
 * Chunk-order invariant: once one chunk is queued, every later chunk of the
 * same message is queued too — a later chunk never overtakes an earlier one.
 */
export async function safeSend(jid: string, text: string): Promise<void> {
  let queueRest = false;
  for (const part of chunk(text)) {
    // Per-jid ordering across CALLS too: if earlier messages to this chat are
    // still queued, a live send now would overtake them — queue behind them.
    if (!queueRest && loadQueue().some((e) => e.jid === jid)) queueRest = true;
    // Pre-generate + remember the id BEFORE the first attempt: a send that is
    // delivered but rejects late still has its echo filtered, and every retry
    // reuses the id so WhatsApp dedupes server-side.
    const id = generateMessageID();
    deps?.rememberSent(id);
    if (!queueRest) {
      try {
        if (await sendWithRetry(jid, part, id)) continue;
      } catch (e: any) {
        // sendWithRetry shouldn't throw, but safeSend's contract is absolute.
        log.error(`safeSend unexpected failure for ${jid}: ${e?.message ?? e}`);
      }
      queueRest = true;
    }
    enqueuePending(jid, part, id);
  }
}

let flushing = false;
let rerunWanted = false;

/**
 * Deliver the pending queue through the current socket (oldest first) —
 * called on every successful connection open and by the drain timer. If a
 * flush is already running, the request is latched and re-run right after
 * (never silently dropped).
 */
export async function flushPending(): Promise<void> {
  if (flushing) {
    rerunWanted = true;
    return;
  }
  flushing = true;
  try {
    do {
      rerunWanted = false;
      await flushQueueOnce();
    } while (rerunWanted);
  } catch (e: any) {
    log.warn(`flushPending failed: ${e?.message ?? e}`);
  } finally {
    flushing = false;
  }
  if (loadQueue().length > 0) scheduleDrain();
}

async function flushQueueOnce(): Promise<void> {
  const q = loadQueue();
  if (q.length === 0) return;
  // TTL: a backlog from a dead period must not dump days-old messages into
  // chats where they are no longer wanted.
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const expired = q.filter((e) => (e.ts ?? 0) < cutoff);
  if (expired.length) {
    for (const e of expired) {
      log.warn(`Dropping expired (>24h) queued send to ${e.jid}: ${e.text.slice(0, 80)}`);
    }
    queue = q.filter((e) => (e.ts ?? 0) >= cutoff);
    persistQueue();
  }
  let delivered = 0;
  // Per-jid FIFO: once an entry for a jid fails this pass, every later entry
  // for the SAME jid is skipped — a later chunk (or later message) must never
  // overtake an earlier one. Other jids keep draining.
  const failedJids = new Set<string>();
  // Snapshot: entries enqueued while we await below are picked up by the
  // rerun latch / drain timer, not mid-iteration.
  for (const entry of [...loadQueue()]) {
    if (!deps?.isConnected()) break;
    if (failedJids.has(entry.jid)) continue;
    if (!entry.id) {
      // Legacy entry from before ids were persisted — assign one now so the
      // echo filter and server-side dedupe still apply.
      entry.id = generateMessageID();
      persistQueue();
    }
    // Re-remember unconditionally: an entry can sit queued for hours, long
    // enough for its id to be LRU-evicted from sentIds — its echo would then
    // pass the filter and run as a task. Refresh recency before every attempt.
    deps.rememberSent(entry.id);
    try {
      // "(delayed)" so the recipient understands why this arrives late.
      await sendOnce(entry.jid, `(delayed) ${entry.text}`, entry.id);
      const cur = loadQueue();
      const i = cur.indexOf(entry);
      if (i >= 0) cur.splice(i, 1);
      // Persist after EACH success: a crash mid-flush can't re-send what was
      // already delivered (id reuse makes redelivery harmless anyway).
      persistQueue();
      delivered++;
    } catch (e: any) {
      failedJids.add(entry.jid); // preserve per-jid order — skip its later entries
      log.warn(`pending send to ${entry.jid} still failing: ${e?.message ?? e}`);
    }
  }
  if (delivered) {
    log.info(`Flushed ${delivered} pending send(s); ${loadQueue().length} remain queued.`);
  }
}
