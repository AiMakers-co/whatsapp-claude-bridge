import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  generateMessageID,
  jidNormalizedUser,
  DisconnectReason,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { config, monitoredGroupConfigs, type GroupConfig } from "./config.js";
import { getProvider, providerNames } from "./providers.js";
import {
  detectAttachment,
  saveIncoming,
  flushOutbox,
  isolateOrphans,
  orphanTaskOutbox,
  removeTaskOutbox,
  type OutboxResult,
} from "./media.js";
import { log } from "./logger.js";
import { showQr } from "./qr.js";
import { mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { startApi } from "./api.js";
import {
  flushAllNow,
  getContactName,
  recordMessage,
  loadChats,
  loadGroups,
  loadProcessedIds,
  loadSentIds,
  saveChats,
  saveGroups,
  saveProcessedIds,
  saveSentIds,
  touchContact,
  type PersistedChat,
} from "./store.js";
import { initOutbound, safeSend, flushPending } from "./outbound.js";
import { runtime, taskStarted, taskFinished } from "./runtime.js";

/** Per-chat conversation state: provider, session to resume, working dir. */
interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
  provider: string;
  /**
   * Monotonically increasing state generation. /new, /cd and /use bump it;
   * a task captures it at dispatch and its completion writeback only applies
   * if the generation is unchanged — a control command issued while the task
   * ran must never be silently undone by the task finishing.
   */
  generation: number;
  /** One-shot warning (e.g. restored cwd vanished) delivered on next use. */
  pendingWarn?: string;
}
const chats = new Map<string, ChatState>();

/**
 * Working dirs with a task in flight (cwd -> running count). `busy` is
 * per-chat, but chats can SHARE a workdir (the mention path defaults to
 * config.workdir — same as the primary group). isolateOrphans must never
 * quarantine another chat's in-flight outbox files, so it only runs when the
 * cwd is otherwise idle.
 */
const busyCwds = new Map<string, number>();
function cwdTaskStarted(cwd: string): void {
  busyCwds.set(cwd, (busyCwds.get(cwd) ?? 0) + 1);
}
function cwdTaskFinished(cwd: string): void {
  const n = (busyCwds.get(cwd) ?? 1) - 1;
  if (n <= 0) busyCwds.delete(cwd);
  else busyCwds.set(cwd, n);
}

// Restore per-chat state (session/cwd/provider — never busy) from the last
// run, so a restart doesn't wipe every conversation's continuity. A restored
// cwd that no longer exists falls back to the config default now (a task
// spawn there would fail with a misleading ENOENT, or worse, an attachment's
// mkdir would silently resurrect the deleted path) — the user gets warned on
// next use via pendingWarn.
{
  let fixed = false;
  for (const [jid, s] of Object.entries(loadChats())) {
    let cwd = s.cwd;
    let sessionId = s.sessionId;
    let pendingWarn: string | undefined;
    let ok = false;
    try {
      ok = !!cwd && statSync(cwd).isDirectory();
    } catch {
      /* missing */
    }
    if (!ok) {
      log.warn(`[${jid}] restored working dir no longer exists (${cwd}) — falling back to ${config.workdir}`);
      pendingWarn = `⚠️ Your previous working dir no longer exists:\n${cwd}\nFell back to:\n${config.workdir}\n(session reset)`;
      cwd = config.workdir;
      sessionId = undefined;
      fixed = true;
    }
    chats.set(jid, { sessionId, cwd, provider: s.provider, busy: false, generation: 0, pendingWarn });
  }
  if (fixed) persistChats();
}

/** Snapshot the chats map to data/chats.json (debounced + atomic in store). */
function persistChats(): void {
  const obj: Record<string, PersistedChat> = {};
  for (const [jid, c] of chats) {
    obj[jid] = { ...(c.sessionId ? { sessionId: c.sessionId } : {}), cwd: c.cwd, provider: c.provider };
  }
  saveChats(obj);
}

/**
 * IDs of messages WE sent. In note-to-self (and some group setups) our own
 * outgoing replies echo back through messages.upsert as fromMe messages — if
 * we don't filter them out, the bridge answers its own replies in an infinite
 * loop. Tracking sent ids and skipping them is the reliable fix. Persisted to
 * data/sent-ids.json so a restart can't reprocess echoes of pre-restart sends.
 */
const sentIds = new Set<string>(loadSentIds());
function rememberSent(id?: string | null): void {
  if (!id) return;
  // Delete-then-add so re-remembering an id refreshes its LRU recency —
  // Set.add of an existing member does NOT move it, and queued sends
  // re-remember their id at flush time to survive eviction.
  sentIds.delete(id);
  sentIds.add(id);
  if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value as string);
  saveSentIds([...sentIds]);
}

/**
 * IDs of INCOMING messages already handled (LRU, persisted). WhatsApp
 * redelivers messages whose receipt ack didn't flush before a socket drop —
 * without this, a reconnect (or restart) re-runs the same message as a brand
 * new autonomous task.
 */
const processedIds = new Set<string>(loadProcessedIds());
function rememberProcessed(id: string): void {
  processedIds.add(id);
  if (processedIds.size > 2000) processedIds.delete(processedIds.values().next().value as string);
  saveProcessedIds([...processedIds]);
}

/**
 * JID -> group config, for every group the bridge monitors. The bridge ONLY
 * acts inside these groups (hard lock). Until resolved on connect this is empty
 * and nothing is processed — the safe default.
 */
const monitoredGroups = new Map<string, GroupConfig>();

