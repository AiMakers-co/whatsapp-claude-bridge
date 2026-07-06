import {
  downloadMediaMessage,
  generateMessageID,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname, basename } from "node:path";
import type { Readable } from "node:stream";
import pino from "pino";
import { log } from "./logger.js";

const silent = pino({ level: "silent" });

/** WhatsApp rejects media over ~16 MB. */
export const MAX_BYTES = 16 * 1024 * 1024;

/** Hard deadline for one incoming media download (CDN streams can stall). */
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
  "text/plain": ".txt",
};

export const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

interface Attachment {
  kind: "image" | "video" | "audio" | "document";
  filename: string;
  mimetype: string;
}

/** Detect a downloadable attachment on a message, if any. */
export function detectAttachment(msg: WAMessage): Attachment | null {
  const m = msg.message;
  if (!m) return null;
  const pick = (
    kind: Attachment["kind"],
    mimetype: string | null | undefined,
    name?: string | null,
  ): Attachment => {
    const mt = mimetype || "application/octet-stream";
    const filename = name || `${kind}-${msg.key.id ?? "file"}${MIME_EXT[mt] ?? ""}`;
    return { kind, filename, mimetype: mt };
  };
  if (m.imageMessage) return pick("image", m.imageMessage.mimetype);
  if (m.videoMessage) return pick("video", m.videoMessage.mimetype);
  if (m.audioMessage) return pick("audio", m.audioMessage.mimetype);
  if (m.documentMessage)
    return pick("document", m.documentMessage.mimetype, m.documentMessage.fileName);
  if (m.documentWithCaptionMessage?.message?.documentMessage) {
    const d = m.documentWithCaptionMessage.message.documentMessage;
    return pick("document", d.mimetype, d.fileName);
  }
  return null;
}

/** Download an attachment into `<dir>/inbox`, returning the saved absolute path. */
export async function saveIncoming(
  sock: WASocket,
  msg: WAMessage,
  att: Attachment,
  inboxDir: string,
): Promise<string> {
  mkdirSync(inboxDir, { recursive: true });
  // Stream the download so the size cap is enforced WHILE downloading — a
  // lying/oversized payload gets aborted instead of buffered whole into RAM.
  // One hard deadline covers the whole download: a mid-stream stall (flap
  // during transfer) would otherwise pend forever and wedge the calling
  // chat's busy flag until restart.
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  // Keep the download promise so the race LOSER can be cleaned up: if the
  // timeout wins, a stream that resolves late must be destroyed (otherwise the
  // CDN fetch + decrypt transform stay allocated in a weeks-long process).
  const downloadP = downloadMediaMessage(
    msg,
    "stream",
    {},
    { logger: silent, reuploadRequest: sock.updateMediaMessage },
  ) as Promise<Readable>;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let stream: Readable | undefined;
  try {
    stream = await Promise.race([
      downloadP,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error("media download timed out")), DOWNLOAD_TIMEOUT_MS);
        deadlineTimer.unref?.();
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (!stream) downloadP.then((s) => s.destroy()).catch(() => {}); // timeout won — tear down the late stream
  }
  const killer = setTimeout(
    () => stream!.destroy(new Error("media download timed out")),
    Math.max(0, deadline - Date.now()),
  );
  killer.unref?.();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const c of stream) {
      const buf = c as Buffer;
      total += buf.length;
      if (total > MAX_BYTES) {
        stream.destroy();
        throw new Error(`file exceeds the ${(MAX_BYTES / 1048576).toFixed(0)} MB limit — download aborted`);
      }
      chunks.push(buf);
    }
  } finally {
    clearTimeout(killer);
  }
  const buffer = Buffer.concat(chunks);
  // Avoid clobbering existing files with the same name.
  let target = join(inboxDir, sanitize(att.filename));
  let n = 1;
  while (safeExists(target)) {
    const ext = extname(att.filename);
    target = join(inboxDir, `${sanitize(basename(att.filename, ext))}-${n}${ext}`);
    n++;
  }
  try {
    writeFileSync(target, buffer);
  } catch (e) {
    // Never leave a partial file behind for the task to read.
    try {
      unlinkSync(target);
    } catch {
      /* nothing written */
    }
    throw e;
  }
  log.info(`Saved incoming ${att.kind} (${buffer.length} bytes) -> ${target}`);
  return target;
}

/**
 * Send every file in `<dir>/outbox` to the chat, then delete it. Returns a
 * short human summary plus how many files were actually SENT (skipped-only
 * flushes have sentCount 0 — callers must not report those as delivered), or
 * null if the folder was empty / absent.
 */
const warnedDirs = new Set<string>();

export interface OutboxResult {
  sentCount: number;
  summary: string;
}

