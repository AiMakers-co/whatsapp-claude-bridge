/**
 * Settings layer for the dashboard. Reads and writes the managed keys in the
 * bridge's `.env` (surgical line edits — comments and unmanaged keys are
 * preserved) and the per-workdir CLAUDE.md steering files, so the whole bridge
 * can be configured from the UI instead of hand-editing files.
 *
 * config.ts reads process.env once at startup, so a settings change needs a
 * process restart to take effect — the dashboard offers "Save & Restart",
 * which the Tauri supervisor turns into a clean respawn (reconnects from
 * auth/, no QR).
 *
 * WA_API_TOKEN and WA_API_PORT are deliberately NOT managed here: editing the
 * port or token of the very API you're talking to would sever the dashboard.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { config, monitoredGroupConfigs } from "./config.js";

const envPath = resolve(config.authDir, "..", ".env");

export type FieldType = "text" | "number" | "bool" | "select" | "textarea";

export interface SettingField {
  key: string;
  label: string;
  type: FieldType;
  group: string;
  help?: string;
  options?: string[];
  placeholder?: string;
}

/**
 * The managed keys, in display order, grouped into sections. `placeholder`
 * documents the effective default when the field is left blank (config.ts
 * applies these same defaults), so blank never means "broken".
 */
export const FIELDS: SettingField[] = [
  // ── General ──
  {
    key: "WORKDIR",
    label: "Working directory",
    type: "text",
    group: "General",
    help: "Absolute path Claude Code runs every task in. Must exist.",
    placeholder: "the bridge folder",
  },
  {
    key: "PROVIDER",
    label: "Agent CLI",
    type: "select",
    group: "General",
    options: ["claude", "codex", "gemini", "grok"],
    help: "Which coding agent the bridge drives.",
  },
  {
    key: "CLAUDE_MODEL",
    label: "Model override",
    type: "text",
    group: "General",
    help: "Passed to the provider. Blank = the provider's own default.",
    placeholder: "provider default",
  },
  {
    key: "TASK_TIMEOUT_SECONDS",
    label: "Task timeout (seconds)",
    type: "number",
    group: "General",
    help: "Hard limit per task before it is killed. Minimum 30.",
    placeholder: "600",
  },
  {
    key: "WA_LOG_LEVEL",
    label: "Protocol log level",
    type: "select",
    group: "General",
    options: ["silent", "error", "warn", "info", "debug", "trace"],
    help: "Baileys socket logging. Raise to debug delivery problems.",
  },
  // ── Command channel ──
  {
    key: "GROUP_NAME",
    label: "Command group name",
    type: "text",
    group: "Command channel",
    help: "The dedicated WhatsApp group the bridge listens in. Every message there is a task.",
    placeholder: "Claude Chat",
  },
  {
    key: "COMMAND_PREFIX",
    label: "Command prefix",
    type: "text",
    group: "Command channel",
    help: "If set, only messages starting with this word count as tasks. Blank = every message is a task.",
    placeholder: "none",
  },
  {
    key: "ALLOWED_JIDS",
    label: "Extra allowed senders",
    type: "text",
    group: "Command channel",
    help: "Comma-separated JIDs (besides you) allowed to run tasks in the group. e.g. 31612345678@s.whatsapp.net",
    placeholder: "you only",
  },
  {
    key: "CREATE_GROUP",
    label: "Auto-create the group",
    type: "bool",
    group: "Command channel",
    help: "Find-or-create the command group on connect.",
  },
  // ── Mention trigger ──
  {
    key: "ENABLE_MENTION_TRIGGER",
    label: "Enable mention trigger",
    type: "bool",
    group: "Mention trigger",
    help: "Lets you trigger the bridge from ANY chat by typing the trigger word — but only in messages you send yourself.",
  },
  {
    key: "MENTION_TRIGGER",
    label: "Trigger word",
    type: "text",
    group: "Mention trigger",
    help: "The word that fires a task in any chat (fromMe only).",
    placeholder: "@computer",
  },
  // ── Advanced ──
  {
    key: "EXTRA_GROUPS",
    label: "Extra monitored groups (JSON)",
    type: "textarea",
    group: "Advanced",
    help: 'JSON array of { "name", "workdir", "allowedJids"?, "participants"? }. Each becomes another command channel with its own project.',
    placeholder: "[]",
  },
];

const MANAGED_KEYS = new Set(FIELDS.map((f) => f.key));