/**
 * Live socket + connection state for the local control API (src/api.ts).
 * start() reassigns the socket on every reconnect, so the API reads these
 * through getters instead of capturing a stale sock.
 */
let currentSock: ReturnType<typeof makeWASocket> | undefined;
let isConnected = false;

// Resilient send layer (src/outbound.ts) reads the LIVE socket through the
// same getters — a long-running task never sends through a stale socket.
initOutbound({
  getSock: () => currentSock,
  isConnected: () => isConnected,
  rememberSent,
  loggedOut: () => runtime.loggedOut,
});

// ── Process-level backstops ─────────────────────────────────────────────────
// Log-forensics showed uncaught Boom rejections (sock.sendMessage during a
// connection flap) killing the whole bridge. Sends are now resilient via
// outbound.ts, but nothing async in a Baileys event chain may ever take the
// process down again — log it and keep serving.
process.on("unhandledRejection", (reason: any) => {
  log.error(`Unhandled rejection: ${reason?.message ?? reason}${reason?.stack ? `\n${reason.stack}` : ""}`);
});
process.on("uncaughtException", (err: any) => {
  log.error(`Uncaught exception: ${err?.message ?? err}${err?.stack ? `\n${err.stack}` : ""}`);
});

// ── Exit flush ──────────────────────────────────────────────────────────────
// Debounced state saves (chats/groups/contacts) coalesce on unref'd 2s timers;
// a launchd unload (SIGTERM) within that window would silently drop the last
// save. Flush synchronously on the way out so restarts are lossless.
let exiting = false;
function exitWithFlush(sig: string, code: number): void {
  if (exiting) return;
  exiting = true;
  log.info(`Received ${sig} — flushing pending state saves, exiting.`);
  try {
    flushAllNow();
  } catch {
    /* exit regardless */
  }
  process.exit(code);
}
process.on("SIGTERM", () => exitWithFlush("SIGTERM", 0)); // never delivered on Windows; harmless to register
process.on("SIGINT", () => exitWithFlush("SIGINT", 130));
if (process.platform === "win32") {
  // Windows has no SIGTERM: Ctrl+Break (and some service managers stopping a
  // console process) surfaces as SIGBREAK instead.
  process.on("SIGBREAK", () => exitWithFlush("SIGBREAK", 0));
}
process.on("beforeExit", () => {
  try {
    flushAllNow();
  } catch {
    /* nothing more to do */
  }
});
// Last-resort flush on any exit path (process.exit calls, fatal errors that
// still unwind). 'exit' handlers must be synchronous — flushAllNow is.
process.on("exit", () => {
  try {
    flushAllNow();
  } catch {
    /* nothing more to do */
  }
});

/**
 * Rolling per-chat message buffer, for the "@computer" mention trigger below.
 * Kept for every chat (not just monitored groups) so that when the trigger
 * fires, there's recent conversation to read. Capped per-chat and globally so
 * memory can't grow unbounded over a long-running process.
 */
interface HistoryEntry {
  label: string;
  text: string;
  ts: number;
}
const MENTION_HISTORY_LIMIT = 30; // messages kept per chat
const MENTION_CHATS_LIMIT = 300; // chats tracked before the oldest is evicted
const chatHistory = new Map<string, HistoryEntry[]>();

function bufferHistory(jid: string, entry: HistoryEntry): void {
  const hist = chatHistory.get(jid) ?? [];
  chatHistory.delete(jid); // re-set below to move this chat to MRU position
  hist.push(entry);
  if (hist.length > MENTION_HISTORY_LIMIT) hist.shift();
  chatHistory.set(jid, hist);
  if (chatHistory.size > MENTION_CHATS_LIMIT) {
    const oldest = chatHistory.keys().next().value as string | undefined;
    if (oldest) chatHistory.delete(oldest);
  }
}

function formatHistory(jid: string): string {
  const hist = chatHistory.get(jid) ?? [];
  return hist
    .map((e) => {
      const t = new Date(e.ts * 1000);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      return `[${hh}:${mm}] ${e.label}: ${e.text}`;
    })
    .join("\n");
}

/**
 * Find-or-create every configured group and record its JID -> config. On first
 * creation, add any configured participants and greet once. Reconnects re-adopt
 * existing groups silently. If a group can't be set up the others still work.
 * A failed or partial run schedules its own retry with backoff — a fetch that
 * fails once right after 'open' (the common case, while the socket settles
 * under offline-notification load) must not leave the bridge idle until the
 * next reconnect, which on a stable link may never come.
 */
let ensuringGroups = false; // single-flight: overlapping runs could create duplicate groups
const GROUPS_RETRY_BASE_MS = 30_000;
const GROUPS_RETRY_MAX_MS = 10 * 60_000;
let groupsRetryMs = GROUPS_RETRY_BASE_MS;
let groupsRetryTimer: NodeJS.Timeout | undefined;

function scheduleGroupsRetry(): void {
  if (groupsRetryTimer) return;
  const delay = groupsRetryMs;
  groupsRetryMs = Math.min(groupsRetryMs * 2, GROUPS_RETRY_MAX_MS);
  log.warn(`Group setup incomplete — retrying in ${Math.round(delay / 1000)}s.`);
  groupsRetryTimer = setTimeout(() => {
    groupsRetryTimer = undefined;
    // Only while connected — a disconnect's next 'open' reruns setup anyway.
    if (isConnected && monitoredGroups.size < monitoredGroupConfigs.length) void ensureGroups();
  }, delay);
  groupsRetryTimer.unref?.();
}

