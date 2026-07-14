import "./helpers/test-home.js"; // must precede any src/config.js importer
import assert from "node:assert/strict";
import test from "node:test";

import { ProgressReporter } from "../src/progress.js";
import { ephemeralSendBlocked } from "../src/outbound.js";
import type { ProgressEvent } from "../src/providers.js";

const tool = (summary: string): ProgressEvent => ({ kind: "tool", summary });

/**
 * A minimal single-timer fake clock. ProgressReporter only ever arms one timer
 * at a time, so we track just the latest pending callback and fire it on demand
 * (simulating `intervalMs` elapsing).
 */
function makeClock() {
  let pending: { id: number; fn: () => void } | undefined;
  let seq = 0;
  return {
    timers: {
      setTimeout(fn: () => void): number {
        pending = { id: ++seq, fn };
        return pending.id;
      },
      clearTimeout(id: number): void {
        if (pending?.id === id) pending = undefined;
      },
    },
    hasPending(): boolean {
      return pending !== undefined;
    },
    fire(): void {
      const p = pending;
      pending = undefined;
      p?.fn();
    },
  };
}

test("first push arms a timer but does not send; fire flushes the coalesced trail", () => {
  const sends: string[] = [];
  const clock = makeClock();
  const r = new ProgressReporter(async (t) => void sends.push(t), 15_000, 8, clock.timers);

  r.push(tool("→ Read: a.ts"));
  assert.equal(sends.length, 0, "no immediate send on first push");
  assert.ok(clock.hasPending(), "first push armed a timer");

  r.push(tool("→ Read: a.ts")); // consecutive duplicate — deduped
  r.push(tool("→ Bash: ls"));

  clock.fire();
  assert.deepEqual(sends, ["⏳ → Read: a.ts · → Bash: ls"]);
});

test("trail keeps the last 6 summaries and reports overflow as (+N more)", () => {
  const sends: string[] = [];
  const clock = makeClock();
  const r = new ProgressReporter(async (t) => void sends.push(t), 15_000, 8, clock.timers);

  for (const s of ["a", "b", "c", "d", "e", "f", "g", "h"]) r.push(tool(s));
  clock.fire();

  assert.deepEqual(sends, ["⏳ c · d · e · f · g · h (+2 more)"]);
});

test("one send per interval under a push flood; goes silent after maxUpdates", () => {
  const sends: string[] = [];
  const clock = makeClock();
  const r = new ProgressReporter(async (t) => void sends.push(t), 15_000, 2, clock.timers);

  r.push(tool("x1"));
  clock.fire(); // update 1
  r.push(tool("x2"));
  clock.fire(); // update 2 (budget now spent)
  r.push(tool("x3"));
  assert.ok(!clock.hasPending(), "no further timer once maxUpdates is reached");
  clock.fire(); // no-op

  assert.deepEqual(sends, ["⏳ x1", "⏳ x2"]);
});

test("stop() cancels a pending flush — no send fires afterwards", () => {
  const sends: string[] = [];
  const clock = makeClock();
  const r = new ProgressReporter(async (t) => void sends.push(t), 15_000, 8, clock.timers);

  r.push(tool("x"));
  assert.ok(clock.hasPending());
  r.stop();
  assert.ok(!clock.hasPending(), "stop cleared the armed timer");
  clock.fire(); // nothing pending
  assert.equal(sends.length, 0);
});

test("intervalMs=0 is fully inert — push/stop arm nothing and send nothing", () => {
  const sends: string[] = [];
  const clock = makeClock();
  const r = new ProgressReporter(async (t) => void sends.push(t), 0, 8, clock.timers);

  r.push(tool("x"));
  assert.ok(!clock.hasPending(), "no timer armed when disabled");
  r.stop();
  clock.fire();
  assert.equal(sends.length, 0);
});

test("ephemeralSendBlocked truth table", () => {
  // Allowed only when connected, not logged out, and no durable sends queued.
  assert.equal(ephemeralSendBlocked(true, false, false), false);
  // Blocked when disconnected.
  assert.equal(ephemeralSendBlocked(false, false, false), true);
  // Blocked when logged out.
  assert.equal(ephemeralSendBlocked(true, true, false), true);
  // Blocked when this jid already has durable sends queued (per-jid FIFO).
  assert.equal(ephemeralSendBlocked(true, false, true), true);
});
