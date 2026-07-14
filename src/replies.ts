/**
 * Invisible Separator. Every bridge/API text frame carries this on the wire so
 * a linked-device echo can be identified even when WhatsApp rewrites its id.
 * It is deliberately invisible to recipients; stored history strips it.
 */
export const AUTOMATION_MARKER = "\u2063";

const CORE_BOT_PREFIXES = ["Nora:", "Computer:", "Codex:", "Bridge:"];

export function botReplyPrefixes(extra: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prefix of [...CORE_BOT_PREFIXES, ...extra]) {
    const clean = prefix.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function markAutomated(text: string): string {
  return text.startsWith(AUTOMATION_MARKER) ? text : AUTOMATION_MARKER + text;
}

export function hasAutomationMarker(text: string): boolean {
  return text.startsWith(AUTOMATION_MARKER);
}

export function stripAutomationMarker(text: string): string {
  return text.startsWith(AUTOMATION_MARKER) ? text.slice(AUTOMATION_MARKER.length) : text;
}

/** True for a visible reply label from this bridge or another local bot. */
export function hasBotReplyPrefix(text: string, prefixes: string[]): boolean {
  const clean = stripAutomationMarker(text)
    .trimStart()
    .replace(/^\(delayed\)\s*/i, "")
    .toLowerCase();
  return prefixes.some((prefix) => {
    const plain = prefix.toLowerCase();
    const name = plain.endsWith(":") ? plain.slice(0, -1) : plain;
    return clean.startsWith(plain) || clean.startsWith(`*${name}:*`);
  });
}

/**
 * Neutralize any configured call-sign trigger token embedded in free text
 * (a job note derived from user/agent-authored text) before it goes into a
 * bridge-composed notice. A notice is a fromMe frame; the loop-barrier rule is
 * "never interpolate a LIVE trigger token into a notice — labels only". We keep
 * the token visually intact but split it with the invisible AUTOMATION_MARKER
 * so another local automation's exact-string matcher can no longer fire on it.
 */
export function neutralizeTriggerTokens(text: string, triggers: readonly string[]): string {
  let out = text;
  for (const trig of triggers) {
    const token = (trig ?? "").trim();
    if (token.length < 2) continue; // nothing (or a single char) to split
    const re = new RegExp(
      `(^|\\s)(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\s|$|[:;,.!?])`,
      "gi",
    );
    out = out.replace(re, (_m, pre: string, tok: string) => `${pre}${tok[0]}${AUTOMATION_MARKER}${tok.slice(1)}`);
  }
  return out;
}

/** Human-readable label for the agent selected by a trigger/provider. */
export function agentReplyLabel(trigger: string | undefined, provider: string): string {
  if (trigger) {
    const cleaned = trigger.replace(/^@+/, "").replace(/[^a-z0-9_-]+/gi, "");
    if (cleaned) return cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude") return "Computer";
  if (normalized === "codex") return "Codex";
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Computer";
}

/** Add exactly one visible source label to a reply. */
export function prefixReply(label: string, text: string): string {
  const clean = stripAutomationMarker(text).trim();
  const prefix = `${label}:`;
  const lower = clean.toLowerCase();
  if (lower.startsWith(prefix.toLowerCase())) return clean;
  const boldPrefix = `*${label}:*`;
  if (lower.startsWith(boldPrefix.toLowerCase())) {
    return `${prefix}${clean.slice(boldPrefix.length)}`;
  }
  return clean ? `${prefix} ${clean}` : prefix;
}
