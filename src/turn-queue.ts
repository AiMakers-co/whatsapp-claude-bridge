interface QueuedTurn {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface QueueState {
  running: boolean;
  turns: QueuedTurn[];
}

export interface AcceptedTurn {
  accepted: true;
  /** Number of turns ahead of this one (0 means it starts immediately). */
  position: number;
  done: Promise<void>;
}

/** Which bound rejected a turn: this chat's FIFO, or the global cap. */
export type QueueLimit = "chat" | "global";

export interface RejectedTurn {
  accepted: false;
  position: number;
  /** Which limit tripped, so the caller can explain WHICH cap was hit. */
  limit: QueueLimit;
}

export type EnqueuedTurn = AcceptedTurn | RejectedTurn;

/** canAccept result: ok, or which bound would reject the next turn. */
export type AcceptDecision = { ok: true } | { ok: false; limit: QueueLimit };

/**
 * Small per-key FIFO for WhatsApp turns. Jobs for different chats may run in
 * parallel; jobs for one chat run strictly in arrival order. A failed job
 * rejects only its own promise and never poisons the rest of the queue.
 */
export class KeyedTurnQueue {
  private readonly queues = new Map<string, QueueState>();

  constructor(
    private readonly maxWaiting = 10,
    private readonly maxTotalWaiting = 100,
  ) {
    if (
      !Number.isInteger(maxWaiting) ||
      maxWaiting < 1 ||
      !Number.isInteger(maxTotalWaiting) ||
      maxTotalWaiting < 1
    ) {
      throw new Error("queue limits must be positive integers");
    }
  }

  canAccept(key: string): AcceptDecision {
    const state = this.queues.get(key);
    if (!state?.running) return { ok: true };
    // Per-chat FIFO cap is reported before the global cap so the user-facing
    // message names the limit they actually hit.
    if (state.turns.length >= this.maxWaiting) return { ok: false, limit: "chat" };
    if (this.totalWaiting() >= this.maxTotalWaiting) return { ok: false, limit: "global" };
    return { ok: true };
  }

  enqueue(
    key: string,
    run: () => Promise<void>,
    options: { bypassLimit?: boolean } = {},
  ): EnqueuedTurn {
    const state = this.queues.get(key) ?? { running: false, turns: [] };
    if (!this.queues.has(key)) this.queues.set(key, state);

    const position = (state.running ? 1 : 0) + state.turns.length;
    if (!options.bypassLimit && state.running) {
      if (state.turns.length >= this.maxWaiting) {
        return { accepted: false, position, limit: "chat" };
      }
      if (this.totalWaiting() >= this.maxTotalWaiting) {
        return { accepted: false, position, limit: "global" };
      }
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    state.turns.push({ run, resolve, reject });
    this.pump(key, state);
    return { accepted: true, position, done };
  }

  waiting(key: string): number {
    return this.queues.get(key)?.turns.length ?? 0;
  }

  totalWaiting(): number {
    let total = 0;
    for (const state of this.queues.values()) total += state.turns.length;
    return total;
  }

  active(): number {
    let total = 0;
    for (const state of this.queues.values()) if (state.running) total++;
    return total;
  }

  activeFor(key: string): number {
    return this.queues.get(key)?.running ? 1 : 0;
  }

  /** Live snapshot of every queue whose key matches (for per-lane /status). */
  lanesMatching(
    matches: (key: string) => boolean,
  ): Array<{ key: string; running: boolean; waiting: number }> {
    const out: Array<{ key: string; running: boolean; waiting: number }> = [];
    for (const [key, state] of this.queues) {
      if (matches(key)) out.push({ key, running: state.running, waiting: state.turns.length });
    }
    return out;
  }

  /** Cancel turns that have not started; the active turn is left alone. */
  cancelWaiting(key: string): number {
    const state = this.queues.get(key);
    if (!state) return 0;
    const cancelled = state.turns.splice(0);
    for (const turn of cancelled) turn.resolve();
    if (!state.running) this.queues.delete(key);
    return cancelled.length;
  }

  /**
   * Cancel waiting turns in EVERY queue whose key matches (active turns are
   * left alone). Chat-wide cancels use this now that keys are per-agent lanes.
   */
  cancelWaitingMatching(matches: (key: string) => boolean): number {
    let total = 0;
    for (const key of [...this.queues.keys()]) {
      if (matches(key)) total += this.cancelWaiting(key);
    }
    return total;
  }

  private pump(key: string, state: QueueState): void {
    if (state.running) return;
    const next = state.turns.shift();
    if (!next) {
      this.queues.delete(key);
      return;
    }
    state.running = true;
    void next
      .run()
      .then(next.resolve, next.reject)
      .finally(() => {
        state.running = false;
        this.pump(key, state);
      });
  }
}
