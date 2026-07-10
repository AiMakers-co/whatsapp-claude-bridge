export interface MentionRoute {
  trigger: string;
  provider: string;
}

export interface MentionMatch extends MentionRoute {
  /** Character offset where the trigger itself begins. */
  idx: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find a configured provider trigger as a standalone token. */
export function matchMention(raw: string, routes: MentionRoute[]): MentionMatch | undefined {
  // Longest first so a shorter trigger cannot shadow an overlapping one.
  for (const route of [...routes].sort((a, b) => b.trigger.length - a.trigger.length)) {
    const re = new RegExp(
      `(^|\\s)${escapeRegex(route.trigger)}(?=\\s|$|[:,.!?](?:\\s|$))`,
      "i",
    );
    const match = re.exec(raw);
    if (match) {
      return {
        trigger: route.trigger,
        provider: route.provider,
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
