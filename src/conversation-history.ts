export interface ConversationHistoryEntry {
  /** WhatsApp message id; used to freeze same-second queue snapshots safely. */
  id?: string;
  label: string;
  text: string;
  ts: number;
}

export interface TranscriptOptions {
  sinceTs?: number;
  upToTs?: number;
  entryLimit?: number;
  characterLimit?: number;
  /** IDs that existed when the turn was accepted, for entries at `upToTs`. */
  allowedIdsAtCutoff?: ReadonlySet<string>;
}

/** Add a usable local attachment reference without duplicating an existing one. */
export function withMediaReference(
  text: string,
  mediaPath?: string,
  mediaType = "file",
): string {
  if (!mediaPath || text.includes(mediaPath)) return text;
  return `${text}${text ? "\n" : ""}[Attached ${mediaType} available at: ${mediaPath}]`;
}

function usable(
  entry: ConversationHistoryEntry,
  sinceTs: number,
  upToTs?: number,
  allowedIdsAtCutoff?: ReadonlySet<string>,
): boolean {
  return Boolean(
    entry.text.trim() &&
      entry.ts >= sinceTs &&
      (upToTs === undefined || entry.ts <= upToTs) &&
      (upToTs === undefined ||
        entry.ts !== upToTs ||
        !allowedIdsAtCutoff ||
        (Boolean(entry.id) && allowedIdsAtCutoff.has(entry.id!))) &&
      entry.label.toLowerCase() !== "bridge" &&
      !/^bridge:\s/i.test(entry.text.trimStart()),
  );
}

/**
 * R5: every chunk id carried by the replies being INJECTED into a transcript.
 * The caller excludes stored rows with these ids so the injected FULL reply
 * text wins and no partial chunk subset can survive a cutoff; replies that
 * are not injected keep using their stored chunk rows.
 */
export function injectedChunkIds(
  replies: Array<{ ids?: readonly string[] }>,
): Set<string> {
  return new Set(replies.flatMap((reply) => [...(reply.ids ?? [])]));
}

/** Collapse whitespace + strip the queue-flush "(delayed)" marker for R4 dedupe. */
function normalizedDedupeText(text: string): string {
  return text
    .replace(/^\(delayed\)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge stored/live history with agent replies completed after a turn was
 * queued. Bounded entries obey the enqueue cutoff; completed replies may be
 * newer because turn N+1 must see turn N's result before it runs.
 */
export function buildConversationTranscript(
  boundedEntries: ConversationHistoryEntry[],
  completedReplies: ConversationHistoryEntry[] = [],
  options: TranscriptOptions = {},
): string {
  const sinceTs = options.sinceTs ?? Number.NEGATIVE_INFINITY;
  const upToTs = options.upToTs ?? Number.POSITIVE_INFINITY;
  const entryLimit = options.entryLimit ?? 30;
  const characterLimit = options.characterLimit ?? 12_000;
  const allowedIdsAtCutoff = options.allowedIdsAtCutoff;
  const seen = new Set<string>();
  const merged = [
    ...boundedEntries.filter((entry) =>
      usable(entry, sinceTs, upToTs, allowedIdsAtCutoff),
    ),
    ...completedReplies.filter((entry) => usable(entry, sinceTs)),
  ].sort((a, b) => a.ts - b.ts);
  // R4: an offline-queued reply is buffered id-less as a fallback until its
  // pending-send flush creates the id-bearing store row. Once both exist the
  // id-less copy is redundant — drop an id-less entry whenever an id-bearing
  // entry with the same label and normalized text is present.
  const idBearingKeys = new Set(
    merged
      .filter((entry) => entry.id)
      .map((entry) => `${entry.label}\u0000${normalizedDedupeText(entry.text)}`),
  );
  const history = merged
    .filter((entry) => {
      if (
        !entry.id &&
        idBearingKeys.has(`${entry.label}\u0000${normalizedDedupeText(entry.text)}`)
      ) {
        return false;
      }
      const key = entry.id
        ? `id\u0000${entry.id}`
        : `${entry.ts}\u0000${entry.label}\u0000${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-Math.max(1, entryLimit));

  const lines = history.map((entry) => {
    const date = new Date(entry.ts * 1000);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `[${hh}:${mm}] ${entry.label}: ${entry.text}`;
  });
  const selected: string[] = [];
  let remaining = Math.max(1, characterLimit);
  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    const separator = selected.length ? 1 : 0;
    const line = lines[i].slice(0, Math.max(0, remaining - separator));
    if (!line) break;
    selected.push(line);
    remaining -= line.length + separator;
  }
  return selected.reverse().join("\n");
}
