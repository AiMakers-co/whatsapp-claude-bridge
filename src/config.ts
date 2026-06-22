import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  /** Directory Claude Code operates in. */
  workdir: process.env.WORKDIR?.trim() || repoRoot,

  /** Explicit allowlist of JIDs. Empty => note-to-self only. */
  allowedJids: parseList(process.env.ALLOWED_JIDS),

  /** Optional prefix that must lead a message for it to count as a task. */
  commandPrefix: process.env.COMMAND_PREFIX?.trim() || "",

  /** Optional model override for `claude --model`. */
  model: process.env.CLAUDE_MODEL?.trim() || "",

  /** Hard timeout per task in milliseconds. */
  taskTimeoutMs:
    (Number(process.env.TASK_TIMEOUT_SECONDS) || 600) * 1000,

  /** Auto-open the QR image in the OS viewer while linking. */
  qrAutoOpen: (process.env.QR_AUTO_OPEN ?? "true").toLowerCase() !== "false",

  /** On connect, find-or-create a dedicated WhatsApp group as command channel. */
  createGroup: (process.env.CREATE_GROUP ?? "true").toLowerCase() !== "false",

  /** Name of that group. */
  groupName: process.env.GROUP_NAME?.trim() || "Claude Chat",

  /** Where Baileys persists the WhatsApp session. */
  authDir: resolve(repoRoot, "auth"),
};
