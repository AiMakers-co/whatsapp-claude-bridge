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

  /** Where Baileys persists the WhatsApp session. */
  authDir: resolve(repoRoot, "auth"),
};
