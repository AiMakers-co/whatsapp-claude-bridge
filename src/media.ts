import {
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname, basename } from "node:path";
import pino from "pino";
import { log } from "./logger.js";

const silent = pino({ level: "silent" });

/** WhatsApp rejects media over ~16 MB. */
const MAX_BYTES = 16 * 1024 * 1024;

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

const EXT_MIME: Record<string, string> = {
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
  const buffer = (await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger: silent, reuploadRequest: sock.updateMediaMessage },
  )) as Buffer;
  // Avoid clobbering existing files with the same name.
  let target = join(inboxDir, sanitize(att.filename));
  let n = 1;
  while (safeExists(target)) {
    const ext = extname(att.filename);
    target = join(inboxDir, `${sanitize(basename(att.filename, ext))}-${n}${ext}`);
    n++;
  }
  writeFileSync(target, buffer);
  log.info(`Saved incoming ${att.kind} (${buffer.length} bytes) -> ${target}`);
  return target;
}

/**
 * Send every file in `<dir>/outbox` to the chat, then delete it. Returns a
 * short human summary (or null if the folder was empty / absent).
 */
export async function flushOutbox(
  sock: WASocket,
  jid: string,
  outboxDir: string,
  markSent: (id?: string | null) => void = () => {},
): Promise<string | null> {
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
      if (!st.isFile()) continue;
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
      const m = mimetype.startsWith("image/")
        ? await sock.sendMessage(jid, { image: { url: path }, mimetype })
        : await sock.sendMessage(jid, { document: { url: path }, fileName: name, mimetype });
      markSent(m?.key?.id);
      sent.push(name);
      unlinkSync(path);
    } catch (e: any) {
      skipped.push(`${name} (send failed: ${e?.message ?? e})`);
    }
  }

  const parts: string[] = [];
  if (sent.length) parts.push(`📎 Sent ${sent.length} file(s): ${sent.join(", ")}`);
  if (skipped.length) parts.push(`⚠️ Skipped: ${skipped.join("; ")}`);
  if (sent.length) log.info(`Flushed outbox: sent ${sent.join(", ")}`);
  return parts.length ? parts.join("\n") : null;
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