/** Parse .env into a flat key→value map (comments/blank lines ignored). */
function readEnvRaw(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // Strip matching surrounding quotes (single = literal, double = unescape).
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Quote a value for .env only when it needs it (see writer notes in header). */
function formatEnvValue(val: string): string {
  if (val === "") return "";
  // JSON / anything with double quotes → single-quote (dotenv reads literally).
  if (val.includes('"') && !val.includes("'")) return `'${val}'`;
  // Spaces, comment chars or quotes → double-quote and escape.
  if (/[\s#'"]/.test(val)) {
    return '"' + val.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return val;
}

/** Surgically upsert managed keys into .env, preserving everything else. */
function writeEnv(updates: Record<string, string>): void {
  let raw = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const formatted = `${key}=${formatEnvValue(value)}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(raw)) {
      raw = raw.replace(re, formatted);
    } else {
      if (raw && !raw.endsWith("\n")) raw += "\n";
      raw += formatted + "\n";
    }
  }
  const tmp = envPath + ".tmp";
  writeFileSync(tmp, raw, { mode: 0o600 });
  renameSync(tmp, envPath);
  try {
    chmodSync(envPath, 0o600); // holds WA_API_TOKEN — keep it owner-only
  } catch {
    /* best effort */
  }
}

/** Distinct workdirs the bridge knows about, for the CLAUDE.md editor. */
export function knownWorkdirs(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [config.workdir, ...monitoredGroupConfigs.map((g) => g.workdir)]) {
    if (w && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** Payload for GET /config: field defs + current raw values + workdir list. */
export function getConfigPayload() {
  const raw = readEnvRaw();
  const values: Record<string, string> = {};
  for (const k of MANAGED_KEYS) values[k] = raw[k] ?? "";
  return { fields: FIELDS, values, workdirs: knownWorkdirs() };
}

/** Validate one submitted map. Returns per-key errors ({} = all clear). */
function validate(updates: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const get = (k: string) => (updates[k] ?? "").trim();

  const workdir = get("WORKDIR");
  if (workdir) {
    let ok = false;
    try {
      ok = statSync(workdir).isDirectory();
    } catch {
      /* missing */
    }
    if (!ok) errors.WORKDIR = "Not an existing directory.";
  }

  const provider = get("PROVIDER").toLowerCase();
  if (provider && !["claude", "codex", "gemini", "grok"].includes(provider)) {
    errors.PROVIDER = "Must be claude, codex, gemini or grok.";
  }

  const timeout = get("TASK_TIMEOUT_SECONDS");
  if (timeout && !(Number(timeout) > 0)) {
    errors.TASK_TIMEOUT_SECONDS = "Must be a positive number.";
  }

  const level = get("WA_LOG_LEVEL").toLowerCase();
  if (level && !["silent", "error", "warn", "info", "debug", "trace"].includes(level)) {
    errors.WA_LOG_LEVEL = "Invalid log level.";
  }

  const jids = get("ALLOWED_JIDS");
  if (jids && jids.split(",").some((j) => j.trim() && !j.includes("@"))) {
    errors.ALLOWED_JIDS = "Each entry must be a full JID (contains @).";
  }

  const extra = get("EXTRA_GROUPS");
  if (extra) {
    if (extra.includes("'")) {
      errors.EXTRA_GROUPS = "Single quotes aren't supported here — use double quotes only.";
    } else {
      try {
        const arr = JSON.parse(extra);
        if (!Array.isArray(arr)) {
          errors.EXTRA_GROUPS = "Must be a JSON array.";
        } else if (
          !arr.every(
            (g: any) => g && typeof g.name === "string" && typeof g.workdir === "string",
          )
        ) {
          errors.EXTRA_GROUPS = "Every entry needs a name and a workdir.";
        }
      } catch (e: any) {
        errors.EXTRA_GROUPS = "Invalid JSON: " + (e?.message ?? e);
      }
    }
  }

  return errors;
}

export interface SaveResult {
  ok: boolean;
  errors?: Record<string, string>;
}

/** Validate + persist a submitted settings map. Only managed keys are written. */
export function saveConfig(input: Record<string, unknown>): SaveResult {
  const updates: Record<string, string> = {};
  for (const k of MANAGED_KEYS) {
    if (k in input) {
      const v = input[k];
      updates[k] = v == null ? "" : String(v);
    }
  }
  const errors = validate(updates);
  if (Object.keys(errors).length) return { ok: false, errors };
  // Normalise the EXTRA_GROUPS JSON to a compact single line before storing.
  if (updates.EXTRA_GROUPS && updates.EXTRA_GROUPS.trim()) {
    try {
      updates.EXTRA_GROUPS = JSON.stringify(JSON.parse(updates.EXTRA_GROUPS));
    } catch {
      /* validate() already guarded this */
    }
  }
  writeEnv(updates);
  return { ok: true };
}

// ── CLAUDE.md steering files (per workdir) ──────────────────────────────────

/** A path is editable only if it's one of the workdirs the bridge monitors. */
function claudeMdPathFor(workdir: string): string | undefined {
  const w = (workdir || "").trim();
  if (!w) return undefined;
  if (!knownWorkdirs().includes(w)) return undefined;
  return join(w, "CLAUDE.md");
}

export function readClaudeMd(workdir: string): { ok: boolean; path?: string; content?: string; error?: string } {
  const path = claudeMdPathFor(workdir);
  if (!path) return { ok: false, error: "unknown workdir" };
  let content = "";
  try {
    if (existsSync(path)) content = readFileSync(path, "utf8");
  } catch (e: any) {
    return { ok: false, path, error: e?.message ?? String(e) };
  }
  return { ok: true, path, content };
}

export function writeClaudeMd(workdir: string, content: string): { ok: boolean; path?: string; error?: string } {
  const path = claudeMdPathFor(workdir);
  if (!path) return { ok: false, error: "unknown workdir" };
  try {
    const tmp = path + ".tmp";
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e: any) {
    return { ok: false, path, error: e?.message ?? String(e) };
  }
  return { ok: true, path };
}
