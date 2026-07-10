import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { agentReplyLabel, botReplyPrefixes } from "./replies.js";
import {
  parseMentionRouteEntry,
  type MentionRoute,
} from "./mentions.js";

const here = dirname(fileURLToPath(import.meta.url));
// WA_BRIDGE_HOME: explicit home-dir override for compiled/sidecar builds
// (e.g. bun build --compile), where import.meta.url no longer points at a
// real checkout. When set, auth/, data/ and logs/ resolve under it.
const bridgeHome = process.env.WA_BRIDGE_HOME?.trim();
const repoRoot = bridgeHome ? resolve(bridgeHome) : resolve(here, "..");

/** A WhatsApp group the bridge monitors, with its own project + permissions. */
export interface GroupConfig {
  /** Group subject (name) — used to find-or-create the group. */
  name: string;
  /** Working dir Claude Code runs in for tasks from this group. */
  workdir: string;
  /**
   * JIDs (besides yourself) allowed to issue tasks in THIS group. Your own
   * messages (fromMe) are always allowed. Empty = owner-only.
   * Format: 12025550123@s.whatsapp.net
   */
  allowedJids: string[];
  /** Phone JIDs to add as participants when the group is first created. */
  participants: string[];
}

function parseJids(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The agent CLIs the bridge knows how to drive (mirrors providers.ts SPECS). */
const KNOWN_PROVIDERS = new Set(["claude", "codex", "gemini", "grok"]);

/**
 * Per-trigger provider routing. MENTION_TRIGGERS is a comma-separated list of
 * `trigger:provider[:model]` routes (e.g.
 * `@computer:claude:sonnet,@codex:codex:gpt-5.6`), so each call sign can drive
 * a different agent CLI/model in ANY chat. The two-field `trigger:provider`
 * form remains valid. Invalid entries are warned about and skipped so one typo
 * never disables the whole trigger. When unset, a single legacy entry is
 * derived from MENTION_TRIGGER mapped to the default provider — unchanged
 * behaviour. (console.warn, not the logger: logger.ts imports config.)
 */
function parseMentionTriggers(
  raw: string | undefined,
  fallbackTrigger: string,
  defaultProvider: string,
): MentionRoute[] {
  const out: MentionRoute[] = [];
  if (raw && raw.trim()) {
    for (const pair of raw.split(",")) {
      const p = pair.trim();
      if (!p) continue;
      const parsed = parseMentionRouteEntry(p, KNOWN_PROVIDERS);
      if (!("route" in parsed)) {
        if (parsed.error === "missing-provider") {
          console.warn(`MENTION_TRIGGERS entry "${p}" has no provider — skipped.`);
        } else if (parsed.error === "empty-trigger") {
          console.warn(`MENTION_TRIGGERS entry "${p}" has an empty trigger — skipped.`);
        } else {
          console.warn(
            `MENTION_TRIGGERS: unknown provider "${parsed.provider ?? ""}" in "${p}" — skipped.`,
          );
        }
        continue;
      }
      out.push(parsed.route);
    }
  }
  if (out.length === 0) out.push({ trigger: fallbackTrigger, provider: defaultProvider });
  return out;
}

/**
 * Extra monitored groups beyond the primary one, as a JSON array in EXTRA_GROUPS.
 * Each entry: { name, workdir, allowedJids?, participants? }. Malformed entries are
 * dropped so a typo never takes the whole bridge down.
 */
function parseExtraGroups(raw?: string): GroupConfig[] {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((g) => g && typeof g.name === "string" && typeof g.workdir === "string")
      .map((g) => ({
        name: String(g.name).trim(),
        workdir: String(g.workdir).trim(),
        allowedJids: Array.isArray(g.allowedJids) ? g.allowedJids.map(String) : [],
        participants: Array.isArray(g.participants) ? g.participants.map(String) : [],
      }));
  } catch {
    return [];
  }
}

// Clamp numeric env values to sane ranges (console.warn: logger.ts imports
// config, so config can't import the logger back).
const rawTimeoutMs = (Number(process.env.TASK_TIMEOUT_SECONDS) || 600) * 1000;
const taskTimeoutMs = Math.max(rawTimeoutMs, 30_000);
if (taskTimeoutMs !== rawTimeoutMs) {
  console.warn(`TASK_TIMEOUT_SECONDS too low (${rawTimeoutMs / 1000}s) — clamped to 30s minimum.`);
}
const rawApiPort = Number(process.env.WA_API_PORT) || 8477;
const apiPort = Number.isInteger(rawApiPort) && rawApiPort >= 1 && rawApiPort <= 65535 ? rawApiPort : 8477;
if (apiPort !== rawApiPort) {
  console.warn(`WA_API_PORT out of range (${rawApiPort}) — falling back to 8477.`);
}

// Cap for the passive incoming-media store (Feature 3). Incoming WhatsApp media
// is already <=16 MB, so a higher value simply imposes no extra limit; a lower
// one skips storing anything bigger (the message keeps its plain placeholder).
const rawMediaMaxMb = Number(process.env.MEDIA_MAX_MB);
const mediaMaxMb = Number.isFinite(rawMediaMaxMb) && rawMediaMaxMb >= 1 ? rawMediaMaxMb : 16;
if (process.env.MEDIA_MAX_MB && mediaMaxMb !== rawMediaMaxMb) {
  console.warn(`MEDIA_MAX_MB invalid (${process.env.MEDIA_MAX_MB}) — using 16 MB.`);
}