export async function flushOutbox(
  sock: WASocket,
  jid: string,
  outboxDir: string,
  markSent: (id?: string | null) => void = () => {},
): Promise<OutboxResult | null> {
  let names: string[];
  try {
    names = readdirSync(outboxDir).filter((f) => !f.startsWith("."));
  } catch {
    return null; // no outbox dir
  }
  if (names.length === 0) return null;

  const sent: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const path = join(outboxDir, name);
    let size = 0;
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        // Directories can't be sent — warn once per path, don't spam every flush.
        if (st.isDirectory() && !warnedDirs.has(path)) {
          warnedDirs.add(path);
          log.warn(`Outbox contains a directory (${path}) — directories are skipped, not delivered.`);
        }
        continue;
      }
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) {
      skipped.push(`${name} (too large, ${(size / 1048576).toFixed(1)} MB)`);
      continue;
    }
    const ext = extname(name).toLowerCase();
    const mimetype = EXT_MIME[ext] ?? "application/octet-stream";
    try {
      // Pre-generate + remember the id BEFORE sending: a delivered-but-
      // rejected send must not slip its echo past the sentIds filter.
      const id = generateMessageID();
      markSent(id);
      mimetype.startsWith("image/")
        ? await sock.sendMessage(jid, { image: { url: path }, mimetype }, { messageId: id })
        : await sock.sendMessage(jid, { document: { url: path }, fileName: name, mimetype }, { messageId: id });
      sent.push(name);
      try {
        unlinkSync(path);
      } catch {
        // Delivered but not deletable (permissions, etc.) — quarantine it in
        // .sent/ so it can never be re-delivered on the next flush.
        try {
          const sentDir = join(outboxDir, ".sent");
          mkdirSync(sentDir, { recursive: true });
          renameSync(path, join(sentDir, `${Date.now()}-${name}`));
        } catch (e2: any) {
          log.warn(`Sent ${name} but could not remove or quarantine it: ${e2?.message ?? e2}`);
        }
      }
    } catch (e: any) {
      skipped.push(`${name} (send failed: ${e?.message ?? e})`);
    }
  }

  const parts: string[] = [];
  if (sent.length) parts.push(`📎 Sent ${sent.length} file(s): ${sent.join(", ")}`);
  if (skipped.length) parts.push(`⚠️ Skipped: ${skipped.join("; ")}`);
  if (sent.length) log.info(`Flushed outbox: sent ${sent.join(", ")}`);
  return parts.length ? { sentCount: sent.length, summary: parts.join("\n") } : null;
}

/**
 * Called at TASK START on the SHARED outbox root: legacy loose files sitting
 * directly in outbox/ (from before per-task subdirs, or dropped there by
 * hand) are moved into .orphaned/ instead of being silently attributed — and
 * delivered — to the new task. It must NEVER touch directories: other tasks'
 * per-task subdirs are in-flight, and .orphaned/.sent are dot-prefixed anyway.
 */
export function isolateOrphans(outboxDir: string): void {
  let names: string[];
  try {
    names = readdirSync(outboxDir).filter((f) => !f.startsWith("."));
  } catch {
    return; // no outbox dir — nothing stale
  }
  // Regular files only — a directory here is another task's live outbox.
  names = names.filter((name) => {
    try {
      return statSync(join(outboxDir, name)).isFile();
    } catch {
      return false;
    }
  });
  if (names.length === 0) return;
  const orphanDir = join(outboxDir, ".orphaned");
  let moved = 0;
  try {
    mkdirSync(orphanDir, { recursive: true });
    for (const name of names) {
      try {
        renameSync(join(outboxDir, name), join(orphanDir, `${Date.now()}-${name}`));
        moved++;
      } catch {
        /* leave it; flushOutbox may still handle it */
      }
    }
  } catch (e: any) {
    log.warn(`Could not isolate stale outbox files in ${outboxDir}: ${e?.message ?? e}`);
  }
  if (moved) log.warn(`Outbox ${outboxDir} had ${moved} stale file(s) — moved to .orphaned/ before task start.`);
}

/**
 * Move a timed-out (or crashed) task's private outbox subdir into
 * .orphaned/ under the shared outbox root — a SIGKILLed agent's files may be
 * mid-write (truncated/corrupt) and must never be delivered as if complete.
 * Returns true when files were actually held.
 */
export function orphanTaskOutbox(taskOutboxDir: string, outboxRoot: string): boolean {
  let names: string[];
  try {
    names = readdirSync(taskOutboxDir).filter((f) => !f.startsWith("."));
  } catch {
    return false; // subdir never materialised
  }
  if (names.length === 0) {
    try {
      rmSync(taskOutboxDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
  try {
    const orphanDir = join(outboxRoot, ".orphaned");
    mkdirSync(orphanDir, { recursive: true });
    const dest = join(orphanDir, `${Date.now()}-${basename(taskOutboxDir)}`);
    renameSync(taskOutboxDir, dest);
    log.warn(`Held ${names.length} outbox file(s) from an aborted task -> ${dest}`);
    return true;
  } catch (e: any) {
    log.warn(`Could not orphan task outbox ${taskOutboxDir}: ${e?.message ?? e}`);
    return false;
  }
}

/** Remove a flushed per-task outbox subdir (keeps it if undeliverable files remain). */
export function removeTaskOutbox(taskOutboxDir: string): void {
  try {
    // .sent/ holds already-DELIVERED files that couldn't be unlinked — safe to drop.
    rmSync(join(taskOutboxDir, ".sent"), { recursive: true, force: true });
  } catch {
    /* none */
  }
  try {
    rmdirSync(taskOutboxDir); // non-recursive: skipped/failed files stay inspectable
  } catch {
    /* leftover files (send failures) — keep the dir for inspection */
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 200) || "file";
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
