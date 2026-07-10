import type { GroupConfig } from "./config.js";
import type { MentionRoute } from "./mentions.js";

/**
 * Journal-recovery admission policy (F1/F5). Recovered turns passed admission
 * before the crash, but replay must re-validate against the LIVE runtime
 * config — a group removed from monitoring, a de-authorised sender, a deleted
 * call sign, disabled mentions, or a user reset (/new, /stop, /cd, /use whose
 * generation bump was persisted synchronously) all mean the turn is DROPPED,
 * never replayed under stale persisted rules.
 *
 * Pure decision functions so the policy is unit-testable outside the socket.
 */

export type RecoveredMentionVerdict =
  | { ok: true; route: MentionRoute }
  | { ok: false; reason: string };

export type RecoveredGroupVerdict =
  | { ok: true; cfg: GroupConfig }
  | { ok: false; reason: string };

export type RecoveredGenerationVerdict = { ok: true } | { ok: false; reason: string };

/**
 * F5: a stored generation that no longer matches the chat's current one means
 * the turn was cancelled by an explicit reset before the crash. Rows from a
 * pre-upgrade journal (no stored generation) are allowed through.
 */
export function generationStillValid(
  storedGeneration: unknown,
  currentGeneration: number,
): RecoveredGenerationVerdict {
  if (typeof storedGeneration !== "number") return { ok: true };
  if (storedGeneration === currentGeneration) return { ok: true };
  return {
    ok: false,
    reason: `stored generation ${storedGeneration} != current ${currentGeneration} (superseded by a reset)`,
  };
}

/**
 * F1 (mention turns): replay requires mentions to still be enabled AND the
 * call sign to still be routed. The LIVE route (current provider/model) is
 * returned for the replay; the persisted route is only a label.
 */
export function resolveRecoveredMentionRoute(
  trigger: string,
  mentionEnabled: boolean,
  routes: MentionRoute[],
): RecoveredMentionVerdict {
  if (!mentionEnabled) {
    return { ok: false, reason: "mention triggers are disabled in live config" };
  }
  const route = routes.find(
    (candidate) => candidate.trigger.toLowerCase() === trigger.toLowerCase(),
  );
  if (!route) {
    return { ok: false, reason: `call sign "${trigger}" is no longer configured` };
  }
  return { ok: true, route };
}

/**
 * F1 (group turns): replay requires the group to still be monitored (resolved
 * in the LIVE map) and the sender to still be authorised under the LIVE
 * allowlist. fromMe is preserved in the journaled message, so the fromMe gate
 * holds identically on replay. The LIVE config (workdir etc.) is returned; the
 * persisted copy is only a fallback label for logging.
 */
export function validateRecoveredGroupTurn(
  liveCfg: GroupConfig | undefined,
  fromMe: boolean,
  senderJid: string,
  persistedName?: string,
): RecoveredGroupVerdict {
  if (!liveCfg) {
    return {
      ok: false,
      reason: `group ("${persistedName ?? "unknown"}") is no longer monitored`,
    };
  }
  if (!fromMe && !liveCfg.allowedJids.includes(senderJid)) {
    return {
      ok: false,
      reason: `sender ${senderJid} is no longer authorised in "${liveCfg.name}"`,
    };
  }
  return { ok: true, cfg: liveCfg };
}

/**
 * R2/R1: bootstrap-only seeding of the live group map before journal recovery.
 * ensureGroups needs a live socket fetch and may not have run yet at recovery
 * time, so recovered group turns are validated against the persisted name->jid
 * pins of the CURRENTLY configured groups. Gated on createGroup exactly like
 * ensureGroups (R2) — with the feature off, stale pins must not resurrect
 * group monitoring. Seeded entries are provisional: ensureGroups must still
 * verify every pin against the live fetch and re-resolve dead ones (R1).
 */
export function seedRecoveryGroupPins(
  createGroup: boolean,
  configs: GroupConfig[],
  persistedPins: Record<string, string>,
  resolvedJids: ReadonlySet<string>,
): Array<{ jid: string; cfg: GroupConfig }> {
  if (!createGroup) return [];
  const out: Array<{ jid: string; cfg: GroupConfig }> = [];
  for (const cfg of configs) {
    const jid = persistedPins[cfg.name];
    if (jid && !resolvedJids.has(jid)) out.push({ jid, cfg });
  }
  return out;
}

/**
 * R1: the configs group setup may SKIP re-resolving. Only VERIFIED
 * resolutions count — entries seeded from persisted pins for recovery are
 * excluded, so ensureGroups still checks every pinned jid against the live
 * groupFetchAllParticipating result and replaces dead pins (a WhatsApp group
 * deleted while the bridge was down must fall through to subject match /
 * re-creation exactly as before, not stay monitored as a dead jid forever).
 */
export function verifiedResolvedConfigs(
  entries: Iterable<[string, GroupConfig]>,
  seededJids: ReadonlySet<string>,
): Set<GroupConfig> {
  const out = new Set<GroupConfig>();
  for (const [jid, cfg] of entries) {
    if (!seededJids.has(jid)) out.add(cfg);
  }
  return out;
}

/**
 * R3: source ids of the PENDING journal rows a cancellation covers.
 * Cancellation marks these processed SYNCHRONOUSLY (the id list has a sync
 * write path) before the async journal cancel — a crash before that write
 * lands must not let recovery replay turns the trip/stop notice already
 * claimed were cleared. Predicate-based (D1): a chat-wide cancel matches
 * every lane of the chat, a lane-scoped one exactly one lane.
 */
export function pendingSourceIds<
  T extends { status: string; sourceMessageId?: string },
>(turns: ReadonlyArray<T>, matches: (turn: T) => boolean): string[] {
  return turns
    .filter(
      (turn) =>
        turn.status === "pending" &&
        matches(turn) &&
        Boolean(turn.sourceMessageId),
    )
    .map((turn) => turn.sourceMessageId!);
}

/**
 * R3: a journal row whose source id is already durably processed was either
 * cancelled (trip//stop pre-marked it synchronously) or fully completed with
 * only its journal finish-write lost — never replay it, just clear the row.
 * (Admission no longer pre-marks source ids; a normally-admitted pending turn
 * is unprocessed until it finishes, so this check cannot skip legitimate
 * replays.)
 */
export function turnAlreadyHandled(
  sourceMessageId: string | undefined,
  processedIds: ReadonlySet<string>,
): boolean {
  return Boolean(sourceMessageId) && processedIds.has(sourceMessageId!);
}