async function ensureGroups(): Promise<void> {
  if (!config.createGroup) return;
  if (ensuringGroups) return;
  ensuringGroups = true;
  try {
    await ensureGroupsInner();
  } finally {
    ensuringGroups = false;
    if (monitoredGroups.size < monitoredGroupConfigs.length) {
      if (isConnected) scheduleGroupsRetry();
    } else {
      groupsRetryMs = GROUPS_RETRY_BASE_MS; // fully resolved — reset backoff
    }
  }
}

async function ensureGroupsInner(): Promise<void> {
  // Resolve the LIVE socket at every step: a run can straddle a reconnect,
  // and a captured pre-reconnect socket only produces dead-socket failures.
  const fetchSock = currentSock;
  if (!fetchSock || !isConnected) return;
  let all: Record<string, any> = {};
  try {
    all = await fetchSock.groupFetchAllParticipating();
  } catch (e: any) {
    log.warn(`Could not fetch groups: ${e?.message ?? e}. Will retry with backoff.`);
    return;
  }
  // Cheap win for the contacts index: record every participating group's
  // subject so /chats and name-resolution know group names immediately.
  try {
    for (const g of Object.values(all)) {
      if (g?.id && g?.subject) touchContact(g.id, g.subject, 0);
    }
  } catch {
    /* index only — never block group setup */
  }
  // Prefer the persisted name -> jid resolution (data/groups.json) over
  // subject matching: a renamed group or a stale fetch can otherwise trigger
  // a duplicate groupCreate on the next boot.
  const persisted = loadGroups();
  const alreadyResolved = new Set(monitoredGroups.values());
  for (const gc of monitoredGroupConfigs) {
    if (alreadyResolved.has(gc)) continue; // resolved on an earlier run — keep it
    // Live socket per group; abort early on disconnect (the on-open rerun
    // picks the remainder up with a fresh fetch).
    const sock = currentSock;
    if (!sock || !isConnected) return;
    try {
      const savedJid = persisted[gc.name];
      if (savedJid && all[savedJid]) {
        monitoredGroups.set(savedJid, gc);
        log.info(`Using persisted "${gc.name}" group (${savedJid}) -> ${gc.workdir}`);
        continue;
      }
      const existing = Object.values(all).find((g: any) => g.subject === gc.name);
      if (existing) {
        monitoredGroups.set(existing.id, gc);
        log.info(`Using existing "${gc.name}" group (${existing.id}) -> ${gc.workdir}`);
        continue;
      }
      // Create with participants in one shot; some may fail silently if the
      // person's privacy settings block being added — the group still forms.
      const res = await sock.groupCreate(gc.name, gc.participants);
      monitoredGroups.set(res.id, gc);
      log.info(`Created "${gc.name}" group (${res.id}) -> ${gc.workdir}`);
      const who = gc.allowedJids.length
        ? `\nAuthorised: you + ${gc.allowedJids.length} other(s).`
        : "";
      const welcomeId = generateMessageID();
      rememberSent(welcomeId); // BEFORE the send — echo-filter even on late rejection
      await sock.sendMessage(
        res.id,
        {
          text:
            `👋 *${gc.name}* is live.\n\n` +
            `Send a task and I'll run it with Claude Code in:\n${gc.workdir}${who}\n\n` +
            `Control: /new  ·  /cd <path>  ·  /use <provider>  ·  /status`,
        },
        { messageId: welcomeId },
      );
    } catch (e: any) {
      log.warn(`Could not set up "${gc.name}" group: ${e?.message ?? e}. Skipping it.`);
    }
  }
  // Persist the resolution (name -> jid) for the next boot. MERGED over the
  // existing file: a group that failed this run must keep its pinned jid, or
  // a renamed group would groupCreate a duplicate on the next boot.
  const resolved: Record<string, string> = {};
  for (const [jid, gc] of monitoredGroups) resolved[gc.name] = jid;
  saveGroups({ ...loadGroups(), ...resolved });
}

function getChat(jid: string, defaultCwd: string): ChatState {
  let c = chats.get(jid);
  if (!c) {
    c = { cwd: defaultCwd, busy: false, provider: config.provider, generation: 0 };
    chats.set(jid, c);
    persistChats();
  }
  return c;
}

/**
 * Task-start guard: a chat cwd can vanish AFTER it was set (/cd'd dir deleted
 * later). Without this, a text task fails with a misleading "is claude
 * installed?" ENOENT, and an attachment task silently RESURRECTS the deleted
 * path via inbox mkdir. Falls back to the given default and queues a warning.
 * Returns false when the FALLBACK is missing too (e.g. the configured default
 * workdir was deleted) — the caller must refuse dispatch, or the task's
 * outbox/inbox mkdir would silently resurrect the deleted directory tree.
 */
function ensureCwdValid(chat: ChatState, fallback: string): boolean {
  try {
    if (statSync(chat.cwd).isDirectory()) return true;
  } catch {
    /* missing */
  }
  let fallbackOk = false;
  try {
    fallbackOk = statSync(fallback).isDirectory();
  } catch {
    /* missing */
  }
  if (!fallbackOk) {
    log.error(`[cwd] ${chat.cwd} missing and fallback ${fallback} missing too — refusing dispatch`);
    return false;
  }
  const old = chat.cwd;
  chat.cwd = fallback;
  chat.sessionId = undefined;
  persistChats();
  chat.pendingWarn = `⚠️ Working dir no longer exists:\n${old}\nFell back to:\n${fallback}\n(session reset)`;
  log.warn(`[cwd] ${old} no longer exists — fell back to ${fallback}`);
  return true;
}

