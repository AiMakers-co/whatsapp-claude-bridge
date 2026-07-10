export interface MentionRoute {
  trigger: string;
  provider: string;
  /** Per-call-sign model override. Undefined uses the provider default. */
  model?: string;
}

export interface MentionMatch extends MentionRoute {
  /** Character offset where the trigger itself begins. */
  idx: number;
}

export type MentionRouteParseResult =
  | { route: MentionRoute }
  | {
      error: "missing-provider" | "empty-trigger" | "unknown-provider";
      provider?: string;
    };

/**
 * Parse one `trigger:provider[:model]` route while retaining the legacy
 * `trigger:provider` form. Triggers may contain colons; model identifiers may
 * too. A known provider token separates the trigger from the optional model.
 */
export function parseMentionRouteEntry(
  entry: string,
  knownProviders: ReadonlySet<string>,
): MentionRouteParseResult {
  const raw = entry.trim();
  const parts = raw.split(":");
  if (parts.length < 2) return { error: "missing-provider" };

  const providerAt = (idx: number): string => parts[idx]?.trim().toLowerCase() ?? "";
  let providerIdx = -1;

  // Prefer the penultimate token when it is a provider: that is the explicit
  // trigger:provider:model form, including a model whose name matches another
  // provider. Otherwise preserve the old final-token provider parsing. A
  // right-to-left scan additionally permits model identifiers containing `:`.
  if (parts.length >= 3 && knownProviders.has(providerAt(parts.length - 2))) {
    providerIdx = parts.length - 2;
  } else if (knownProviders.has(providerAt(parts.length - 1))) {
    providerIdx = parts.length - 1;
  } else {
    for (let i = parts.length - 2; i >= 1; i--) {
      if (knownProviders.has(providerAt(i))) {
        providerIdx = i;
        break;
      }
    }
  }

  if (providerIdx < 0) {
    // For a three-field-looking entry, report the middle token as the likely
    // provider; for the legacy form, report the final token.
    const candidateIdx = parts.length >= 3 ? parts.length - 2 : parts.length - 1;
    const provider = providerAt(candidateIdx);
    return provider
      ? { error: "unknown-provider", provider }
      : { error: "missing-provider" };
  }

  const trigger = parts.slice(0, providerIdx).join(":").trim();
  if (!trigger) return { error: "empty-trigger" };
  const provider = providerAt(providerIdx);
  const model = parts.slice(providerIdx + 1).join(":").trim();
  return { route: { trigger, provider, ...(model ? { model } : {}) } };
}

/** Stable persisted session key for one call sign/provider identity. */
export function mentionSessionKey(route: Pick<MentionRoute, "trigger" | "provider">): string {
  const trigger = route.trigger.trim().replace(/\s+/g, " ").toLowerCase();
  const provider = route.provider.trim().toLowerCase();
  return `mention:${provider}:${trigger}`;
}

export interface ClaimedMentionSession {
  key: string;
  sessionId?: string;
  /** True when a pre-call-sign provider session was moved to this route. */
  migratedLegacy: boolean;
}

/** Read a call-sign session without consuming a live provider-default session. */
export function getMentionSession(
  sessions: Record<string, string>,
  route: Pick<MentionRoute, "trigger" | "provider">,
): ClaimedMentionSession {
  const key = mentionSessionKey(route);
  return {
    key,
    sessionId: sessions[key],
    migratedLegacy: false,
  };
}

/**
 * Select a call-sign session, atomically claiming an old provider-keyed
 * session on first use. Moving (rather than copying) the legacy id prevents a
 * second call sign for the same provider from accidentally sharing it.
 */
export function claimMentionSession(
  sessions: Record<string, string>,
  route: Pick<MentionRoute, "trigger" | "provider">,
): ClaimedMentionSession {
  const current = getMentionSession(sessions, route);
  if (current.sessionId) return current;

  const key = current.key;

  const legacyKey = route.provider.trim().toLowerCase();
  const legacy = sessions[legacyKey];
  if (!legacy) return { key, migratedLegacy: false };

  sessions[key] = legacy;
  delete sessions[legacyKey];
  return { key, sessionId: legacy, migratedLegacy: true };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find a configured provider trigger as a standalone token. */
export function matchMention(
  raw: string,
  routes: MentionRoute[],
  options: { leadingOnly?: boolean } = {},
): MentionMatch | undefined {
  // Longest first so a shorter trigger cannot shadow an overlapping one.
  for (const route of [...routes].sort((a, b) => b.trigger.length - a.trigger.length)) {
    const start = options.leadingOnly ? "^(\\s*)" : "(^|\\s)";
    const re = new RegExp(`${start}${escapeRegex(route.trigger)}(?=\\s|$|[:,.!?](?:\\s|$))`, "i");
    const match = re.exec(raw);
    if (match) {
      return {
        ...route,
        idx: match.index + match[1].length,
      };
    }
  }
  return undefined;
}

/**
 * Remove a matched provider selector without dropping the task text around it.
 * Used by dedicated groups, where the whole message remains the instruction.
 */
export function stripMentionToken(raw: string, match: MentionMatch): string {
  const before = raw.slice(0, match.idx).trimEnd();
  const after = raw
    .slice(match.idx + match.trigger.length)
    .replace(/^[:,.!?\s]+/, "")
    .trimStart();
  return [before, after].filter(Boolean).join(" ").trim();
}
