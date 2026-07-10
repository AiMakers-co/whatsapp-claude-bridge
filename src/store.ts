import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Lightweight persistent message store. Every incoming + outgoing message
 * (text or caption; protocol/system messages are skipped by the callers) is
 * appended as JSONL to data/messages/<sanitized-jid>.jsonl, and a small
 * contacts index (jid -> name/lastSeen) lives in data/contacts.json.
 *
 * Design constraints: strictly non-blocking (fire-and-forget appendFile,
 * debounced contacts save), errors are swallowed to the log — the store must
 * NEVER be able to break message handling or take the bridge down.
 *
 * History accumulates from the moment this shipped (2026-07-03); there is no
 * backfill of older WhatsApp history.
 */

const dataDir = resolve(config.authDir, "..", "data");
const messagesDir = join(dataDir, "messages");
const mediaStoreDir = join(dataDir, "media");
const contactsFile = join(dataDir, "contacts.json");
const chatsFile = join(dataDir, "chats.json");
const sentIdsFile = join(dataDir, "sent-ids.json");
const processedIdsFile = join(dataDir, "processed-ids.json");
const groupsFile = join(dataDir, "groups.json");

/**
 * Load a JSON file, tolerating corruption: a file that no longer PARSES is
 * renamed aside (never overwritten in place) so its contents can be inspected,
 * and the caller starts fresh instead of crashing. A READ error (EACCES, EIO,
 * ...) is transient environment trouble, not corruption — the file may be
 * perfectly valid, so it is left untouched and only logged.
 */
function loadJsonSafe<T>(file: string, label: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      log.warn(`${label} could not be read (${e?.message ?? e}) — starting fresh, file left in place.`);
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
      log.warn(`${label} was corrupt — moved to ${aside}, starting fresh: ${e?.message ?? e}`);
    } catch {
      log.warn(`${label} was corrupt and could not be moved aside: ${e?.message ?? e}`);
    }
    return undefined;
  }
}

/**
 * Debounced atomic JSON saver (2s coalesce, tmp file + rename so a crash or
 * power cut mid-write can never leave a truncated file behind). Each call
 * replaces the pending snapshot, so the write always reflects the latest data.
 * Every saver registers an exit-flush hook so flushAllNow() (SIGTERM/SIGINT
 * handler in index.ts) can synchronously write any pending snapshot before
 * the process dies — otherwise a launchd restart within the 2s window would
 * silently drop the last save.
 */
const pendingFlushers: Array<() => void> = [];

/** Synchronously flush every debounced saver with a pending write. */
export function flushAllNow(): void {
  for (const f of pendingFlushers) {
    try {
      f();
    } catch {
      /* keep flushing the rest */
    }
  }
}

function debouncedAtomicSaver<T>(file: string, label: string): (data: T) => void {
  let timer: NodeJS.Timeout | null = null;
  let latest: T;
  let writing: Promise<void> = Promise.resolve();
  pendingFlushers.push(() => {
    if (!timer) return; // nothing pending
    clearTimeout(timer);
    timer = null;
    try {
      // Distinct tmp path: the async saver may still hold an open fd on
      // `${file}.tmp` — a sync write to the same path could interleave and
      // rename a corrupt file into place.
      const tmp = `${file}.tmp-exit`;
      writeFileSync(tmp, JSON.stringify(latest, null, 2));
      renameSync(tmp, file);
    } catch (e: any) {
      log.warn(`${label} exit flush failed: ${e?.message ?? e}`);
    }
  });
  return (data: T) => {
    latest = data;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const tmp = `${file}.tmp`;
      // Chain onto the previous write: two fires share the same tmp path, so
      // an overlap could interleave writes or rename a half-written file.
      writing = writing
        .then(() => writeFile(tmp, JSON.stringify(latest, null, 2)))
        .then(() => rename(tmp, file))
        .catch((e) => log.warn(`${label} save failed: ${e?.message ?? e}`));
    }, 2000);
    // Never keep the process alive just for a pending save.
    timer.unref?.();
  };
}

export interface StoredMessage {
  ts: number; // unix seconds
  fromMe: boolean;
  sender: string; // jid of the author
  senderName: string;
  text: string;
  mediaType?: string; // image | video | audio | document (when an attachment)
  mediaPath?: string; // absolute path to the stored media file (Feature 3)
}