/** Extract plain text from the many WhatsApp message shapes. */
function extractText(msg: WAMessage): string | undefined {
  const m = msg.message;
  if (!m) return undefined;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    undefined
  );
}

// Replies go through safeSend (src/outbound.ts): chunked, retried across
// reconnects, queued to disk as a last resort — and it NEVER throws.

/**
 * Persist an incoming (or phone-typed fromMe) message into the JSONL store.
 * Purely additive observation — must never throw into message handling.
 */
function persistMessage(msg: WAMessage, remoteJid: string): void {
  try {
    if (remoteJid.endsWith("@broadcast")) return; // status updates etc.
    const text = extractText(msg)?.trim();
    const att = detectAttachment(msg);
    if (!text && !att) return; // protocol/system message — skip
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    const senderJid = jidNormalizedUser(msg.key.participant ?? remoteJid);
    const senderName = msg.key.fromMe
      ? "You"
      : msg.pushName?.trim() || senderJid.split("@")[0];
    recordMessage(remoteJid, {
      ts,
      fromMe: !!msg.key.fromMe,
      sender: senderJid,
      senderName,
      text: text || `[${att!.kind}: ${att!.filename}]`,
      ...(att ? { mediaType: att.kind } : {}),
    });
    // Contacts index: DM names come from the other side's pushName only.
    const isDm = !remoteJid.endsWith("@g.us");
    const name = isDm && !msg.key.fromMe ? msg.pushName?.trim() : undefined;
    touchContact(remoteJid, name, ts);
  } catch (e: any) {
    log.warn(`persistMessage failed: ${e?.message ?? e}`);
  }
}

