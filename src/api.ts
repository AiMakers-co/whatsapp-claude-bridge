import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { extname, basename, isAbsolute } from "node:path";
import { generateMessageID, jidNormalizedUser, type WASocket } from "@whiskeysockets/baileys";
import { config } from "./config.js";
import { log, logFile } from "./logger.js";
import { runtime } from "./runtime.js";
import { html as dashboardHtml } from "./ui.js";
import { EXT_MIME, MAX_BYTES } from "./media.js";
import {
  listChats,
  readHistory,
  resolveByName,
  recordMessage,
  touchContact,
} from "./store.js";
import { rememberOutgoing } from "./retransmit.js";
import { getConfigPayload, saveConfig, readClaudeMd, writeClaudeMd } from "./settings.js";

/**
 * Local control API. Loopback-only (127.0.0.1) HTTP server so any local
 * Claude session can send WhatsApp messages/files and read stored history
 * through the bridge's existing connection.
 *
 * Security model:
 *   - binds to 127.0.0.1 ONLY — never reachable off this machine;
 *   - every request must carry header `x-wa-token` matching WA_API_TOKEN;
 *   - refuses to start at all if WA_API_TOKEN is unset.
 *
 * It deliberately does NOT touch flushOutbox, the mention trigger, or the
 * monitored-group hard locks — it only uses sock.sendMessage + the store.
 */

interface ApiDeps {
  getSock: () => WASocket | undefined;
  isConnected: () => boolean;
  /** True once WhatsApp logged the session out (auth/ must be re-linked). */
  loggedOut: () => boolean;
  rememberSent: (id?: string | null) => void;
}

let started = false;