interface Contact {
  name?: string; // pushName for DMs, group subject for groups
  lastSeen: number; // unix seconds of last message either direction
}

const contacts = new Map<string, Contact>();
const saveContacts = debouncedAtomicSaver<Record<string, Contact>>(contactsFile, "contacts.json");

// One-time synchronous init at module load (cheap; before any messages flow).
try {
  mkdirSync(messagesDir, { recursive: true });
  const raw = loadJsonSafe<Record<string, Contact>>(contactsFile, "contacts.json");
  for (const [jid, c] of Object.entries(raw ?? {})) {
    if (c && typeof c.lastSeen === "number") contacts.set(jid, c);
  }
} catch (e: any) {
  log.warn(`Message store init failed (store disabled-ish, bridge unaffected): ${e?.message ?? e}`);
}

function scheduleContactsSave(): void {
  const obj: Record<string, Contact> = {};
  for (const [jid, c] of contacts) obj[jid] = c;
  saveContacts(obj);
}

// ── Persisted bridge state (chats / echo-filter ids / group ids) ───────────
// Same debounced-atomic pattern as contacts, so state survives restarts:
// chats.json keeps per-chat session/cwd/provider, sent-ids.json closes the
// restart echo-reprocess hole, groups.json pins resolved group JIDs so a
// rename or subject clash can never trigger duplicate group creation.

/** Serializable slice of per-chat state (never `busy` — that's runtime-only). */
export interface PersistedChat {
  /**
   * Legacy single resume id (pre per-provider sessions). Still READ on load so
   * old chats.json files migrate cleanly — it's attributed to `provider` — but
   * no longer WRITTEN; new state persists `sessions` instead.
   */
  sessionId?: string;
  /**
   * Resume ids keyed by provider for plain tasks or by call-sign/provider for
   * explicit mention routes. The provider key remains a legacy fallback.
   */
  sessions?: Record<string, string>;
  cwd: string;
  provider: string;
}

export const saveChats = debouncedAtomicSaver<Record<string, PersistedChat>>(
  chatsFile,
  "chats.json",
);

export function loadChats(): Record<string, PersistedChat> {
  const raw = loadJsonSafe<Record<string, PersistedChat>>(chatsFile, "chats.json") ?? {};
  const out: Record<string, PersistedChat> = {};
  for (const [jid, c] of Object.entries(raw)) {
    if (c && typeof c.cwd === "string" && typeof c.provider === "string") out[jid] = c;
  }
  return out;
}

/**
 * Unlike the other saves, id lists are written SYNCHRONOUSLY (still tmp+rename
 * atomic): the ids most likely to be missing after a crash/kill are exactly
 * the last ones before it, which is precisely the restart reprocess hole these
 * files exist to close. Tiny files (<=2000 short strings) — cost is negligible.
 */
function saveIdListSync(file: string, label: string, ids: string[]): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(ids, null, 2));
    renameSync(tmp, file);
  } catch (e: any) {
    log.warn(`${label} save failed: ${e?.message ?? e}`);
  }
}

function loadIdList(file: string, label: string): string[] {
  const raw = loadJsonSafe<string[]>(file, label);
  return Array.isArray(raw) ? raw.filter((id) => typeof id === "string").slice(-2000) : [];
}

/** IDs of messages the bridge itself sent (outbound echo filter). */
export function saveSentIds(ids: string[]): void {
  saveIdListSync(sentIdsFile, "sent-ids.json", ids);
}

export function loadSentIds(): string[] {
  return loadIdList(sentIdsFile, "sent-ids.json");
}

/**
 * IDs of INCOMING messages already handled. WhatsApp redelivers un-acked
 * messages on reconnect — without this, a flap in the receive-to-ack window
 * re-runs the same task after the reconnect (or a restart).
 */
export function saveProcessedIds(ids: string[]): void {
  saveIdListSync(processedIdsFile, "processed-ids.json", ids);
}

export function loadProcessedIds(): string[] {
  return loadIdList(processedIdsFile, "processed-ids.json");
}

