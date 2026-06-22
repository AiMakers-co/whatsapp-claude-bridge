import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { config } from "./config.js";
import { runClaude } from "./claude.js";

const log = pino({ level: "info", transport: undefined });

/** Per-chat conversation state: the Claude session to resume + working dir. */
interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
}
const chats = new Map<string, ChatState>();

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
    if (qr) {
      console.log("\nScan this QR with WhatsApp (Settings → Linked Devices → Link a Device):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      const me = jidNormalizedUser(sock.user?.id ?? "");
      log.info(`Connected as ${me}`);
      console.log(
        `\n✅ Bridge live. Working dir: ${config.workdir}\n` +
          (config.allowedJids.length
            ? `   Allowed senders: ${config.allowedJids.join(", ")}\n`
            : `   Command channel: note-to-self (message YOURSELF in WhatsApp)\n`) +
          (config.commandPrefix
            ? `   Command prefix: "${config.commandPrefix}"\n`
            : "") +
          `\nSend a message to start. Control commands: /new  /cd <path>  /status\n`,
      );
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
      // Default (no allowlist): only note-to-self messages (fromMe AND the
      // chat is your own jid). With an allowlist: messages from those jids.
      const isSelfChat = Boolean(msg.key.fromMe) && jidNormalizedUser(remoteJid) === me;
      const isAllowed = config.allowedJids.length
        ? config.allowedJids.includes(jidNormalizedUser(remoteJid))
        : isSelfChat;
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

      try {
        const res = await runClaude(body, {
          cwd: chat.cwd,
          resumeSessionId: chat.sessionId,
        });
        if (res.sessionId) chat.sessionId = res.sessionId;
        const prefix = res.isError ? "⚠️ " : "";
        await reply(prefix + res.text);
      } catch (e: any) {
        await reply(`💥 Bridge error: ${e?.message ?? e}`);
      } finally {
        chat.busy = false;
        await sock.sendPresenceUpdate("paused", remoteJid).catch(() => {});
      }
    }
  });
}

start().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