export function startApi(deps: ApiDeps): void {
  if (started) return;
  started = true;

  if (!config.apiToken) {
    log.warn("Control API disabled: WA_API_TOKEN is not set in .env.");
    return;
  }

  const server = createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      log.warn(`Control API error: ${e?.message ?? e}`);
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
      else res.end();
    });
  });
  server.on("error", (e: any) => {
    // e.g. port already in use — log and carry on; the bridge itself must live.
    log.warn(`Control API server error (API unavailable): ${e?.message ?? e}`);
  });
  server.listen(config.apiPort, "127.0.0.1", () => {
    log.info(`Control API listening on http://127.0.0.1:${config.apiPort} (token auth)`);
    log.info(`Dashboard: http://127.0.0.1:${config.apiPort}`);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

interface ResolveOk {
  jid: string;
}
interface ResolveFail {
  status: number;
  error: string;
  candidates?: Array<{ jid: string; name: string }>;
}

/**
 * Turn a target (`jid`, bare phone number, or contact name) into a jid.
 * Never guesses: an ambiguous name comes back as candidates for the caller.
 */
function resolveTarget(input: string): ResolveOk | ResolveFail {
  const s = (input ?? "").trim();
  if (!s) return { status: 400, error: "empty target" };
  if (s.includes("@")) return { jid: s }; // already a jid
  const digits = s.replace(/[+\s().-]/g, "");
  if (/^[+\d][\d\s().-]*$/.test(s) && /^\d{7,15}$/.test(digits)) {
    return { jid: `${digits}@s.whatsapp.net` };
  }
  const r = resolveByName(s);
  if (!r) return { status: 404, error: `no known contact matching "${s}"` };
  if ("candidates" in r) {
    return { status: 409, error: `ambiguous name "${s}"`, candidates: r.candidates };
  }
  return { jid: r.jid };
}

function recordOutgoing(sock: WASocket, jid: string, text: string, mediaType?: string): void {
  const me = jidNormalizedUser(sock.user?.id ?? "");
  recordMessage(jid, {
    ts: Math.floor(Date.now() / 1000),
    fromMe: true,
    sender: me,
    senderName: "You",
    text,
    ...(mediaType ? { mediaType } : {}),
  });
  touchContact(jid);
}

/** Tail the bridge log: read only the last ~64KB, return the last `n` lines. */
function tailLog(n: number): string[] {
  try {
    const size = statSync(logFile).size;
    const span = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(span);
    const fd = openSync(logFile, "r");
    try {
      readSync(fd, buf, 0, span, size - span);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // The first line of a mid-file read is almost always truncated — drop it.
    if (span < size && lines.length > 1) lines.shift();
    return lines.slice(-n);
  } catch {
    return []; // log file missing/unreadable — never an error
  }
}

/**
 * Constant-time token check (this is the ONE auth gate for the whole API).
 * Both sides are hashed first so lengths always match and neither content nor
 * length leaks through comparison timing.
 */
function tokenOk(provided: string | string[] | undefined): boolean {
  if (typeof provided !== "string" || !config.apiToken) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(config.apiToken).digest();
  return timingSafeEqual(a, b);
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = `${req.method} ${url.pathname}`;

  // ── GET / — dashboard page (src/ui.ts) ─────────────────────────
  // Served WITHOUT the token: the server binds 127.0.0.1 only and the page
  // itself contains no data — every data endpoint it calls still requires
  // x-wa-token, which the page asks the user for on first load.
  if (route === "GET /") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(dashboardHtml),
    });
    res.end(dashboardHtml);
    return;
  }

  if (!tokenOk(req.headers["x-wa-token"])) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  // ── GET /health ────────────────────────────────────────────────
  if (route === "GET /health") {
    const sock = deps.getSock();
    const me = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
    json(res, 200, { ok: true, connected: deps.isConnected(), loggedOut: deps.loggedOut(), me });
    return;
  }

  // ── GET /status — dashboard snapshot (health + runtime counters) ─
  if (route === "GET /status") {
    const sock = deps.getSock();
    const me = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
    json(res, 200, {
      ok: true,
      connected: deps.isConnected(),
      loggedOut: deps.loggedOut(),
      me,
      uptimeSec: Math.floor((Date.now() - runtime.startedAt) / 1000),
      reconnects: runtime.reconnects,
      provider: config.provider,
      model: config.modelFor(config.provider) ?? "",
      workdir: config.workdir,
      pendingSends: runtime.pendingSendsCount(),
      // newest first; explicit field map keeps the wire shape stable
      tasks: [...runtime.tasks].reverse().map((t) => ({
        jid: t.jid,
        chatName: t.chatName,
        kind: t.kind,
        preview: t.preview,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        status: t.status,
        costUsd: t.costUsd,
        provider: t.provider,
      })),
    });
    return;
  }

  // ── GET /logs?n=200 — tail of logs/bridge.log ──────────────────
  if (route === "GET /logs") {
    const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 200, 1), 1000);
    json(res, 200, { lines: tailLog(n) });
    return;
  }

  // ── GET /chats ─────────────────────────────────────────────────
  if (route === "GET /chats") {
    json(res, 200, { chats: listChats() });
    return;
  }

  // ── GET /history?jid=..|q=..&limit=50 ──────────────────────────
  if (route === "GET /history") {
    let jid = url.searchParams.get("jid")?.trim() || "";
    const q = url.searchParams.get("q")?.trim() || "";
    if (!jid && q) {
      const r = resolveByName(q);
      if (!r) {
        json(res, 404, { error: `no known contact matching "${q}"` });
        return;
      }
      if ("candidates" in r) {
        json(res, 300, { status: 300, error: `ambiguous name "${q}"`, candidates: r.candidates });
        return;
      }
      jid = r.jid;
    }
    if (!jid) {
      json(res, 400, { error: "pass ?jid=<jid> or ?q=<name substring>" });
      return;
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
    const messages = await readHistory(jid, limit);
    json(res, 200, {
      jid,
      count: messages.length,
      messages: messages.map((m) => ({
        ts: m.ts,
        fromMe: m.fromMe,
        sender: m.senderName || m.sender,
        text: m.text,
        ...(m.mediaType ? { mediaType: m.mediaType } : {}),
      })),
    });
    return;
  }

  // ── GET /config — settings field defs + current values ─────────
  if (route === "GET /config") {
    json(res, 200, getConfigPayload());
    return;
  }

  // ── POST /config — validate + persist managed .env keys ────────
  if (route === "POST /config") {
    const body = await readBody(req);
    const values = body && typeof body.values === "object" ? body.values : body;
    const result = saveConfig(values || {});
    if (!result.ok) {
      json(res, 400, { ok: false, errors: result.errors });
      return;
    }
    log.info("[api] settings saved via dashboard (restart to apply)");
    json(res, 200, { ok: true, needsRestart: true });
    return;
  }

  // ── GET /claudemd?workdir=.. — read a workdir's CLAUDE.md ──────
  if (route === "GET /claudemd") {
    const workdir = url.searchParams.get("workdir")?.trim() || "";
    const r = readClaudeMd(workdir);
    json(res, r.ok ? 200 : 400, r);
    return;
  }

  // ── POST /claudemd { workdir, content } — write CLAUDE.md ───────
  if (route === "POST /claudemd") {
    const body = await readBody(req);
    const workdir = typeof body.workdir === "string" ? body.workdir : "";
    const content = typeof body.content === "string" ? body.content : "";
    const r = writeClaudeMd(workdir, content);
    if (r.ok) log.info(`[api] CLAUDE.md saved: ${r.path}`);
    json(res, r.ok ? 200 : 400, r);
    return;
  }

  // ── POST /restart — clean exit; the Tauri supervisor respawns ──
  // Reconnects from auth/ (no QR), picking up any saved settings. Under a
  // bare `npm start` (no supervisor) this just stops the process.
  if (route === "POST /restart") {
    log.info("[api] restart requested via dashboard");
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 150); // let the response flush first
    return;
  }

  // ── POST /send { jid?|to?, text } ──────────────────────────────
  if (route === "POST /send") {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      json(res, 400, { error: "text is required" });
      return;
    }
    const target = resolveTarget(body.jid ?? body.to ?? "");
    if (!("jid" in target)) {
      json(res, target.status, { error: target.error, candidates: target.candidates });
      return;
    }
    const sock = deps.getSock();
    if (!sock || !deps.isConnected()) {
      json(res, 503, { error: "bridge not connected to WhatsApp" });
      return;
    }
    // Pre-generate + remember the id BEFORE sending: if the send promise
    // rejects after WhatsApp actually accepted the frame, the echo must still
    // be filtered (and a caller retry with the same content stays harmless).
    const id = generateMessageID();
    deps.rememberSent(id); // echo-loop protection
    const apiSent = await sock.sendMessage(target.jid, { text }, { messageId: id });
    rememberOutgoing(apiSent ?? undefined); // backs getMessage for peer retry receipts
    recordOutgoing(sock, target.jid, text);
    log.info(`[api] sent text to ${target.jid} (${text.replace(/\s+/g, " ").slice(0, 120)})`);
    json(res, 200, { ok: true, jid: target.jid, id });
    return;
  }

  // ── POST /send-file { jid?|to?, path, caption? } ───────────────
  if (route === "POST /send-file") {
    const body = await readBody(req);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption : undefined;
    if (!path || !isAbsolute(path)) {
      json(res, 400, { error: "path is required and must be absolute" });
      return;
    }
    let size = 0;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error("not a regular file");
      size = st.size;
    } catch (e: any) {
      json(res, 400, { error: `cannot read file: ${e?.message ?? e}` });
      return;
    }
    if (size > MAX_BYTES) {
      json(res, 413, { error: `file too large (${(size / 1048576).toFixed(1)} MB, max 16 MB)` });
      return;
    }
    const target = resolveTarget(body.jid ?? body.to ?? "");
    if (!("jid" in target)) {
      json(res, target.status, { error: target.error, candidates: target.candidates });
      return;
    }
    const sock = deps.getSock();
    if (!sock || !deps.isConnected()) {
      json(res, 503, { error: "bridge not connected to WhatsApp" });
      return;
    }
    const name = basename(path);
    const ext = extname(name).toLowerCase();
    const mimetype = EXT_MIME[ext] ?? "application/octet-stream";
    // Pre-generate + remember the id BEFORE sending (see POST /send).
    const id = generateMessageID();
    deps.rememberSent(id); // echo-loop protection
    const fileSent = mimetype.startsWith("image/")
      ? await sock.sendMessage(target.jid, { image: { url: path }, mimetype, caption }, { messageId: id })
      : await sock.sendMessage(
          target.jid,
          {
            document: { url: path },
            fileName: name,
            mimetype,
            caption,
          },
          { messageId: id },
        );
    rememberOutgoing(fileSent ?? undefined); // backs getMessage for peer retry receipts
    recordOutgoing(
      sock,
      target.jid,
      caption ? `[sent ${name}] ${caption}` : `[sent ${name}]`,
      mimetype.startsWith("image/") ? "image" : "document",
    );
    log.info(`[api] sent file ${name} (${size} bytes) to ${target.jid}`);
    json(res, 200, { ok: true, jid: target.jid, id, file: name });
    return;
  }

  json(res, 404, { error: "unknown route" });
}