export const saveGroups = debouncedAtomicSaver<Record<string, string>>(groupsFile, "groups.json");

/** Persisted monitored-group resolution: group name -> group jid. */
export function loadGroups(): Record<string, string> {
  const raw = loadJsonSafe<Record<string, string>>(groupsFile, "groups.json") ?? {};
  const out: Record<string, string> = {};
  for (const [name, jid] of Object.entries(raw)) {
    if (typeof jid === "string" && jid.endsWith("@g.us")) out[name] = jid;
  }
  return out;
}

/** Display name from the contacts index, if known. */
export function getContactName(jid: string): string | undefined {
  return contacts.get(jid)?.name;
}

function sanitizeJid(jid: string): string {
  return jid.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 120) || "unknown";
}

/**
 * Absolute per-chat directory under data/media/ where incoming media is kept
 * (Feature 3). The caller creates it lazily; the sanitized-jid layout matches
 * data/messages/ so a chat's files and JSONL sit under parallel names.
 */
export function mediaDirForJid(jid: string): string {
  return join(mediaStoreDir, sanitizeJid(jid));
}

/** Update the contacts index. `name` only overwrites when provided. */
export function touchContact(jid: string, name?: string, ts?: number): void {
  const c = contacts.get(jid) ?? { lastSeen: 0 };
  if (name && name.trim()) c.name = name.trim();
  c.lastSeen = Math.max(c.lastSeen, ts ?? Math.floor(Date.now() / 1000));
  contacts.set(jid, c);
  scheduleContactsSave();
}

/**
 * Append one message to the chat's JSONL file. Fire-and-forget, but appends
 * to the SAME file are chained on a per-file promise so concurrent writers
 * (incoming persist racing an outgoing record) can't land out of order.
 */
const appendChains = new Map<string, Promise<void>>();

export function recordMessage(jid: string, m: StoredMessage): void {
  const file = join(messagesDir, sanitizeJid(jid) + ".jsonl");
  const line = JSON.stringify(m) + "\n";
  const prev = appendChains.get(file) ?? Promise.resolve();
  const next = prev
    .then(() => appendFile(file, line))
    .catch((e) => log.warn(`store append failed for ${jid}: ${e?.message ?? e}`));
  appendChains.set(file, next);
  void next.finally(() => {
    if (appendChains.get(file) === next) appendChains.delete(file);
  });
}

export interface ChatSummary {
  jid: string;
  name: string;
  lastTs: number;
  kind: "group" | "dm";
}

/** All known chats from the contacts index, most recent first. */
export function listChats(): ChatSummary[] {
  return [...contacts.entries()]
    .map(([jid, c]) => ({
      jid,
      name: c.name ?? jid.split("@")[0],
      lastTs: c.lastSeen,
      kind: (jid.endsWith("@g.us") ? "group" : "dm") as "group" | "dm",
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

/** Last `limit` stored messages for a jid (empty array if none). */
export async function readHistory(jid: string, limit = 50): Promise<StoredMessage[]> {
  try {
    const raw = await readFile(join(messagesDir, sanitizeJid(jid) + ".jsonl"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((l) => {
        try {
          return JSON.parse(l) as StoredMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is StoredMessage => m !== null);
  } catch {
    return [];
  }
}

/**
 * Resolve a human name to a jid via the contacts index.
 * - exactly one exact (case-insensitive) name match wins outright;
 * - otherwise exactly one substring match wins;
 * - multiple matches -> candidates (caller must NOT guess);
 * - none -> null.
 */
export function resolveByName(
  q: string,
): { jid: string } | { candidates: Array<{ jid: string; name: string }> } | null {
  const needle = q.trim().toLowerCase();
  if (!needle) return null;
  const all = [...contacts.entries()].map(([jid, c]) => ({ jid, name: c.name ?? "" }));
  const exact = all.filter((c) => c.name.toLowerCase() === needle);
  if (exact.length === 1) return { jid: exact[0].jid };
  const partial = all.filter((c) => c.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { jid: partial[0].jid };
  if (partial.length > 1) return { candidates: partial.slice(0, 10) };
  if (exact.length > 1) return { candidates: exact.slice(0, 10) };
  return null;
}
