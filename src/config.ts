import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

export const config = {
  /** Directory Claude Code operates in. */
  workdir: process.env.WORKDIR?.trim() || repoRoot,

  /** Optional prefix that must lead a message for it to count as a task. */
  commandPrefix: process.env.COMMAND_PREFIX?.trim() || "",

  /** Which agent CLI to drive: claude | codex | gemini | grok. */
  provider: process.env.PROVIDER?.trim().toLowerCase() || "claude",

  /** Optional model override passed to the selected provider. */
  model: process.env.MODEL?.trim() || process.env.CLAUDE_MODEL?.trim() || "",

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
