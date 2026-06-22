import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { config } from "./config.js";
import { getProvider, providerNames } from "./providers.js";
import { detectAttachment, saveIncoming, flushOutbox } from "./media.js";
import { log } from "./logger.js";
import { showQr } from "./qr.js";
import { join } from "node:path";

/** Per-chat conversation state: provider, session to resume, working dir. */
interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
  provider: string;
}
const chats = new Map<string, ChatState>();

/**
 * IDs of messages WE sent. In note-to-self (and some group setups) our own
 * outgoing replies echo back through messages.upsert as fromMe messages — if
 * we don't filter them out, the bridge answers its own replies in an infinite
 * loop. Tracking sent ids and skipping them is the reliable fix.
 */
const sentIds = new Set<string>();
function rememberSent(id?: string | null): void {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 2000) sentIds.delete(sentIds.values().next().value as string);
}

/** JID of the dedicated "Claude Chat" group, once found or created. */
let claudeGroupJid: string | undefined;

/**
 * Find an existing group with the configured name, or create a fresh one. This
 * group is the ONLY channel the bridge listens on (hard lock). If it can't be
 * found or created, the bridge stays idle rather than leaking into other chats.
 */
async function ensureGroup(sock: ReturnType<typeof makeWASocket>): Promise<void> {
  if (!config.createGroup) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    const existing = Object.values(groups).find((g) => g.subject === config.groupName);
    if (existing) {
      claudeGroupJid = existing.id;
      log.info(`Using existing "${config.groupName}" group (${existing.id})`);
    } else {
      const res = await sock.groupCreate(config.groupName, []);
      claudeGroupJid = res.id;
      log.info(`Created "${config.groupName}" group (${res.id})`);
    }
    const welcome = await sock.sendMessage(claudeGroupJid, {
      text:
        `👋 *Claude Chat* is live.\n\n` +
        `Send me any task and I'll run it with Claude Code in:\n${config.workdir}\n\n` +
        `Control: /new  ·  /cd <path>  ·  /use <provider>  ·  /status`,
    });
    rememberSent(welcome?.key?.id);
  } catch (e: any) {
    log.warn(
      `Could not set up "${config.groupName}" group: ${e?.message ?? e}. ` +
        `Bridge will stay idle (it only listens in that group) until it's available.`,
    );
  }
}

