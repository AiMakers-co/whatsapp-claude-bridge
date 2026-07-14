import type { ProgressEvent } from "./providers.js";

/**
 * Coalesces streamed provider progress into at most a handful of ephemeral
 * WhatsApp lines. It is deliberately quiet on quick turns: the FIRST push arms
 * a timer for `intervalMs` rather than sending immediately, so a turn that
 * finishes inside the interval produces zero progress noise. On fire it sends
 * one "⏳ …" trail of the pending summaries and re-arms only when a later push
 * arrives; after `maxUpdates` sends it goes silent. `stop()` drops any pending
 * flush (the real reply is about to land). `intervalMs === 0` makes it inert.
 *
 * `send` is fire-and-forget; its errors are swallowed here (safeSend never
 * throws anyway). Timers are injectable so tests drive a fake clock.
 */
interface ReporterTimers {
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (handle: any) => void;
}

/** Most recent summaries kept in one trail; older ones collapse to "(+N more)". */
const MAX_TRAIL = 6;

export class ProgressReporter {
  private pending: string[] = [];
  private overflow = 0;
  private updates = 0;
  private timer: any;
  private stopped = false;

  constructor(
    private readonly send: (text: string) => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly maxUpdates: number,
    private readonly timers: ReporterTimers = globalThis,
  ) {}

  push(ev: ProgressEvent): void {
    if (this.intervalMs === 0 || this.stopped) return;
    if (this.updates >= this.maxUpdates) return; // budget spent — stay silent
    // Dedupe consecutive identical summaries (a run often repeats a tool line).
    if (this.pending[this.pending.length - 1] !== ev.summary) {
      this.pending.push(ev.summary);
      while (this.pending.length > MAX_TRAIL) {
        this.pending.shift();
        this.overflow++;
      }
    }
    if (!this.timer) {
      this.timer = this.timers.setTimeout(() => this.fire(), this.intervalMs);
      this.timer?.unref?.();
    }
  }

  private fire(): void {
    this.timer = undefined;
    if (this.stopped || this.pending.length === 0) return;
    if (this.updates >= this.maxUpdates) {
      this.pending = [];
      this.overflow = 0;
      return;
    }
    const trail = this.pending.join(" · ") + (this.overflow ? ` (+${this.overflow} more)` : "");
    this.updates++;
    this.pending = [];
    this.overflow = 0;
    try {
      const p = this.send("⏳ " + trail);
      if (p && typeof (p as any).catch === "function") (p as Promise<unknown>).catch(() => {});
    } catch {
      /* fire-and-forget: a broken send must never break the run */
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
    this.overflow = 0;
  }
}