/**
 * Anywhere-in-WhatsApp "@computer" trigger (opt-in, added on top of the
 * dedicated-group hard lock — not a replacement for it). Runs for every chat
 * that is NOT a monitored group:
 *   - Buffers the message into that chat's rolling history for context,
 *     regardless of sender (needed to "read the conversation").
 *   - Only ever ACTS when the trigger word appears in a message YOU sent
 *     (fromMe) — other participants can be read for context but can never
 *     invoke it themselves.
 *   - Replies directly into that same chat, using the same per-chat session
 *     state (and full Claude Code power in `config.workdir`) as the
 *     dedicated group.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleMention(msg: WAMessage, remoteJid: string): Promise<void> {
  if (!config.mentionEnabled) return;
  // Broadcast pseudo-chats (status@broadcast etc.) are not conversations:
  // never buffer them, and a trigger word in your own status must not run a
  // task — the reply would be PUBLISHED as a status for all contacts.
  if (remoteJid.endsWith("@broadcast")) return;

  const raw = extractText(msg)?.trim() ?? "";
  const attachment = detectAttachment(msg);
  const label = msg.key.fromMe
    ? "You"
    : msg.pushName?.trim() || jidNormalizedUser(msg.key.participant ?? remoteJid);
  const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  const entryText = raw || (attachment ? `[sent ${attachment.filename}]` : "");
  if (entryText) bufferHistory(remoteJid, { label, text: entryText, ts });

  if (!msg.key.fromMe) return; // only you can invoke it, per design
  // Word-boundary match only: "@computer" must not fire on a substring like
  // "support@computerstore.com" typed into a real conversation. Punctuation
  // only terminates the trigger when it ends the token — "@computer." fires,
  // "@computer.com" does not.
  const triggerRe = new RegExp(
    `(^|\\s)${escapeRegex(config.mentionTrigger)}(?=\\s|$|[:,.!?](?:\\s|$))`,
    "i",
  );
  const match = triggerRe.exec(raw);
  if (!match) return;
  const idx = match.index + match[1].length;

  const chat = getChat(remoteJid, config.workdir);
  if (chat.busy) {
    await safeSend(remoteJid, `⏳ Still working on the previous ${config.mentionTrigger} request here — hang on.`);
    return;
  }
  const provider = getProvider(chat.provider);
  if (!provider) return;
  if (!ensureCwdValid(chat, config.workdir)) {
    await safeSend(
      remoteJid,
      `⚠️ Working dir is missing (and the configured fallback too):\n${config.workdir}\nRestore it before sending tasks.`,
    );
    return;
  }

  const instruction = raw
    .slice(idx + config.mentionTrigger.length)
    .replace(/^[:,\s]+/, "")
    .trim();
  const transcript = formatHistory(remoteJid);

  // ── SYNCHRONOUS dispatch snapshot (no await between busy=true and here) ──
  // The task belongs to THIS generation of chat state; /new, /cd, /use while
  // it runs bump chat.generation and the completion writeback must not apply.
  chat.busy = true;
  const gen = chat.generation;
  const taskCwd = chat.cwd;
  const sessionAtDispatch = chat.sessionId;
  const outboxRoot = join(taskCwd, "outbox");
  // Per-task private outbox: concurrent tasks sharing a workdir must never
  // sweep each other's in-flight files.
  const taskOutbox = join(outboxRoot, `task-${randomUUID().slice(0, 8)}`);
  const warn = chat.pendingWarn;
  chat.pendingWarn = undefined;

  const task =
    `You were just mentioned ("${config.mentionTrigger}") in a live WhatsApp conversation. ` +
    `This is an ordinary chat, not the dedicated command group — reply like a helpful ` +
    `participant joining the conversation, not a task-runner. Keep it concise and natural; ` +
    `it is posted directly into this chat for everyone there to read.\n\n` +
    `--- recent conversation (most recent last) ---\n${transcript || "(no prior messages buffered)"}\n--- end conversation ---\n\n` +
    (instruction
      ? `The specific ask right after the mention: "${instruction}"`
      : `No specific words followed the mention — read the conversation above and offer whatever help is relevant.`) +
    `\n\n[To send a file back, save it into ${taskOutbox} — it will be delivered and removed automatically.]`;

  // Presence (and every later send) resolves the CURRENT socket via the
  // getter — long tasks outlive reconnects, so a captured sock goes stale.
  await currentSock?.sendPresenceUpdate("composing", remoteJid).catch(() => {});
  if (warn) await safeSend(remoteJid, warn);
  log.info(`[${remoteJid}] (${config.mentionTrigger}, ${provider.name}) triggered`);
  // Quarantine legacy loose files in the shared outbox root (per-task subdirs
  // are never touched). Skipped while another chat has a task running in this
  // same workdir: guard kept for the legacy loose-file case.
  if (!busyCwds.has(taskCwd)) isolateOrphans(outboxRoot);
  cwdTaskStarted(taskCwd);
  const rec = taskStarted({
    jid: remoteJid,
    chatName: getContactName(remoteJid),
    kind: "mention",
    preview: (instruction || raw).replace(/\s+/g, " ").slice(0, 200),
    provider: provider.name,
  });
  try {
    mkdirSync(taskOutbox, { recursive: true });
    const res = await provider.run(
      task,
      { cwd: taskCwd, resumeSessionId: sessionAtDispatch, model: config.model || undefined },
      config.taskTimeoutMs,
    );
    // Session writeback only if no control command changed state meanwhile.
    if (chat.generation === gen) {
      if (res.resetSession) chat.sessionId = undefined; // stale --resume id recovered
      if (res.sessionId) chat.sessionId = res.sessionId;
      persistChats();
    }
    taskFinished(rec, {
      status: res.timedOut ? "timeout" : res.isError ? "error" : "done",
      costUsd: res.costUsd,
    });
    if (res.timedOut) {
      // The agent was SIGKILLed mid-flight — anything in its outbox may be a
      // truncated partial write. Hold, never deliver.
      const held = orphanTaskOutbox(taskOutbox, outboxRoot);
      await safeSend(
        remoteJid,
        "⚠️ " + res.text + (held ? "\n📎 Files it was writing were held (not sent) — see outbox/.orphaned/." : ""),
      );
    } else {
      await safeSend(remoteJid, (res.isError ? "⚠️ " : "") + res.text);
      // SECURITY: outbox files NEVER flush to the arbitrary chat the mention
      // was typed in — files go to the user's own chat ("message yourself");
      // the triggering chat gets a neutral note only.
      const liveSock = currentSock;
      const selfJid = liveSock ? jidNormalizedUser(liveSock.user?.id ?? "") : "";
      let delivered: OutboxResult | null = null;
      if (liveSock && selfJid) {
        delivered = await flushOutbox(liveSock, selfJid, taskOutbox, rememberSent);
        removeTaskOutbox(taskOutbox);
      } else {
        orphanTaskOutbox(taskOutbox, outboxRoot); // can't deliver now — hold, don't leak
      }
      if (delivered) {
        if (selfJid === remoteJid) {
          await safeSend(remoteJid, delivered.summary);
        } else if (delivered.sentCount > 0) {
          // Claim delivery only when something WAS delivered; the full
          // summary (incl. any skips) goes to the self chat with the files.
          await safeSend(remoteJid, "📎 File(s) delivered to your personal chat.");
          await safeSend(selfJid, delivered.summary);
        } else {
          // Nothing was sent (all skipped: too large / send failed) — never
          // claim delivery; surface the skip reasons instead.
          await safeSend(remoteJid, `⚠️ Couldn't deliver file(s):\n${delivered.summary}`);
        }
      }
    }
  } catch (e: any) {
    log.error(`[${remoteJid}] ${config.mentionTrigger} error: ${e?.message ?? e}`);
    taskFinished(rec, { status: "error" });
    orphanTaskOutbox(taskOutbox, outboxRoot);
    await safeSend(remoteJid, `💥 Bridge error: ${e?.message ?? e}`);
  } finally {
    cwdTaskFinished(taskCwd);
    chat.busy = false;
    await currentSock?.sendPresenceUpdate("paused", remoteJid).catch(() => {});
  }
}

// ── Reconnect backoff + single-flight ───────────────────────────────────────
// The raw close->start() loop once produced 27k reconnects in a storm.
// Exponential backoff with jitter (1s doubling to a 60s cap, reset only after
// the connection has STAYED open — an open that immediately closes, e.g. a
// 440 conflict from another session, must keep escalating or the flap loops
// at ~1s forever), and a guard so only ONE restart chain is ever in flight.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const BACKOFF_RESET_AFTER_MS = 30_000; // how long 'open' must hold to count as healthy
let reconnectDelayMs = RECONNECT_BASE_MS;
let restartPending = false;
let backoffResetTimer: NodeJS.Timeout | undefined;

function scheduleRestart(): void {
  if (restartPending || runtime.loggedOut) return;
  restartPending = true;
  const delay = reconnectDelayMs + Math.floor(Math.random() * reconnectDelayMs * 0.3); // jitter
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  runtime.reconnects++;
  log.warn(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
  // NOTE: deliberately not unref'd — this timer may be the only thing keeping
  // the process alive between a close and the next connect attempt.
  setTimeout(() => {
    restartPending = false;
    start().catch((e) => {
      log.error(`Reconnect attempt failed: ${e?.message ?? e}`);
      scheduleRestart();
    });
  }, delay);
}

async function start() {
  const selected = getProvider(config.provider);
  if (!selected) {
    log.error(
      `Unknown PROVIDER "${config.provider}". Valid: ${providerNames().join(", ")}.`,
    );
    process.exit(1);
  }
  if (selected.available()) {
    log.info(`Provider: ${selected.name} (\`${selected.bin}\` found)`);
  } else {
    log.warn(
      `⚠ Provider "${selected.name}" selected but \`${selected.bin}\` is not on PATH. ` +
        `Tasks will fail until it's installed and authenticated.`,
    );
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });

  currentSock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) void showQr(qr);
    if (connection === "open") {
      isConnected = true;
      // Reset the backoff only once the connection has held for a while —
      // cleared on close, so an open->immediate-close flap keeps escalating.
      clearTimeout(backoffResetTimer);
      backoffResetTimer = setTimeout(() => {
        reconnectDelayMs = RECONNECT_BASE_MS;
      }, BACKOFF_RESET_AFTER_MS);
      backoffResetTimer.unref?.();
      runtime.lastConnectedAt = Date.now();
      // Deliver anything queued while we were down (or before a restart).
      void flushPending();
      const me = jidNormalizedUser(sock.user?.id ?? "");
      log.info(`✅ Bridge live. Connected as ${me}`);
      log.info(`Working dir: ${config.workdir}`);
      log.info(
        `Command channels: ${monitoredGroupConfigs.length} group(s) (hard-locked): ` +
          monitoredGroupConfigs.map((g) => `"${g.name}"`).join(", "),
      );
      if (config.commandPrefix) log.info(`Command prefix: "${config.commandPrefix}"`);
      log.info(
        config.mentionEnabled
          ? `Mention trigger: "${config.mentionTrigger}" works in ANY chat (fromMe only).`
          : `Mention trigger: disabled.`,
      );
      log.info("Ready. Control commands: /new  /cd <path>  /use <provider>  /status");
      // Re-run group setup until EVERY configured group is resolved — a
      // partial failure (one group throwing) must retry on the next open, or
      // that group stays unmonitored until restart. Re-runs are idempotent
      // (persisted-jid + subject match; already-resolved configs are skipped)
      // so they never re-create or re-greet.
      if (monitoredGroups.size < monitoredGroupConfigs.length) {
        // Kill any pre-disconnect retry timer: scheduleGroupsRetry early-returns
        // while one is pending, so a stale (up to 10-min) timer would make the
        // fresh 30s backoff below dead code.
        clearTimeout(groupsRetryTimer);
        groupsRetryTimer = undefined;
        groupsRetryMs = GROUPS_RETRY_BASE_MS; // fresh connection — fresh backoff
        void ensureGroups();
      }
      // Local control API — idempotent, starts once, reads live state via
      // getters so reconnects (new sock) are picked up automatically.
      startApi({
        getSock: () => currentSock,
        isConnected: () => isConnected,
        loggedOut: () => runtime.loggedOut,
        rememberSent,
      });
    }
    if (connection === "close") {
      isConnected = false;
      clearTimeout(backoffResetTimer); // this open didn't stabilize — keep the backoff
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        // 401: the phone unlinked this device. Reconnecting would loop
        // forever — stop retrying but stay alive so /health can report it.
        if (!runtime.loggedOut) {
          runtime.loggedOut = true;
          log.error(
            "Connection closed: LOGGED OUT (401). The WhatsApp session is dead — " +
              "delete the auth/ folder and re-run `npm start` to scan a fresh QR. Not retrying.",
          );
        }
        return;
      }
      log.warn(`Connection closed (code ${code}). Reconnecting with backoff...`);
      scheduleRestart();
    }
  });

  // One-time full history sync WhatsApp pushes to a NEWLY linked device only
  // (id/name pairs for every contact it hands over on first link, chunked via
  // `isLatest`). This is the real address-book backfill — richer than the
  // live contacts.upsert stream below, which only reflects ongoing activity.
  // NOTE: does not fire on a reconnect of an already-linked session — only
  // matters starting from the next full re-link (delete auth/, rescan QR).
  sock.ev.on("messaging-history.set", ({ contacts }) => {
    for (const c of contacts) {
      const jid = c.id;
      const name = c.name || c.notify;
      if (jid && name) touchContact(jid, name, 0);
    }
  });

  // Full saved-contacts sync (fires once with the whole address book shortly
  // after connecting, then incrementally as contacts change) — same idea as
  // ensureGroups() backfilling group subjects. lastSeen stays 0 so synced
  // contacts don't jump ahead of real conversations in /chats ordering; they
  // just become name-resolvable immediately instead of only after a message.
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const jid = c.id;
      const name = c.name || c.notify;
      if (jid && name) touchContact(jid, name, 0);
    }
  });
  sock.ev.on("contacts.update", (updates) => {
    for (const c of updates) {
      const jid = c.id;
      const name = c.name || c.notify;
      if (jid && name) touchContact(jid, name, 0);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Dispatch every message DETACHED: one long task (or a send waiting out
      // a disconnect) must never stall the rest of the batch — other chats,
      // control commands, even the same-chat busy nudge. Per-chat ordering is
      // enforced by chat.busy (the check->set sequences contain no await), and
      // a poisoned message can't skip the batch or kill the process either.
      void handleIncoming(msg).catch((e: any) => {
        log.error(
          `message handler crashed for ${msg.key.remoteJid ?? "?"}: ${e?.message ?? e}` +
            (e?.stack ? `\n${e.stack}` : ""),
        );
      });
    }
  });
}

/** Route one incoming message: monitored-group task or mention trigger. */
async function handleIncoming(msg: WAMessage): Promise<void> {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  // ── Never react to our own replies (prevents an echo loop) ──
  if (msg.key.id && sentIds.has(msg.key.id)) return;

  // ── Never handle the same incoming message twice ──
  // WhatsApp redelivers messages whose receipt ack didn't make it out before
  // a socket drop; without this a reconnect re-runs the task. Marked handled
  // immediately (not on completion) so a mid-task redelivery is also skipped.
  if (msg.key.id) {
    if (processedIds.has(msg.key.id)) return;
    rememberProcessed(msg.key.id);
  }

  // ── Persist every real message to the JSONL store (additive) ──
  // Placed after the sentIds check: bridge/API-sent messages are already
  // recorded at send time, so their echoes must not double-record.
  persistMessage(msg, remoteJid);

  // ── HARD LOCK (dedicated group) ─────────────────────────────
  // The bridge only runs full unprompted tasks inside the groups it
  // monitors. Everywhere else, the ONLY thing that can happen is the
  // opt-in "@computer" mention trigger (handleMention) — fromMe
  // only, never other participants, never an unprompted task. (Until
  // groups are resolved on connect, monitoredGroups is empty.)
  const groupCfg = monitoredGroups.get(remoteJid);
  if (!groupCfg) {
    await handleMention(msg, remoteJid);
    return;
  }
  const senderJid = jidNormalizedUser(msg.key.participant ?? remoteJid);
  const authorised = msg.key.fromMe || groupCfg.allowedJids.includes(senderJid);
  if (!authorised) return;

  const raw = extractText(msg)?.trim() ?? "";
  const attachment = detectAttachment(msg);
  if (!raw && !attachment) return;

  // ── Optional command prefix gate (text only; files are explicit) ───
  let body = raw;
  if (config.commandPrefix && !attachment) {
    const p = config.commandPrefix.toLowerCase();
    if (!body.toLowerCase().startsWith(p)) return;
    body = body.slice(config.commandPrefix.length).replace(/^[:\s]+/, "");
  }
  if (!body && !attachment) return;

  const reply = (text: string) => safeSend(remoteJid, text);

  const chat = getChat(remoteJid, groupCfg.workdir);

  // ── Control commands (never when a file is attached) ───────────────
  if (!attachment && body.startsWith("/")) {
    const [cmd, ...rest] = body.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    if (cmd === "new") {
      chat.sessionId = undefined;
      chat.generation++; // a running task's completion must not restore the old session
      persistChats();
      await reply("🆕 Started a fresh session.");
    } else if (cmd === "cd") {
      if (arg) {
        // Validate before accepting — a typo'd cwd makes every later spawn fail.
        let isDir = false;
        try {
          isDir = statSync(arg).isDirectory();
        } catch {
          /* missing */
        }
        if (!isDir) {
          await reply(`⚠️ Not a directory (or doesn't exist):\n${arg}\nWorking dir unchanged.`);
        } else {
          chat.cwd = arg;
          chat.sessionId = undefined;
          chat.generation++;
          persistChats();
          await reply(`📁 Working dir set to:\n${arg}\n(session reset)`);
        }
      } else {
        await reply(`📁 Current working dir:\n${chat.cwd}`);
      }
    } else if (cmd === "use") {
      const name = arg.toLowerCase();
      const next = getProvider(name);
      if (!next) {
        const list = providerNames()
          .map((n) => {
            const p = getProvider(n)!;
            return `• ${n}${p.available() ? "" : " (not installed)"} — ${p.blurb}`;
          })
          .join("\n");
        await reply(`Pick a provider: /use <name>\n\n${list}`);
      } else {
        chat.provider = name;
        chat.sessionId = undefined;
        chat.generation++;
        persistChats();
        await reply(
          `🔁 Switched to *${name}*${next.available() ? "" : " — ⚠ not installed on this machine"}.\n` +
            `(session reset)`,
        );
      }
    } else if (cmd === "status") {
      await reply(
        `📊 Status\nProvider: ${chat.provider}\nDir: ${chat.cwd}\n` +
          `Session: ${chat.sessionId ?? "none (fresh)"}\nBusy: ${chat.busy}`,
      );
    } else {
      await reply("Unknown command. Available: /new  /cd <path>  /use <provider>  /status");
    }
    return;
  }

  // ── Run the task ───────────────────────────────────────────
  if (chat.busy) {
    await reply("⏳ Still working on the previous task — send it again once I reply.");
    return;
  }
  const provider = getProvider(chat.provider);
  if (!provider) {
    await reply(`⚠️ Unknown provider "${chat.provider}". Use /use <name> to pick one.`);
    return;
  }
  if (!ensureCwdValid(chat, groupCfg.workdir)) {
    await reply(
      `⚠️ Working dir is missing (and the configured fallback too):\n${groupCfg.workdir}\nRestore it or /cd to an existing directory.`,
    );
    return;
  }

  // ── SYNCHRONOUS dispatch snapshot (no await between busy=true and here) ──
  // Everything the task uses is pinned NOW: a /cd or /new processed during
  // the awaits below (download, "On it...") must neither desynchronize the
  // inbox/outbox dirs from the run cwd nor have its effect undone by the
  // completion writeback.
  chat.busy = true;
  const gen = chat.generation;
  const taskCwd = chat.cwd;
  const sessionAtDispatch = chat.sessionId;
  const inboxDir = join(taskCwd, "inbox");
  const outboxRoot = join(taskCwd, "outbox");
  // Per-task private outbox: concurrent tasks sharing a workdir must never
  // sweep each other's in-flight files.
  const taskOutbox = join(outboxRoot, `task-${randomUUID().slice(0, 8)}`);
  const warn = chat.pendingWarn;
  chat.pendingWarn = undefined;

  // Presence resolves the CURRENT socket — a long task outlives reconnects.
  await currentSock?.sendPresenceUpdate("composing", remoteJid).catch(() => {});
  if (warn) await reply(warn);

  // ── Download any attached file into the working dir's inbox ────────
  let filePath: string | undefined;
  if (attachment) {
    try {
      const liveSock = currentSock;
      if (!liveSock) throw new Error("not connected");
      filePath = await saveIncoming(liveSock, msg, attachment, inboxDir);
    } catch (e: any) {
      log.error(`[${remoteJid}] download failed: ${e?.message ?? e}`);
      await reply(`⚠️ Couldn't download that file: ${e?.message ?? e}`);
      chat.busy = false;
      return;
    }
  }
  await reply("🤖 On it...");

  // ── Compose the task: caption + file note + outbox capability ──────
  let task = body;
  if (filePath) {
    const note = `[The user attached a file at: ${filePath}]`;
    task = body ? `${note}\n\n${body}` : `${note}\n\nThe user sent this file with no other text. Inspect it and respond helpfully.`;
  }
  task += `\n\n[To send a file back to the user on WhatsApp, save it into ${taskOutbox} — it will be delivered and removed automatically. Do not mention this folder unless relevant.]`;

  // Quarantine legacy loose files in the shared outbox root (per-task subdirs
  // are never touched). Skipped while another chat has a task running in this
  // same workdir — guard kept for the legacy loose-file case.
  if (!busyCwds.has(taskCwd)) isolateOrphans(outboxRoot);
  cwdTaskStarted(taskCwd);

  const startedAt = Date.now();
  log.info(
    `[${remoteJid}] (${provider.name}) task in ${taskCwd}${filePath ? " +file" : ""}: ` +
      `${(body || attachment?.filename || "").replace(/\s+/g, " ").slice(0, 200)}`,
  );
  const rec = taskStarted({
    jid: remoteJid,
    chatName: getContactName(remoteJid),
    kind: "group",
    preview: (body || attachment?.filename || "").replace(/\s+/g, " ").slice(0, 200),
    provider: provider.name,
  });

  try {
    mkdirSync(taskOutbox, { recursive: true });
    const res = await provider.run(
      task,
      { cwd: taskCwd, resumeSessionId: sessionAtDispatch, model: config.model || undefined },
      config.taskTimeoutMs,
    );
    // Session writeback only if no control command changed state meanwhile —
    // otherwise a /new (or /use's provider switch) issued mid-task would be
    // silently undone (or a claude session id stored under provider=codex).
    if (chat.generation === gen) {
      if (res.resetSession) chat.sessionId = undefined; // stale --resume id recovered
      if (res.sessionId) chat.sessionId = res.sessionId;
      persistChats();
    }
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.info(
      `[${remoteJid}] (${provider.name}) ${res.isError ? "error" : "done"} in ${secs}s` +
        (res.costUsd ? ` ($${res.costUsd.toFixed(4)})` : ""),
    );
    taskFinished(rec, {
      status: res.timedOut ? "timeout" : res.isError ? "error" : "done",
      costUsd: res.costUsd,
    });
    if (res.timedOut) {
      // The agent was SIGKILLed mid-flight — anything in its outbox may be a
      // truncated partial write. Hold, never deliver.
      const held = orphanTaskOutbox(taskOutbox, outboxRoot);
      await reply(
        "⚠️ " + res.text + (held ? "\n📎 Files it was writing were held (not sent) — see outbox/.orphaned/." : ""),
      );
    } else {
      await reply((res.isError ? "⚠️ " : "") + res.text);
      // ── Deliver any files the agent left in ITS outbox (current socket) ──
      const liveSock = currentSock;
      if (liveSock) {
        const delivered = await flushOutbox(liveSock, remoteJid, taskOutbox, rememberSent);
        removeTaskOutbox(taskOutbox);
        if (delivered) await reply(delivered.summary);
      } else {
        orphanTaskOutbox(taskOutbox, outboxRoot); // can't deliver now — hold, don't leak
      }
    }
  } catch (e: any) {
    log.error(`[${remoteJid}] bridge error: ${e?.message ?? e}`);
    taskFinished(rec, { status: "error" });
    orphanTaskOutbox(taskOutbox, outboxRoot);
    await reply(`💥 Bridge error: ${e?.message ?? e}`);
  } finally {
    cwdTaskFinished(taskCwd);
    chat.busy = false;
    await currentSock?.sendPresenceUpdate("paused", remoteJid).catch(() => {});
  }
}

// A short control-API token is guessable by any local process — warn loudly.
if (config.apiToken && config.apiToken.length < 16) {
  log.warn(
    `WA_API_TOKEN is only ${config.apiToken.length} chars — use at least 16 random chars for the control API.`,
  );
}

// Sidecar mode: the tray app sets WA_PARENT_PID. If it crashes or is killed
// without cleaning up, self-exit instead of living on as an orphan daemon
// (a relaunched tray would otherwise spawn a second daemon next to us).
// Not stdin-EOF based: under launchd stdin is /dev/null and would EOF at once.
const parentPid = Number(process.env.WA_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = existence check only
    } catch {
      log.warn(`Supervising app (pid ${parentPid}) is gone — exiting.`);
      process.exit(0);
    }
  }, 15_000).unref();
}

start().catch((e) => {
  log.error("Fatal:", e?.message ?? String(e));
  process.exit(1);
});