function getChat(jid: string): ChatState {
  let c = chats.get(jid);
  if (!c) {
    c = { cwd: config.workdir, busy: false, provider: config.provider };
    chats.set(jid, c);
  }
  return c;
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

/** WhatsApp tolerates long text, but split to keep replies readable. */
function chunk(text: string, size = 4000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) void showQr(qr);
    if (connection === "open") {
      const me = jidNormalizedUser(sock.user?.id ?? "");
      log.info(`✅ Bridge live. Connected as ${me}`);
      log.info(`Working dir: ${config.workdir}`);
      log.info(`Command channel: ONLY the "${config.groupName}" group (hard-locked).`);
      if (config.commandPrefix) log.info(`Command prefix: "${config.commandPrefix}"`);
      log.info("Ready. Control commands: /new  /cd <path>  /use <provider>  /status");
      void ensureGroup(sock);
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      log.warn(`Connection closed (code ${code}). ${loggedOut ? "Logged out — delete auth/ and re-link." : "Reconnecting..."}`);
      if (!loggedOut) start().catch((e) => log.error(e));
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // ── Never react to our own replies (prevents an echo loop) ──
      if (msg.key.id && sentIds.has(msg.key.id)) continue;

      // ── HARD LOCK ───────────────────────────────────────────────
      // The bridge ONLY ever acts inside the dedicated group it created, and
      // ONLY on messages you sent. It will NEVER touch note-to-self, your own
      // number, DMs, or any other chat — no exceptions, no allowlist override.
      // (Until the group is identified on connect, claudeGroupJid is undefined
      // and nothing is processed — the safe default.)
      const isClaudeGroup = claudeGroupJid !== undefined && remoteJid === claudeGroupJid;
      if (!isClaudeGroup) continue;
      if (!msg.key.fromMe) continue;

      const raw = extractText(msg)?.trim() ?? "";
      const attachment = detectAttachment(msg);
      if (!raw && !attachment) continue;

      // ── Optional command prefix gate (text only; files are explicit) ───
      let body = raw;
      if (config.commandPrefix && !attachment) {
        const p = config.commandPrefix.toLowerCase();
        if (!body.toLowerCase().startsWith(p)) continue;
        body = body.slice(config.commandPrefix.length).replace(/^[:\s]+/, "");
      }
      if (!body && !attachment) continue;

      const reply = (text: string) =>
        (async () => {
          for (const part of chunk(text)) {
            const m = await sock.sendMessage(remoteJid, { text: part });
            rememberSent(m?.key?.id);
          }
        })();

      const chat = getChat(remoteJid);

      // ── Control commands (never when a file is attached) ───────────────
      if (!attachment && body.startsWith("/")) {
        const [cmd, ...rest] = body.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        if (cmd === "new") {
          chat.sessionId = undefined;
          await reply("🆕 Started a fresh session.");
        } else if (cmd === "cd") {
          if (arg) {
            chat.cwd = arg;
            chat.sessionId = undefined;
            await reply(`📁 Working dir set to:\n${arg}\n(session reset)`);
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
        continue;
      }

      // ── Run the task ───────────────────────────────────────────
      if (chat.busy) {
        await reply("⏳ Still working on the previous task — send it again once I reply.");
        continue;
      }
      const provider = getProvider(chat.provider);
      if (!provider) {
        await reply(`⚠️ Unknown provider "${chat.provider}". Use /use <name> to pick one.`);
        continue;
      }
      chat.busy = true;
      await sock.sendPresenceUpdate("composing", remoteJid).catch(() => {});
      const inboxDir = join(chat.cwd, "inbox");
      const outboxDir = join(chat.cwd, "outbox");

      // ── Download any attached file into the working dir's inbox ────────
      let filePath: string | undefined;
      if (attachment) {
        try {
          filePath = await saveIncoming(sock, msg, attachment, inboxDir);
        } catch (e: any) {
          log.error(`[${remoteJid}] download failed: ${e?.message ?? e}`);
          await reply(`⚠️ Couldn't download that file: ${e?.message ?? e}`);
          chat.busy = false;
          continue;
        }
      }
      await reply("🤖 On it...");

      // ── Compose the task: caption + file note + outbox capability ──────
      let task = body;
      if (filePath) {
        const note = `[The user attached a file at: ${filePath}]`;
        task = body ? `${note}\n\n${body}` : `${note}\n\nThe user sent this file with no other text. Inspect it and respond helpfully.`;
      }
      task += `\n\n[To send a file back to the user on WhatsApp, save it into ${outboxDir} — it will be delivered and removed automatically. Do not mention this folder unless relevant.]`;

      const startedAt = Date.now();
      log.info(
        `[${remoteJid}] (${provider.name}) task in ${chat.cwd}${filePath ? " +file" : ""}: ` +
          `${(body || attachment?.filename || "").replace(/\s+/g, " ").slice(0, 200)}`,
      );

      try {
        const res = await provider.run(
          task,
          { cwd: chat.cwd, resumeSessionId: chat.sessionId, model: config.model || undefined },
          config.taskTimeoutMs,
        );
        if (res.sessionId) chat.sessionId = res.sessionId;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.info(
          `[${remoteJid}] (${provider.name}) ${res.isError ? "error" : "done"} in ${secs}s` +
            (res.costUsd ? ` ($${res.costUsd.toFixed(4)})` : ""),
        );
        const prefix = res.isError ? "⚠️ " : "";
        await reply(prefix + res.text);
        // ── Deliver any files the agent left in outbox ───────────────────
        const delivered = await flushOutbox(sock, remoteJid, outboxDir, rememberSent);
        if (delivered) await reply(delivered);
      } catch (e: any) {
        log.error(`[${remoteJid}] bridge error: ${e?.message ?? e}`);
        await reply(`💥 Bridge error: ${e?.message ?? e}`);
      } finally {
        chat.busy = false;
        await sock.sendPresenceUpdate("paused", remoteJid).catch(() => {});
      }
    }
  });
}

start().catch((e) => {
  log.error("Fatal:", e?.message ?? String(e));
  process.exit(1);
});
