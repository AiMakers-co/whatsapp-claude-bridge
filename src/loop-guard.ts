export interface LoopDecision {
  allowed: boolean;
  /** True only for the event that first trips the pause. */
  tripped: boolean;
  pausedUntil?: number;
}

interface LoopState {
  hits: number[];
  pausedUntil: number;
}

/** Collapse the owner's phone/LID aliases while leaving every other JID raw. */
export function canonicalChatKeyFor(
  rawJid: string,
  normalizedJid: string,
  selfPhoneJid: string,
  selfLidJid: string,
): string {
  if (
    normalizedJid &&
    (normalizedJid === selfPhoneJid || normalizedJid === selfLidJid)
  ) {
    return selfPhoneJid || selfLidJid || normalizedJid;
  }
  return rawJid;
}

/**
 * Last-resort circuit breaker for fromMe mention bursts. Prefix/marker filters
 * should catch known bots first; this stops a new or misconfigured bot from
 * creating an unbounded loop.
 */
export class MentionLoopGuard {
  private readonly states = new Map<string, LoopState>();

  constructor(
    private readonly windowMs = 30_000,
    private readonly tripAt = 3,
    private readonly pauseMs = 2 * 60_000,
  ) {}

  record(chatId: string, now = Date.now()): LoopDecision {
    if (!this.states.has(chatId) && this.states.size >= 1_000) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest) this.states.delete(oldest);
    }
    const state = this.states.get(chatId) ?? { hits: [], pausedUntil: 0 };
    if (state.pausedUntil > now) {
      this.states.set(chatId, state);
      return { allowed: false, tripped: false, pausedUntil: state.pausedUntil };
    }

    if (state.pausedUntil) {
      state.hits = [];
      state.pausedUntil = 0;
    }
    state.hits = state.hits.filter((ts) => now - ts < this.windowMs);
    state.hits.push(now);

    if (state.hits.length >= this.tripAt) {
      state.hits = [];
      state.pausedUntil = now + this.pauseMs;
      this.states.set(chatId, state);
      return { allowed: false, tripped: true, pausedUntil: state.pausedUntil };
    }

    this.states.set(chatId, state);
    return { allowed: true, tripped: false };
  }
}
