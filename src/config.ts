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

/**
 * Blank (unset, or "" saved by the settings UI) defaults to 120 like the other
 * numerics — it must NOT silently become 0/disabled. Only an explicit "0"
 * disables sticky mode; other invalid values warn and fall back to 120.
 * Exported for tests (config's env is read only once, at module load).
 */
export function parseConversationMinutes(
  raw: string | undefined,
  warn: (message: string) => void = console.warn,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 120;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    warn(`CONVERSATION_MODE_MINUTES invalid (${trimmed}) — using 120.`);
    return 120;
  }
  const clamped = Math.min(n, 10_080);
  if (clamped !== n) {
    warn(`CONVERSATION_MODE_MINUTES too high (${n}) — clamped to 10080 (7 days).`);
  }
  return clamped;
}

const conversationMinutes = parseConversationMinutes(process.env.CONVERSATION_MODE_MINUTES);
const rawConversationQueueLimit = Number(process.env.CONVERSATION_QUEUE_LIMIT ?? 10);
const conversationQueueLimit =
  Number.isInteger(rawConversationQueueLimit) && rawConversationQueueLimit >= 1
    ? Math.min(rawConversationQueueLimit, 50)
    : 10;
if (conversationQueueLimit !== rawConversationQueueLimit) {
  console.warn(
    `CONVERSATION_QUEUE_LIMIT invalid (${process.env.CONVERSATION_QUEUE_LIMIT}) — using ${conversationQueueLimit}.`,
  );
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

// Progress rail (Step 3). PROGRESS_INTERVAL_SECONDS is the delay before the
// FIRST live-progress line; an explicit "0" disables progress streaming
// entirely (claude argv stays in json mode — the production kill switch),
// otherwise it clamps to 5–600s. Invalid values warn and fall back to 15s.
const rawProgressInterval = process.env.PROGRESS_INTERVAL_SECONDS?.trim();
let progressIntervalMs: number;
if (rawProgressInterval === "0") {
  progressIntervalMs = 0;
} else if (!rawProgressInterval) {
  progressIntervalMs = 15_000;
} else {
  const n = Number(rawProgressInterval);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`PROGRESS_INTERVAL_SECONDS invalid (${rawProgressInterval}) — using 15s.`);
    progressIntervalMs = 15_000;
  } else {
    const clamped = Math.min(Math.max(n, 5), 600);
    if (clamped !== n) {
      console.warn(`PROGRESS_INTERVAL_SECONDS out of range (${n}) — clamped to ${clamped}s.`);
    }
    progressIntervalMs = clamped * 1000;
  }
}

const rawProgressMaxUpdates = Number(process.env.PROGRESS_MAX_UPDATES ?? 8);
const progressMaxUpdates =
  Number.isInteger(rawProgressMaxUpdates) && rawProgressMaxUpdates >= 1
    ? Math.min(rawProgressMaxUpdates, 30)
    : 8;
if (process.env.PROGRESS_MAX_UPDATES && progressMaxUpdates !== rawProgressMaxUpdates) {
  console.warn(
    `PROGRESS_MAX_UPDATES invalid (${process.env.PROGRESS_MAX_UPDATES}) — using ${progressMaxUpdates}.`,
  );
}

// Dispatch-time acknowledgement ("🤖 On it…"). "0"/"false" turns it off.
const ackRaw = (process.env.ACK_ENABLED ?? "true").trim().toLowerCase();
const ackEnabled = ackRaw !== "false" && ackRaw !== "0";

// Background jobs (Step 5 — declared now, wired later). JOB_TIMEOUT_SECONDS
// floors at 60s; concurrency and queue depth clamp to sane ranges.
const rawJobTimeoutMs = (Number(process.env.JOB_TIMEOUT_SECONDS) || 3600) * 1000;
const jobTimeoutMs = Math.max(rawJobTimeoutMs, 60_000);
if (jobTimeoutMs !== rawJobTimeoutMs) {
  console.warn(`JOB_TIMEOUT_SECONDS too low (${rawJobTimeoutMs / 1000}s) — clamped to 60s minimum.`);
}

const rawMaxConcurrentJobs = Number(process.env.MAX_CONCURRENT_JOBS ?? 3);
const maxConcurrentJobs =
  Number.isInteger(rawMaxConcurrentJobs) && rawMaxConcurrentJobs >= 1
    ? Math.min(rawMaxConcurrentJobs, 10)
    : 3;
if (process.env.MAX_CONCURRENT_JOBS && maxConcurrentJobs !== rawMaxConcurrentJobs) {
  console.warn(
    `MAX_CONCURRENT_JOBS invalid (${process.env.MAX_CONCURRENT_JOBS}) — using ${maxConcurrentJobs}.`,
  );
}

const rawMaxQueuedJobs = Number(process.env.MAX_QUEUED_JOBS ?? 10);
const maxQueuedJobs =
  Number.isInteger(rawMaxQueuedJobs) && rawMaxQueuedJobs >= 1
    ? Math.min(rawMaxQueuedJobs, 50)
    : 10;
if (process.env.MAX_QUEUED_JOBS && maxQueuedJobs !== rawMaxQueuedJobs) {
  console.warn(
    `MAX_QUEUED_JOBS invalid (${process.env.MAX_QUEUED_JOBS}) — using ${maxQueuedJobs}.`,
  );
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

  /** Sliding sticky-conversation lifetime; 0 disables sticky mode. */
  conversationModeMs: conversationMinutes * 60_000,

  /** Maximum turns waiting behind one active task in a chat. */
  conversationQueueLimit,

  /**
   * Live-progress rail. progressIntervalMs is the delay before the first
   * "⏳ …" line (0 disables progress streaming entirely — claude stays in
   * json mode); progressMaxUpdates caps how many progress lines a turn emits.
   */
  progressIntervalMs,
  progressMaxUpdates,

  /** Dispatch-time "🤖 On it…" acknowledgement (ephemeral). */
  ackEnabled,

  /** Background job limits (wired in Step 5). */
  jobTimeoutMs,
  maxConcurrentJobs,
  maxQueuedJobs,

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
