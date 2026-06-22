import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { config } from "./config.js";
import { runClaude, checkClaudeCli } from "./claude.js";
import { log } from "./logger.js";
import { showQr } from "./qr.js";

/** Per-chat conversation state: the Claude session to resume + working dir. */
interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
}
const chats = new Map<string, ChatState>();

/** JID of the dedicated "Claude Chat" group, once found or created. */
let claudeGroupJid: string | undefined;

/**
 * Find an existing group with the configured name, or create a fresh one so
 * the user gets a clean, dedicated chat thread for talking to Claude (instead
 * of cluttering their note-to-self). Falls back silently to note-to-self if
 * group creation isn't possible.
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
    await sock.sendMessage(claudeGroupJid, {
      text:
        `👋 *Claude Chat* is live.\n\n` +
        `Send me any task and I'll run it with Claude Code in:\n${config.workdir}\n\n` +
        `Control: /new  ·  /cd <path>  ·  /status`,
    });
  } catch (e: any) {
    log.warn(
      `Could not set up "${config.groupName}" group: ${e?.message ?? e}. ` +
        `Falling back to note-to-self.`,
    );
  }
}

function getChat(jid: string): ChatState {
  let c = chats.get(jid);
  if (!c) {
    c = { cwd: config.workdir, busy: false };
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
  const claudeVersion = checkClaudeCli();
  if (claudeVersion) {
    log.info(`Claude CLI detected: ${claudeVersion}`);
  } else {
    log.warn(
      "⚠ `claude` CLI not found on PATH. Tasks will fail until Claude Code is " +
        "installed and logged in (run `claude` once to authenticate).",
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
      log.info(
        config.allowedJids.length
          ? `Allowed senders: ${config.allowedJids.join(", ")}`
          : `Command channel: note-to-self (message YOURSELF in WhatsApp)`,
      );
      if (config.commandPrefix) log.info(`Command prefix: "${config.commandPrefix}"`);
      log.info("Ready. Control commands: /new  /cd <path>  /status");
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
    const me = jidNormalizedUser(sock.user?.id ?? "");

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // ── Authorization ──────────────────────────────────────────
      // Default (no allowlist): only messages YOU send (fromMe) in either the
      // dedicated "Claude Chat" group or your note-to-self chat. With an
      // explicit allowlist: any message from those jids.
      const fromMe = Boolean(msg.key.fromMe);
      const isClaudeGroup = claudeGroupJid !== undefined && remoteJid === claudeGroupJid;
      const isSelfChat = fromMe && jidNormalizedUser(remoteJid) === me;
      const isAllowed = config.allowedJids.length
        ? config.allowedJids.includes(jidNormalizedUser(remoteJid))
        : fromMe && (isClaudeGroup || isSelfChat);
      if (!isAllowed) continue;

      const raw = extractText(msg)?.trim();
      if (!raw) continue;

      // ── Optional command prefix gate ───────────────────────────
      let body = raw;
      if (config.commandPrefix) {
        const p = config.commandPrefix.toLowerCase();
        if (!body.toLowerCase().startsWith(p)) continue;
        body = body.slice(config.commandPrefix.length).replace(/^[:\s]+/, "");
      }
      if (!body) continue;

      const reply = (text: string) =>
        (async () => {
          for (const part of chunk(text)) {
            await sock.sendMessage(remoteJid, { text: part });
          }
        })();

      const chat = getChat(remoteJid);

      // ── Control commands ───────────────────────────────────────
      if (body.startsWith("/")) {
        const [cmd, ...rest] = body.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        if (cmd === "new") {
          chat.sessionId = undefined;
          await reply("🆕 Started a fresh Claude session.");
        } else if (cmd === "cd") {
          if (arg) {
            chat.cwd = arg;
            chat.sessionId = undefined;
            await reply(`📁 Working dir set to:\n${arg}\n(session reset)`);
          } else {
            await reply(`📁 Current working dir:\n${chat.cwd}`);
          }
        } else if (cmd === "status") {
          await reply(
            `📊 Status\nDir: ${chat.cwd}\nSession: ${chat.sessionId ?? "none (fresh)"}\nBusy: ${chat.busy}`,
          );
        } else {
          await reply("Unknown command. Available: /new  /cd <path>  /status");
        }
        continue;
      }

      // ── Run the task ───────────────────────────────────────────
      if (chat.busy) {
        await reply("⏳ Still working on the previous task — send it again once I reply.");
        continue;
      }
      chat.busy = true;
      await sock.sendPresenceUpdate("composing", remoteJid).catch(() => {});
      await reply("🤖 On it...");
      const startedAt = Date.now();
      log.info(`[${remoteJid}] task in ${chat.cwd}: ${body.replace(/\s+/g, " ").slice(0, 200)}`);

      try {
        const res = await runClaude(body, {
          cwd: chat.cwd,
          resumeSessionId: chat.sessionId,
        });
        if (res.sessionId) chat.sessionId = res.sessionId;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.info(
          `[${remoteJid}] ${res.isError ? "error" : "done"} in ${secs}s` +
            (res.costUsd ? ` ($${res.costUsd.toFixed(4)})` : ""),
        );
        const prefix = res.isError ? "⚠️ " : "";
        await reply(prefix + res.text);
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