// Default agent CLI + model routing. Each provider reads its OWN model env so
// codex never gets handed claude's model string (the root-cause bug: one shared
// MODEL was passed to every provider). Legacy MODEL applies to the default
// provider only, preserving its old meaning.
const defaultProvider = process.env.PROVIDER?.trim().toLowerCase() || "claude";
const legacyModel = process.env.MODEL?.trim() || "";
const perProviderModel: Record<string, string> = {
  claude: process.env.CLAUDE_MODEL?.trim() || "",
  codex: process.env.CODEX_MODEL?.trim() || "",
  gemini: process.env.GEMINI_MODEL?.trim() || "",
  grok: process.env.GROK_MODEL?.trim() || "",
};
const mentionTriggers = parseMentionTriggers(
  process.env.MENTION_TRIGGERS,
  process.env.MENTION_TRIGGER?.trim() || "@computer",
  defaultProvider,
);
const configuredBotPrefixes = (process.env.BOT_REPLY_PREFIXES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const protectedBotPrefixes = botReplyPrefixes([
  ...configuredBotPrefixes,
  ...mentionTriggers.map((route) => `${agentReplyLabel(route.trigger, route.provider)}:`),
  ...[...KNOWN_PROVIDERS].map((provider) => `${agentReplyLabel(undefined, provider)}:`),
]);

export const config = {
  /** Directory Claude Code operates in. */
  workdir: process.env.WORKDIR?.trim() || repoRoot,

  /** Optional prefix that must lead a message for it to count as a task. */
  commandPrefix: process.env.COMMAND_PREFIX?.trim() || "",

  /** Which agent CLI to drive: claude | codex | gemini | grok. */
  provider: defaultProvider,

  /**
   * Model to pass to a given provider (undefined = omit the flag, provider
   * default). Backed by per-provider envs CLAUDE_MODEL / CODEX_MODEL /
   * GEMINI_MODEL / GROK_MODEL; the legacy MODEL env applies to the default
   * provider only. Replaces the old single `config.model`, which was passed to
   * every provider and made e.g. codex run `-m claude-...` and error.
   */
  modelFor(provider: string): string | undefined {
    const specific = perProviderModel[provider];
    if (specific) return specific;
    if (provider === defaultProvider && legacyModel) return legacyModel;
    return undefined;
  },

  /** Hard timeout per task in milliseconds (clamped to >= 30s above). */
  taskTimeoutMs,

  /** Auto-open the QR image in the OS viewer while linking. */
  qrAutoOpen: (process.env.QR_AUTO_OPEN ?? "true").toLowerCase() !== "false",

  /** On connect, find-or-create a dedicated WhatsApp group as command channel. */
  createGroup: (process.env.CREATE_GROUP ?? "true").toLowerCase() !== "false",

  /** Name of that group. */
  groupName: process.env.GROUP_NAME?.trim() || "Claude Chat",

  /** Where Baileys persists the WhatsApp session. */
  authDir: resolve(repoRoot, "auth"),

  /**
   * Baileys socket log level (pino). Default silent; set WA_LOG_LEVEL=info or
   * debug to see the protocol layer — retry receipts, session establishment,
   * decrypt failures — when diagnosing delivery problems.
   */
  waLogLevel: process.env.WA_LOG_LEVEL?.trim() || "silent",

  /**
   * Anywhere-in-WhatsApp trigger. Deliberately separate from the dedicated
   * group's hard lock: when YOU (fromMe only — never other participants)
   * write this word in ANY chat, the bridge reads recent conversation there
   * and replies in that same chat, with full Claude Code power in `workdir`.
   */
  mentionEnabled: (process.env.ENABLE_MENTION_TRIGGER ?? "true").toLowerCase() !== "false",
  mentionTrigger: process.env.MENTION_TRIGGER?.trim() || "@computer",

  /**
   * Per-trigger provider routing: each `{ trigger, provider }` fires that
   * provider in ANY chat (fromMe only). Parsed from MENTION_TRIGGERS; when
   * unset, a single legacy entry (mentionTrigger -> default provider) is used.
   */
  mentionTriggers,

  /**
   * Visible prefixes emitted by local automation. fromMe is shared by every
   * linked device/app, so a prefix is required to distinguish bot output from
   * something the human typed. Core prefixes are always retained; the env
   * value adds site-specific bots.
   */
  botReplyPrefixes: protectedBotPrefixes,

  /**
   * Passively download + keep incoming media (any chat, any direction) instead
   * of reducing it to a `[image: name.jpg]` placeholder. MEDIA_MAX_MB caps the
   * stored size. See src/store.ts (media dir) and persistMessage in index.ts.
   */
  mediaStore: (process.env.MEDIA_STORE ?? "true").toLowerCase() !== "false",
  mediaMaxBytes: Math.round(mediaMaxMb * 1024 * 1024),

  /**
   * Local control API (src/api.ts). Loopback-only HTTP server that lets
   * local Claude sessions send messages/files and read stored history.
   * Disabled unless WA_API_TOKEN is set.
   */
  apiPort,
  apiToken: process.env.WA_API_TOKEN?.trim() || "",
};

/**
 * All groups the bridge monitors. The first is the primary "Claude Chat" group
 * (owner-only, your main workdir) — unchanged behaviour. The rest come from
 * EXTRA_GROUPS and may have their own workdir + an allowlist of participants.
 */
export const monitoredGroupConfigs: GroupConfig[] = [
  {
    name: config.groupName,
    workdir: config.workdir,
    allowedJids: parseJids(process.env.ALLOWED_JIDS),
    participants: [],
  },
  ...parseExtraGroups(process.env.EXTRA_GROUPS),
];
