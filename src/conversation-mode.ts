import type { MentionRoute } from "./mentions.js";

export interface ActiveConversation {
  /** Stable call sign; provider/model are resolved from current config. */
  trigger: string;
  /** Sliding expiry in Unix milliseconds. */
  expiresAt: number;
  /** Optional history floor set by /new (Unix seconds). */
  contextSince?: number;
}

export type ConversationControl =
  | { kind: "chat"; rest: string }
  | { kind: "stop" }
  | { kind: "new" }
  | { kind: "status" }
  | { kind: "cd"; path: string }
  | { kind: "use"; provider: string };

export function parseConversationControl(text: string): ConversationControl | undefined {
  const trimmed = text.trim();
  // /cd and /use take a free-form argument (a path may contain spaces). They
  // are recognized here so a sticky conversation never ships them to the agent
  // as task text (F8) — the caller applies the same reset semantics as the
  // dedicated-group handlers.
  const cd = /^\/cd(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (cd) return { kind: "cd", path: (cd[1] ?? "").trim() };
  const use = /^\/use(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (use) return { kind: "use", provider: (use[1] ?? "").trim() };
  // Known verbs tolerate trailing text (R7): "/stop now", "/new please" and
  // "/status?" execute the verb (args ignored, matching the dedicated-group
  // path) instead of running as agent tasks in a sticky chat. The \b keeps
  // "/stopped" or "/chats" conversational; /chat keeps its <rest> semantics
  // (the rest becomes the first prompt of the activated conversation).
  const match = /^\/(chat|talk|stop|new|status)\b\s*([\s\S]*)$/i.exec(trimmed);
  if (!match) return undefined;
  const kind = match[1].toLowerCase();
  if (kind === "chat" || kind === "talk") {
    return { kind: "chat", rest: (match[2] ?? "").trim() };
  }
  return { kind: kind as "stop" | "new" | "status" };
}

export function startConversation(
  trigger: string,
  now: number,
  durationMs: number,
): ActiveConversation | undefined {
  if (!(durationMs > 0)) return undefined;
  return { trigger, expiresAt: now + durationMs };
}

/** Safe implicit-stickiness policy: self-chat or an already explicit mode. */
export function shouldRefreshConversation(
  explicitCallSign: boolean,
  selfChat: boolean,
  hasActiveConversation: boolean,
): boolean {
  return explicitCallSign
    ? selfChat || hasActiveConversation
    : hasActiveConversation;
}

/** The sticky-mode slice of a chat's state the stop/trip transitions touch. */
export interface StickyState {
  conversation?: ActiveConversation;
  /** Send-guard epoch: bumping it invalidates the running task's reply. */
  generation: number;
}

/**
 * User-issued /stop (full semantics): ends sticky mode AND bumps the
 * generation, so a task still running is deliberately suppressed — the user
 * explicitly asked everything to stop.
 */
export function applyUserStop(chat: StickyState): void {
  delete chat.conversation;
  chat.generation++;
}

/**
 * Loop-guard trip (F4): ends sticky mode but PRESERVES the generation — the
 * currently running turn passed admission legitimately and its finished reply
 * (and outbox files) must still deliver. Generation bumps are reserved for
 * explicit user resets (/new, /stop, /cd, /use).
 */
export function applyLoopTripHalt(chat: StickyState): void {
  delete chat.conversation;
}

export interface GroupCommand {
  cmd: string;
  arg: string;
  /** True when the command message also carried an attachment (never run). */
  droppedAttachment: boolean;
}

/**
 * Recognize a command-shaped dedicated-group message (F8). A leading '/'
 * ALWAYS makes the message a command — known or unknown — never an agent
 * task, even when it carries an attachment or an explicit call sign selected
 * the provider (both previously bypassed the command handler and executed
 * "/..." as a task).
 */
export function parseGroupCommand(body: string, hasAttachment: boolean): GroupCommand | undefined {
  if (!body.startsWith("/")) return undefined;
  const [cmd, ...rest] = body.slice(1).split(/\s+/);
  return {
    cmd: (cmd ?? "").toLowerCase(),
    arg: rest.join(" ").trim(),
    droppedAttachment: hasAttachment,
  };
}

export function resolveConversation(
  active: ActiveConversation | undefined,
  routes: MentionRoute[],
  now: number,
): { route?: MentionRoute; clear: boolean } {
  if (!active) return { clear: false };
  if (!Number.isFinite(active.expiresAt) || active.expiresAt <= now) {
    return { clear: true };
  }
  const route = routes.find(
    (candidate) => candidate.trigger.toLowerCase() === active.trigger.toLowerCase(),
  );
  return route ? { route, clear: false } : { clear: true };
}
